/**
 * The agent link's MCP server (DECISIONS D30): Streamable HTTP on loopback,
 * JSON responses only, stateless (no `Mcp-Session-Id`, no SSE stream). Each
 * Kiro session gets its own bearer token ({@link AgentLinkGrant}), so every
 * request names the session that sent it.
 *
 * Only kiro-cli on this machine is meant to reach it, and only with a token it
 * was handed in `session/new` / `session/load`. Everything else is refused
 * before the body is read: a foreign `Host` (DNS rebinding), any `Origin`
 * (browsers; kiro-cli sends none) and a missing or unknown token. Refusals are
 * `403`, never `401`: a `401` can make an MCP client start an OAuth discovery.
 *
 * JSON-RPC dispatch lives in `protocol.ts`; this file owns sockets, tokens and
 * the caller of each tool call. No `vscode` import.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type * as acp from "@agentclientprotocol/sdk";
import {
  dispatchMcpMessage,
  jsonRpcError,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  sanitizeForLog,
  type McpDispatchContext,
  type McpDispatchResult,
} from "./protocol.js";
import {
  AGENT_LINK_PATH,
  AGENT_LINK_SERVER_NAME,
  DEFAULT_BIND_WAIT_MS,
  DEFAULT_MAX_BODY_BYTES,
  type AgentLinkGrant,
  type AgentLinkLogger,
  type AgentLinkServerApi,
  type AgentLinkServerOptions,
  type AgentLinkTool,
} from "./types.js";

const LOOPBACK_HOST = "127.0.0.1";
/** `serverInfo.title` of `initialize`. */
const SERVER_TITLE = "Kiro ACP chat tabs";
/** Tool error text when an unbound grant is not bound within `bindWaitMs`. */
export const NOT_READY_MESSAGE = "this session is not ready yet";
/** Tool error text when the grant is revoked (session closed, server stopped) while a call waits for `bind`. */
export const REVOKED_MESSAGE = "this session's agent link was revoked";
const CANCELLED_MESSAGE = "the request was cancelled";

const noop = (): void => undefined;

interface BindWaiter {
  resolve(sessionId: string): void;
  reject(error: Error): void;
}

/** What a grant needs from the server that minted it. */
interface GrantOwner {
  forget(grant: Grant): void;
  warn(message: string): void;
}

class Grant implements AgentLinkGrant {
  private bound: string | null;
  private alive = true;
  private readonly waiters = new Set<BindWaiter>();

  constructor(
    readonly token: string,
    private readonly url: string,
    sessionId: string | null,
    private readonly owner: GrantOwner,
  ) {
    this.bound = sessionId;
  }

  get sessionId(): string | null {
    return this.bound;
  }

  get live(): boolean {
    return this.alive;
  }

  mcpServer(): acp.McpServer {
    return {
      type: "http",
      name: AGENT_LINK_SERVER_NAME,
      url: this.url,
      headers: [{ name: "Authorization", value: `Bearer ${this.token}` }],
    };
  }

  bind(sessionId: string): void {
    if (!this.alive) {
      this.owner.warn(`agent-link bind to ${sessionId} ignored: the grant was revoked`);
      return;
    }
    if (this.bound === sessionId) return;
    if (this.bound !== null) this.owner.warn(`agent-link grant of ${this.bound} rebound to ${sessionId}`);
    this.bound = sessionId;
    for (const waiter of [...this.waiters]) waiter.resolve(sessionId);
  }

  revoke(): void {
    if (!this.alive) return;
    this.alive = false;
    this.owner.forget(this);
    const error = new Error(REVOKED_MESSAGE);
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }

  /**
   * The session this grant speaks for, waiting up to `timeoutMs` for `bind()`
   * when it is not bound yet: kiro-cli may call a tool before `session/new`
   * has returned the session id to us.
   */
  waitForBind(signal: AbortSignal, timeoutMs: number): Promise<string> {
    if (!this.alive) return Promise.reject(new Error(REVOKED_MESSAGE));
    if (this.bound !== null) return Promise.resolve(this.bound);
    if (signal.aborted) return Promise.reject(new Error(CANCELLED_MESSAGE));
    return new Promise<string>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
      };
      const waiter: BindWaiter = {
        resolve: (sessionId) => {
          settle();
          resolve(sessionId);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      const onAbort = (): void => waiter.reject(new Error(CANCELLED_MESSAGE));
      const timer = setTimeout(() => waiter.reject(new Error(NOT_READY_MESSAGE)), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }
}

/**
 * The loopback MCP server. One instance serves every session of the agent
 * process; `start()` / `stop()` may be repeated (a stopped server starts again
 * on a new port, and grants issued before the stop stay revoked).
 */
export class AgentLinkServer implements AgentLinkServerApi {
  private readonly tools: readonly AgentLinkTool[];
  private readonly logger: AgentLinkLogger;
  private readonly version: string;
  private readonly instructions: string | undefined;
  private readonly maxBodyBytes: number;
  private readonly bindWaitMs: number;

  private server: Server | null = null;
  private listeningPort: number | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  /** Live grants by token; revoked ones are removed, so a lookup is the whole token check. */
  private readonly grants = new Map<string, Grant>();
  /** Open sockets: keep-alive connections would otherwise keep `close()` waiting. */
  private readonly sockets = new Set<Socket>();
  /** One controller per request being dispatched; aborted on client disconnect or `stop()`. */
  private readonly running = new Set<AbortController>();
  private readonly grantOwner: GrantOwner = {
    forget: (grant) => {
      if (this.grants.get(grant.token) === grant) this.grants.delete(grant.token);
    },
    warn: (message) => this.warn(message),
  };

  constructor(options: AgentLinkServerOptions) {
    this.tools = options.tools;
    this.logger = options.logger;
    this.version = options.version;
    this.instructions = options.instructions;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.bindWaitMs = options.bindWaitMs ?? DEFAULT_BIND_WAIT_MS;
  }

  get port(): number | null {
    return this.listeningPort;
  }

  get url(): string | null {
    return this.listeningPort === null ? null : `http://${LOOPBACK_HOST}:${this.listeningPort}${AGENT_LINK_PATH}`;
  }

  get boundCount(): number {
    let count = 0;
    for (const grant of this.grants.values()) if (grant.sessionId !== null) count += 1;
    return count;
  }

  start(): Promise<void> {
    if (!this.starting) {
      const starting = this.listen();
      this.starting = starting;
      // A failed listen is retried by the next start().
      starting.catch(() => {
        if (this.starting === starting) this.starting = null;
      });
    }
    return this.starting;
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      const stopping = this.shutdown();
      this.stopping = stopping;
      const clear = (): void => {
        if (this.stopping === stopping) this.stopping = null;
      };
      stopping.then(clear, clear);
    }
    return this.stopping;
  }

  issue(sessionId?: string): AgentLinkGrant {
    const url = this.url;
    if (url === null || this.stopping) throw new Error("The agent link server is not started");
    const token = randomBytes(32).toString("base64url");
    const grant = new Grant(token, url, sessionId ?? null, this.grantOwner);
    this.grants.set(token, grant);
    return grant;
  }

  revokeSession(sessionId: string): void {
    for (const grant of [...this.grants.values()]) {
      if (grant.sessionId === sessionId) grant.revoke();
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private async listen(): Promise<void> {
    if (this.stopping) await this.stopping;
    const server = createServer();
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      // The http server reports socket errors as `clientError`; this only makes sure none is unhandled.
      socket.on("error", noop);
    });
    server.on("request", (req: IncomingMessage, res: ServerResponse) => this.onRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Later errors (EMFILE on accept, ...) must not crash the extension host.
    server.on("error", (error: Error) => this.warn(`agent-link server error: ${error.message}`));
    this.server = server;
    this.listeningPort = (server.address() as AddressInfo).port;
    // The owner logs "listening" / "stopped" with its own context; this class logs requests only.
  }

  private async shutdown(): Promise<void> {
    const starting = this.starting;
    this.starting = null;
    if (starting) await starting.catch(noop);

    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    for (const grant of [...this.grants.values()]) grant.revoke();
    this.grants.clear();
    for (const controller of [...this.running]) controller.abort();
    this.running.clear();
    if (!server) return;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of [...this.sockets]) socket.destroy();
      this.sockets.clear();
    });
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    req.on("error", noop);
    res.on("error", noop);
    this.handle(req, res).catch((error: unknown) => {
      this.warn(`agent-link request failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        if (!res.headersSent && !res.writableEnded) {
          this.sendJson(res, 500, jsonRpcError(null, JSONRPC_INTERNAL_ERROR, "Internal error"));
        } else {
          res.destroy();
        }
      } catch {
        res.destroy();
      }
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this.listeningPort;
    if (port === null) {
      res.destroy();
      return;
    }

    // Guards, all before the body is read.
    const host = req.headers.host?.toLowerCase();
    if (host !== `${LOOPBACK_HOST}:${port}` && host !== `localhost:${port}`) {
      return this.refuse(req, res, 403, "foreign Host header");
    }
    if (req.headers.origin !== undefined) {
      return this.refuse(req, res, 403, "Origin header present (browser request)");
    }
    const path = (req.url ?? "").split("?", 1)[0] ?? "";
    if (path !== AGENT_LINK_PATH) {
      return this.refuse(req, res, 404, `unknown path ${JSON.stringify(oneLine(path))}`);
    }
    if (req.method !== "POST") {
      return this.refuse(req, res, 405, `method ${oneLine(req.method ?? "?")} not allowed`, JSONRPC_INVALID_REQUEST, {
        Allow: "POST",
      });
    }
    const authorization = req.headers.authorization;
    const grant = this.grantFor(authorization);
    if (!grant) {
      return this.refuse(req, res, 403, authorization === undefined ? "missing bearer token" : "unknown or revoked token");
    }

    const controller = new AbortController();
    this.running.add(controller);
    let replied = false;
    // `close` before the reply is written means the client went away (or stop() destroyed the socket).
    // Watched from before the body is read, so no disconnect can slip in between.
    res.once("close", () => {
      if (!replied) controller.abort();
    });
    try {
      const body = await this.readBody(req);
      if (body === "too-large") {
        replied = true;
        return this.refuse(req, res, 413, `request body over ${this.maxBodyBytes} bytes`);
      }
      if (body === null || controller.signal.aborted) {
        this.info(`agent-link ${grant.sessionId ?? "unbound"} - -> aborted`);
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        replied = true;
        return this.refuse(req, res, 400, "invalid JSON", JSONRPC_PARSE_ERROR);
      }

      const result = await dispatchMcpMessage(message, this.dispatchContext(grant, controller.signal));
      const who = grant.sessionId ?? "unbound";
      const what = describe(result);
      if (controller.signal.aborted || res.writableEnded || res.destroyed) {
        this.info(`agent-link ${who} ${what} -> aborted`);
        return;
      }
      replied = true;
      if (result.kind === "accepted") {
        res.writeHead(202, { "Content-Length": 0 });
        res.end();
        this.info(`agent-link ${who} ${what} -> 202`);
      } else {
        this.sendJson(res, result.status, result.body);
        this.info(`agent-link ${who} ${what} -> ${result.status}`);
      }
    } finally {
      this.running.delete(controller);
    }
  }

  private dispatchContext(grant: Grant, signal: AbortSignal): McpDispatchContext {
    return {
      tools: this.tools,
      serverInfo: { name: AGENT_LINK_SERVER_NAME, title: SERVER_TITLE, version: this.version },
      instructions: this.instructions,
      resolveCaller: async () => ({ sessionId: await grant.waitForBind(signal, this.bindWaitMs), signal }),
    };
  }

  private grantFor(authorization: string | undefined): Grant | undefined {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? "");
    if (!match) return undefined;
    const grant = this.grants.get(match[1]!);
    return grant?.live ? grant : undefined;
  }

  /**
   * The request body, `"too-large"` once it passes `maxBodyBytes` (nothing more
   * is kept; the rest is discarded so the connection can answer), or null when
   * the client went away first.
   */
  private readBody(req: IncomingMessage): Promise<Buffer | "too-large" | null> {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) return Promise.resolve("too-large");
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (value: Buffer | "too-large" | null): void => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("close", onClose);
        resolve(value);
      };
      const onData = (chunk: Buffer): void => {
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          chunks.length = 0;
          finish("too-large");
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => finish(Buffer.concat(chunks, size));
      const onClose = (): void => finish(null);
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("close", onClose);
    });
  }

  private refuse(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    reason: string,
    code: number = JSONRPC_INVALID_REQUEST,
    headers: OutgoingHttpHeaders = {},
  ): void {
    this.warn(`agent-link refused ${status}: ${reason}`);
    // Discard whatever body is left so a keep-alive connection can carry the answer.
    req.resume();
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    this.sendJson(res, status, jsonRpcError(null, code, reason), headers);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      ...headers,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  private info(message: string): void {
    try {
      this.logger.info(message);
    } catch {
      // logging must never break a request
    }
  }

  private warn(message: string): void {
    try {
      this.logger.warn(message);
    } catch {
      // logging must never break a request
    }
  }
}

/** `<method>[ <tool>][ (<detail>)]` of the request log line, client strings sanitized. */
function describe(result: McpDispatchResult): string {
  let text = result.method === undefined ? "-" : oneLine(result.method);
  if (result.kind === "response") {
    if (result.tool !== undefined) text += ` ${oneLine(result.tool)}`;
    if (result.detail !== undefined) text += ` (${result.detail})`;
  }
  return text;
}

/** Client-supplied text (method, tool, path) on one short log line; `?` when nothing is left. */
function oneLine(text: string): string {
  return sanitizeForLog(text) || "?";
}
