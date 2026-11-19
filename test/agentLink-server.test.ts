import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { AgentLinkServer, NOT_READY_MESSAGE, REVOKED_MESSAGE } from "../src/agentLink/server.js";
import {
  AGENT_LINK_PATH,
  AGENT_LINK_SERVER_NAME,
  LATEST_MCP_PROTOCOL_VERSION,
  type AgentLinkServerOptions,
  type AgentLinkTool,
  type CallerContext,
  type ToolResult,
} from "../src/agentLink/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class MemoryLogger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const objectSchema = { type: "object" as const };

interface Fixture {
  server: AgentLinkServer;
  logger: MemoryLogger;
  /** Resolved with the caller when the `hang` tool starts. */
  entered: Deferred<CallerContext>;
  /** Resolved with the session id when the `hang` tool's signal is aborted. */
  aborted: Deferred<string>;
}

async function startServer(options: Partial<AgentLinkServerOptions> = {}): Promise<Fixture> {
  const logger = new MemoryLogger();
  const entered = deferred<CallerContext>();
  const aborted = deferred<string>();
  const tools: AgentLinkTool[] = [
    {
      definition: { name: "whoami", description: "The caller's session", inputSchema: objectSchema },
      call: (args, caller) => text(JSON.stringify({ sessionId: caller.sessionId, args })),
    },
    {
      definition: { name: "boom", description: "Throws synchronously", inputSchema: objectSchema },
      call: () => {
        throw new Error("boom");
      },
    },
    {
      definition: { name: "hang", description: "Waits until aborted", inputSchema: objectSchema },
      call: (_args, caller) =>
        new Promise<ToolResult>((_resolve, reject) => {
          caller.signal.addEventListener("abort", () => {
            aborted.resolve(caller.sessionId);
            reject(new Error("aborted"));
          });
          entered.resolve(caller);
        }),
    },
  ];
  const server = new AgentLinkServer({
    tools,
    logger,
    version: "1.2.3",
    instructions: "Talk to the other tabs.",
    ...options,
  });
  await server.start();
  return { server, logger, entered, aborted };
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  body: any;
}

/** POST through global `fetch` (sets a correct Host, no Origin), like kiro-cli would. */
async function post(
  url: string,
  token: string | undefined,
  message: unknown,
  init: { raw?: string; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...init.headers,
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(message),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, text: body, body: body ? JSON.parse(body) : undefined };
}

interface RawReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** A request through `node:http`, for headers `fetch` will not let us choose (Host, Origin) and chunked bodies. */
function rawRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string | Buffer | Buffer[];
    agent?: http.Agent | false;
  },
): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? AGENT_LINK_PATH,
        headers: options.headers ?? {},
        agent: options.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (Array.isArray(options.body)) {
      for (const chunk of options.body) req.write(chunk);
      req.end();
    } else {
      req.end(options.body);
    }
  });
}

const rpc = (id: number | string, method: string, params?: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

const callTool = (id: number, name: string, args?: unknown): Record<string, unknown> =>
  rpc(id, "tools/call", args === undefined ? { name } : { name, arguments: args });

function assertNoToken(logger: MemoryLogger, ...tokens: string[]): void {
  for (const line of logger.lines) {
    for (const token of tokens) assert.ok(!line.includes(token), `token leaked into log: ${line}`);
  }
}

// ---------------------------------------------------------------------------
// MCP over HTTP
// ---------------------------------------------------------------------------

test("initialize negotiates the protocol version, describes the server and logs the client", async () => {
  const { server, logger } = await startServer();
  try {
    assert.equal(server.url, `http://127.0.0.1:${server.port}${AGENT_LINK_PATH}`);
    const grant = server.issue("s-1");
    const known = await post(server.url!, grant.token, rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-mcp", version: "0.1" },
    }));
    assert.equal(known.status, 200);
    assert.equal(known.headers.get("content-type"), "application/json");
    assert.equal(known.headers.get("mcp-session-id"), null);
    assert.deepEqual(known.body, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: AGENT_LINK_SERVER_NAME, title: "Kiro ACP chat tabs", version: "1.2.3" },
        instructions: "Talk to the other tabs.",
      },
    });

    const unknown = await post(server.url!, grant.token, rpc(2, "initialize", {
      protocolVersion: "2099-01-01",
      clientInfo: { name: "evil\nwarn agent-link forged", version: "1" },
    }));
    assert.equal(unknown.body.result.protocolVersion, LATEST_MCP_PROTOCOL_VERSION);

    assert.deepEqual(logger.lines.filter((l) => l.includes(" initialize ")), [
      "info agent-link s-1 initialize (client fake-mcp 0.1, protocol 2025-06-18 -> 2025-06-18) -> 200",
      `info agent-link s-1 initialize (client evil warn agent-link forged 1, protocol 2099-01-01 -> ${LATEST_MCP_PROTOCOL_VERSION}) -> 200`,
    ]);
    assert.ok(logger.lines.every((l) => !l.includes("\n")));
    assertNoToken(logger, grant.token);
  } finally {
    await server.stop();
  }
});

test("tools/list, ping, tools/call and protocol errors over HTTP", async () => {
  const { server, logger } = await startServer();
  try {
    const grant = server.issue("s-1");
    const url = server.url!;

    const list = await post(url, grant.token, rpc(1, "tools/list"));
    assert.deepEqual(
      list.body.result.tools.map((t: { name: string }) => t.name),
      ["whoami", "boom", "hang"],
    );

    assert.deepEqual((await post(url, grant.token, rpc("p", "ping"))).body, { jsonrpc: "2.0", id: "p", result: {} });

    const ok = await post(url, grant.token, callTool(2, "whoami", { x: 1 }));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.result, {
      content: [{ type: "text", text: JSON.stringify({ sessionId: "s-1", args: { x: 1 } }) }],
    });

    const unknownTool = await post(url, grant.token, callTool(3, "nope"));
    assert.equal(unknownTool.status, 200);
    assert.equal(unknownTool.body.error.code, -32602);
    assert.equal(unknownTool.body.id, 3);

    const badArgs = await post(url, grant.token, callTool(4, "whoami", [1]));
    assert.equal(badArgs.body.error.code, -32602);

    // A synchronously throwing handler is a tool error, and the server keeps serving.
    const boom = await post(url, grant.token, callTool(5, "boom"));
    assert.deepEqual(boom.body.result, { content: [{ type: "text", text: "boom" }], isError: true });

    const unknownMethod = await post(url, grant.token, rpc(6, "completion/complete"));
    assert.equal(unknownMethod.status, 200);
    assert.equal(unknownMethod.body.error.code, -32601);

    assert.equal((await post(url, grant.token, rpc(7, "ping"))).status, 200);

    const info = logger.lines.filter((l) => l.startsWith("info agent-link s-1"));
    assert.ok(info.includes("info agent-link s-1 tools/list -> 200"), info.join("\n"));
    assert.ok(info.includes("info agent-link s-1 tools/call whoami -> 200"), info.join("\n"));
    assert.ok(info.includes("info agent-link s-1 tools/call nope -> 200"), info.join("\n"));
    assert.ok(info.includes("info agent-link s-1 completion/complete -> 200"), info.join("\n"));
    assertNoToken(logger, grant.token);
  } finally {
    await server.stop();
  }
});

test("notifications and client responses get 202 with an empty body", async () => {
  const { server, logger } = await startServer();
  try {
    const grant = server.issue("s-1");
    const initialized = await post(server.url!, grant.token, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(initialized.status, 202);
    assert.equal(initialized.text, "");
    const clientResponse = await post(server.url!, grant.token, { jsonrpc: "2.0", id: 9, result: {} });
    assert.equal(clientResponse.status, 202);
    assert.equal(clientResponse.text, "");
    assert.ok(logger.lines.includes("info agent-link s-1 notifications/initialized -> 202"));
    assert.ok(logger.lines.includes("info agent-link s-1 - -> 202"));
  } finally {
    await server.stop();
  }
});

test("a batch is -32600 and invalid JSON is -32700, both HTTP 400", async () => {
  const { server, logger } = await startServer();
  try {
    const grant = server.issue("s-1");
    const batch = await post(server.url!, grant.token, [rpc(1, "ping"), rpc(2, "ping")]);
    assert.equal(batch.status, 400);
    assert.equal(batch.body.error.code, -32600);
    assert.equal(batch.body.id, null);

    const invalid = await post(server.url!, grant.token, undefined, { raw: "{not json" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } });
    assert.ok(logger.lines.includes("warn agent-link refused 400: invalid JSON"));
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("a missing, unknown or revoked token is 403 (never 401)", async () => {
  const { server, logger } = await startServer();
  try {
    const url = server.url!;
    const first = server.issue("s-1");
    const second = server.issue("s-1");
    const other = server.issue("s-2");
    assert.equal(server.boundCount, 3);

    assert.equal((await post(url, undefined, rpc(1, "ping"))).status, 403);
    assert.equal((await post(url, "not-a-token", rpc(1, "ping"))).status, 403);
    const basic = await post(url, undefined, rpc(1, "ping"), { headers: { authorization: `Basic ${first.token}` } });
    assert.equal(basic.status, 403);

    // The scheme is case-insensitive.
    assert.equal((await post(url, undefined, rpc(1, "ping"), { headers: { authorization: `bearer ${first.token}` } })).status, 200);

    first.revoke();
    assert.equal(first.live, false);
    const revoked = await post(url, first.token, rpc(1, "ping"));
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.error.code, -32600);
    assert.equal(server.boundCount, 2);

    server.revokeSession("s-1");
    assert.equal(second.live, false);
    assert.equal((await post(url, second.token, rpc(1, "ping"))).status, 403);
    assert.equal(other.live, true);
    assert.equal((await post(url, other.token, rpc(1, "ping"))).status, 200);
    assert.equal(server.boundCount, 1);

    const refusals = logger.lines.filter((l) => l.startsWith("warn agent-link refused"));
    assert.ok(refusals.includes("warn agent-link refused 403: missing bearer token"), refusals.join("\n"));
    assert.ok(refusals.includes("warn agent-link refused 403: unknown or revoked token"), refusals.join("\n"));
    assertNoToken(logger, first.token, second.token, other.token, "not-a-token");
  } finally {
    await server.stop();
  }
});

test("a foreign Host or any Origin is 403; localhost and case differences are fine", async () => {
  const { server, logger } = await startServer();
  try {
    const port = server.port!;
    const grant = server.issue("s-1");
    const body = JSON.stringify(rpc(1, "ping"));
    const headers = { "content-type": "application/json", authorization: `Bearer ${grant.token}` };

    const send = (extra: http.OutgoingHttpHeaders): Promise<RawReply> =>
      rawRequest(port, { headers: { ...headers, ...extra }, body });

    assert.equal((await send({ host: `evil.example:${port}` })).status, 403);
    assert.equal((await send({ host: `127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await send({ host: "127.0.0.1" })).status, 403);
    assert.equal((await send({ origin: `http://127.0.0.1:${port}` })).status, 403);
    assert.equal((await send({ origin: "null" })).status, 403);

    assert.equal((await send({ host: `localhost:${port}` })).status, 200);
    assert.equal((await send({ host: `LOCALHOST:${port}` })).status, 200);
    assert.equal((await send({ host: `127.0.0.1:${port}` })).status, 200);

    assert.ok(logger.lines.includes("warn agent-link refused 403: foreign Host header"));
    assert.ok(logger.lines.includes("warn agent-link refused 403: Origin header present (browser request)"));
  } finally {
    await server.stop();
  }
});

test("other paths are 404, other methods 405 with Allow: POST, a query string is ignored", async () => {
  const { server } = await startServer();
  try {
    const port = server.port!;
    const grant = server.issue("s-1");
    const auth = { authorization: `Bearer ${grant.token}` };

    assert.equal((await rawRequest(port, { path: "/other", headers: auth, body: "{}" })).status, 404);
    assert.equal((await rawRequest(port, { path: "/mcp/x", headers: auth, body: "{}" })).status, 404);

    for (const method of ["GET", "DELETE", "PUT"]) {
      const reply = await rawRequest(port, { method, headers: { ...auth, accept: "text/event-stream" } });
      assert.equal(reply.status, 405, method);
      assert.equal(reply.headers.allow, "POST");
    }
    // 405 does not depend on the token (a probe for an SSE stream gets the same answer).
    assert.equal((await rawRequest(port, { method: "GET" })).status, 405);

    const withQuery = await post(`${server.url!}?x=1`, grant.token, rpc(1, "ping"));
    assert.equal(withQuery.status, 200);
  } finally {
    await server.stop();
  }
});

test("a body over maxBodyBytes is 413 (declared or streamed) and the server keeps serving", async () => {
  const { server, logger } = await startServer({ maxBodyBytes: 1024 });
  try {
    const grant = server.issue("s-1");
    const big = JSON.stringify(rpc(1, "tools/call", { name: "whoami", arguments: { pad: "x".repeat(4096) } }));

    const declared = await post(server.url!, grant.token, undefined, { raw: big });
    assert.equal(declared.status, 413);
    assert.equal(declared.body.error.code, -32600);

    const chunk = Buffer.alloc(512, 0x20);
    const streamed = await rawRequest(server.port!, {
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json", "transfer-encoding": "chunked" },
      body: [chunk, chunk, chunk, chunk, chunk, chunk],
    });
    assert.equal(streamed.status, 413);

    // Exactly at the limit is fine.
    const exact = JSON.stringify(rpc(2, "ping")).padEnd(1024, " ");
    assert.equal((await post(server.url!, grant.token, undefined, { raw: exact })).status, 200);
    assert.ok(logger.lines.includes("warn agent-link refused 413: request body over 1024 bytes"));
  } finally {
    await server.stop();
  }
});

test("the default body limit is 1 MiB", async () => {
  const { server } = await startServer();
  try {
    const grant = server.issue("s-1");
    const big = JSON.stringify(rpc(1, "ping", { pad: "x".repeat(1024 * 1024) }));
    assert.equal((await post(server.url!, grant.token, undefined, { raw: big })).status, 413);
    const fits = JSON.stringify(rpc(2, "ping", { pad: "x".repeat(1024 * 1024 - 100) }));
    assert.equal((await post(server.url!, grant.token, undefined, { raw: fits })).status, 200);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

test("grants: mcpServer() entry, issue() before start throws, start is idempotent and restartable", async () => {
  const logger = new MemoryLogger();
  const server = new AgentLinkServer({ tools: [], logger, version: "1.0.0" });
  assert.equal(server.url, null);
  assert.equal(server.port, null);
  assert.throws(() => server.issue(), /not started/);
  try {
    await Promise.all([server.start(), server.start()]);
    const port = server.port;
    await server.start();
    assert.equal(server.port, port);

    const grant = server.issue();
    assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(server.issue().token, grant.token);
    assert.equal(grant.sessionId, null);
    assert.equal(grant.live, true);
    assert.deepEqual(grant.mcpServer(), {
      type: "http",
      name: AGENT_LINK_SERVER_NAME,
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${grant.token}` }],
    });
    assert.equal(server.boundCount, 0);
    assert.equal(server.issue("s-9").sessionId, "s-9");
    assert.equal(server.boundCount, 1);

    await server.stop();
    assert.equal(grant.live, false);
    assert.equal(server.boundCount, 0);
    assert.equal(server.url, null);
    assert.throws(() => server.issue(), /not started/);

    await server.start();
    assert.notEqual(server.port, null);
    assert.equal(grant.live, false);
    assert.equal((await post(server.url!, grant.token, rpc(1, "ping"))).status, 403);
    assertNoToken(logger, grant.token);
  } finally {
    await server.stop();
  }
});

test("binding to another session: last wins, with a warning", async () => {
  const { server, logger } = await startServer();
  try {
    const grant = server.issue();
    grant.bind("s-1");
    grant.bind("s-1");
    grant.bind("s-2");
    assert.equal(grant.sessionId, "s-2");
    assert.equal(logger.lines.filter((l) => l.startsWith("warn")).length, 1);
    assert.ok(logger.lines.includes("warn agent-link grant of s-1 rebound to s-2"));
    server.revokeSession("s-1");
    assert.equal(grant.live, true);
    const who = await post(server.url!, grant.token, callTool(1, "whoami"));
    assert.equal(JSON.parse(who.body.result.content[0].text).sessionId, "s-2");
    server.revokeSession("s-2");
    assert.equal(grant.live, false);
    grant.bind("s-3"); // ignored
    assert.equal(grant.sessionId, "s-2");
  } finally {
    await server.stop();
  }
});

test("an unbound grant may initialize; its tools/call waits for bind()", async () => {
  const { server, logger } = await startServer();
  try {
    const grant = server.issue();
    const init = await post(server.url!, grant.token, rpc(1, "initialize", { protocolVersion: "2025-06-18" }));
    assert.equal(init.status, 200);
    assert.equal((await post(server.url!, grant.token, rpc(2, "tools/list"))).status, 200);

    const call = post(server.url!, grant.token, callTool(3, "whoami"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    grant.bind("s-late");
    const reply = await withTimeout(call, 5000, "tools/call after bind");
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body.result.content[0].text), { sessionId: "s-late", args: {} });
    assert.equal(server.boundCount, 1);

    assert.ok(logger.lines.some((l) => l.startsWith("info agent-link unbound initialize (client ? ?, protocol 2025-06-18")));
    assert.ok(logger.lines.includes("info agent-link unbound tools/list -> 200"));
    assert.ok(logger.lines.includes("info agent-link s-late tools/call whoami -> 200"));
  } finally {
    await server.stop();
  }
});

test("an unbound grant's tools/call fails after bindWaitMs", async () => {
  const { server } = await startServer({ bindWaitMs: 50 });
  try {
    const grant = server.issue();
    const started = Date.now();
    const reply = await withTimeout(post(server.url!, grant.token, callTool(1, "whoami")), 5000, "bind wait");
    assert.ok(Date.now() - started >= 40);
    assert.deepEqual(reply.body.result, { content: [{ type: "text", text: NOT_READY_MESSAGE }], isError: true });
    // A late bind still works for the next call.
    grant.bind("s-1");
    const again = await post(server.url!, grant.token, callTool(2, "whoami"));
    assert.equal(again.body.result.isError, undefined);
  } finally {
    await server.stop();
  }
});

test("revoking an unbound grant fails its waiting tools/call; the token is then refused", async () => {
  const { server } = await startServer();
  try {
    const grant = server.issue();
    const call = post(server.url!, grant.token, callTool(1, "whoami"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    grant.revoke();
    const reply = await withTimeout(call, 5000, "revoked wait");
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.result, { content: [{ type: "text", text: REVOKED_MESSAGE }], isError: true });
    assert.equal((await post(server.url!, grant.token, rpc(2, "ping"))).status, 403);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Abort and shutdown
// ---------------------------------------------------------------------------

test("caller.signal is aborted when the client abandons the request", async () => {
  const { server, logger, entered, aborted } = await startServer();
  try {
    const grant = server.issue("s-1");
    const controller = new AbortController();
    const call = post(server.url!, grant.token, callTool(1, "hang"), { signal: controller.signal });
    const caller = await withTimeout(entered.promise, 5000, "hang entered");
    assert.equal(caller.sessionId, "s-1");
    assert.equal(caller.signal.aborted, false);
    controller.abort();
    await assert.rejects(call);
    assert.equal(await withTimeout(aborted.promise, 5000, "server-side abort"), "s-1");
    assert.equal(caller.signal.aborted, true);

    // The server is still fine, and the abandoned call was logged once.
    assert.equal((await post(server.url!, grant.token, rpc(2, "ping"))).status, 200);
    await withTimeout(
      (async () => {
        while (!logger.lines.includes("info agent-link s-1 tools/call hang -> aborted")) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
      5000,
      "aborted log line",
    );
  } finally {
    await server.stop();
  }
});

test("stop() aborts running calls and closes promptly with a keep-alive connection open", async () => {
  const { server, entered, aborted } = await startServer();
  const agent = new http.Agent({ keepAlive: true });
  try {
    const grant = server.issue("s-1");
    const port = server.port!;
    const headers = { authorization: `Bearer ${grant.token}`, "content-type": "application/json" };
    const ping = await rawRequest(port, { headers, body: JSON.stringify(rpc(1, "ping")), agent });
    assert.equal(ping.status, 200);
    await withTimeout(
      (async () => {
        while (Object.values(agent.freeSockets).flat().length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })(),
      2000,
      "an idle keep-alive socket",
    );

    // A second connection with a call in flight.
    const hanging = rawRequest(port, { headers, body: JSON.stringify(callTool(2, "hang")) });
    hanging.catch(() => undefined);
    await withTimeout(entered.promise, 5000, "hang entered");

    const started = Date.now();
    await withTimeout(server.stop(), 3000, "stop()");
    assert.ok(Date.now() - started < 2000, `stop took ${Date.now() - started} ms`);
    assert.equal(await withTimeout(aborted.promise, 1000, "abort on stop"), "s-1");
    await assert.rejects(hanging);
    assert.equal(server.url, null);
    assert.equal(server.port, null);
    assert.equal(grant.live, false);
    await server.stop(); // idempotent
    await Promise.all([server.stop(), server.stop()]);
  } finally {
    agent.destroy();
    await server.stop();
  }
});
