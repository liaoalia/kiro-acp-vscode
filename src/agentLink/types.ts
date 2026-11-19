/**
 * Agent link (DECISIONS D30): a small MCP server on loopback HTTP that the
 * extension hands to every Kiro session through `session/new` /
 * `session/load` `mcpServers`, so the agent in one chat tab can see the other
 * live sessions (and, in later stages, read them, message them and wait for
 * them). Every session gets its own bearer token, so each tool call names the
 * session that made it.
 *
 * This module is the contract between the MCP layer (`protocol.ts`,
 * `server.ts`), the tools (`tools.ts`) and the chat controller. Everything
 * under `src/agentLink/` is vscode-free.
 */
import type * as acp from "@agentclientprotocol/sdk";

/** The `mcpServers[].name` the agent sees; Kiro prefixes tool names with it. */
export const AGENT_LINK_SERVER_NAME = "kiro-acp-tabs";
/** The only path the server answers on. */
export const AGENT_LINK_PATH = "/mcp";
/** MCP protocol versions the server speaks, newest first; `initialize` echoes the client's when listed. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_MCP_PROTOCOL_VERSION: string = MCP_PROTOCOL_VERSIONS[0];
/** Request bodies above this are refused with HTTP 413. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/** How long a `tools/call` with a grant not yet bound to a session waits for `bind()`. */
export const DEFAULT_BIND_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Who is calling a tool. */
export interface CallerContext {
  /** The session whose token made the call. */
  sessionId: string;
  /** Aborted when the HTTP client goes away or the server stops. */
  signal: AbortSignal;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

/** MCP `CallToolResult` (text content only). */
export interface ToolResult {
  content: ToolTextContent[];
  /** Machine-readable copy of the result (MCP 2025-06-18+). */
  structuredContent?: Record<string, unknown>;
  /** The tool ran and failed; the text says why. */
  isError?: boolean;
}

/** MCP tool annotations (hints only). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One entry of the `tools/list` result. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  /** JSON Schema of the arguments (always an object schema). */
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: ToolAnnotations;
}

export interface AgentLinkTool {
  definition: ToolDefinition;
  /**
   * Run the tool. `args` is the `arguments` object of `tools/call` (`{}` when
   * absent). A thrown error becomes an `isError: true` result carrying its
   * message; it is never a JSON-RPC error.
   */
  call(args: Record<string, unknown>, caller: CallerContext): Promise<ToolResult> | ToolResult;
}

// ---------------------------------------------------------------------------
// What the controller exposes to the tools
// ---------------------------------------------------------------------------

export type LinkedSessionStatus =
  /** A turn is running. */
  | "working"
  /** No turn, nothing pending. */
  | "idle"
  /** Waiting for the user (a permission request is pending). */
  | "needs_input"
  /** `session/load` is still replaying its history. */
  | "restoring";

export interface LinkedSessionInfo {
  /** Short handle the agents use to address the session (stable while it lives). */
  handle: string;
  sessionId: string;
  title: string;
  /** Human name of the tab / sidebar the session lives in. */
  tab: string;
  status: LinkedSessionStatus;
  /** The session that asked. */
  self: boolean;
}

export interface AgentLinkHost {
  /** Every live session, as seen by `callerSessionId` (which is marked `self`). */
  listSessions(callerSessionId: string): LinkedSessionInfo[];
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * The right of one session to call the server: a random bearer token. Issued
 * before `session/new` (the session id is not known yet) and bound once the
 * agent answered; issued already bound for `session/load`.
 */
export interface AgentLinkGrant {
  readonly token: string;
  /** The session this grant speaks for; null until bound. */
  readonly sessionId: string | null;
  /** False once revoked (or the server stopped). */
  readonly live: boolean;
  /**
   * The `mcpServers` entry for `session/new` / `session/load`:
   * `{ type: "http", name: AGENT_LINK_SERVER_NAME, url, headers: [Authorization: Bearer <token>] }`.
   */
  mcpServer(): acp.McpServer;
  /** Tie the grant to `sessionId`; pending `tools/call`s waiting for it proceed. */
  bind(sessionId: string): void;
  /** Refuse the token from now on (HTTP 403); pending calls waiting for a bind fail. */
  revoke(): void;
}

export interface AgentLinkLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface AgentLinkServerOptions {
  tools: readonly AgentLinkTool[];
  logger: AgentLinkLogger;
  /** `serverInfo.version` (the extension version). */
  version: string;
  /** `initialize` result `instructions`: what the tools are for. */
  instructions?: string;
  /** Default {@link DEFAULT_MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
  /** Default {@link DEFAULT_BIND_WAIT_MS}. */
  bindWaitMs?: number;
}

export interface AgentLinkServerApi {
  /** Listen on `127.0.0.1` at a free port. Idempotent. */
  start(): Promise<void>;
  /** `http://127.0.0.1:<port>/mcp` once started, else null. */
  readonly url: string | null;
  readonly port: number | null;
  /** Mint a grant, bound to `sessionId` when given. Throws when the server is not started. */
  issue(sessionId?: string): AgentLinkGrant;
  /** Revoke every grant bound to `sessionId`. */
  revokeSession(sessionId: string): void;
  /** Live grants bound to a session. */
  readonly boundCount: number;
  /** Revoke every grant, abort running calls, close the listener and open sockets. Idempotent. */
  stop(): Promise<void>;
}
