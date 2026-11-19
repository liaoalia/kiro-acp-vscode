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

// ---------------------------------------------------------------------------
// Stages 2–4: reading, messages, waiting, starting (plan Tasks 8–11)
// ---------------------------------------------------------------------------

/** Text of one `send_message` / `start_session` prompt: at most this many UTF-8 bytes. */
export const PEER_MESSAGE_MAX_BYTES = 32 * 1024;
/** `read_session` `last` default and cap (transcript items: messages and tool calls). */
export const READ_SESSION_DEFAULT_ITEMS = 20;
export const READ_SESSION_MAX_ITEMS = 200;
/** `read_session` text is cut to this many characters (oldest items dropped first). */
export const READ_SESSION_MAX_CHARS = 16_000;
/** `wait_for_session` `timeoutSeconds` default and cap. */
export const WAIT_DEFAULT_SECONDS = 120;
export const WAIT_MAX_SECONDS = 600;
/** The last answer returned by `wait_for_session` / shown in errors: at most this many characters. */
export const LAST_ANSWER_MAX_CHARS = 8_000;
/** `kiroAcp.agentLink.maxChain` default: peer-started turns in a row before `send_message` is refused. */
export const DEFAULT_MAX_CHAIN = 6;
/** Messages (`send_message` + `start_session`) one session may send per window. */
export const PEER_RATE_LIMIT = { messages: 10, windowMs: 60_000 } as const;

/** Why the host refused a peer operation. The tools turn it into an `isError` result carrying the message. */
export type AgentLinkErrorCode =
  /** No live session has that handle / id. */
  | "unknown_session"
  /** The target is closing. */
  | "closed"
  /** The target is still being restored (`session/load`). */
  | "restoring"
  /** A session cannot message / wait for itself. */
  | "self"
  /** Empty (whitespace-only) text. */
  | "empty_text"
  /** Text over {@link PEER_MESSAGE_MAX_BYTES}. */
  | "too_long"
  /** The caller's turn was started by a chain of peer messages already `maxChain` long. */
  | "chain_limit"
  /** Over {@link PEER_RATE_LIMIT}. */
  | "rate_limited"
  /** Agent messages are paused (`Kiro: Pause Agent Messages`). */
  | "paused"
  /** The user declined the confirmation. */
  | "declined"
  /** The agent is not running / signed out, or the session could not be created. */
  | "not_ready"
  /** A malformed argument (wrong type, out of range). */
  | "invalid_argument";

export class AgentLinkError extends Error {
  constructor(
    readonly code: AgentLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentLinkError";
  }
}

/** `read_session`: the target and the plain-text tail of its transcript. */
export interface SessionReadResult {
  session: LinkedSessionInfo;
  /** Rendered by `transcriptText()` (src/features/pure/transcriptText.ts). */
  text: string;
  /** Transcript items rendered. */
  items: number;
  /** Older items (or characters) were left out. */
  truncated: boolean;
}

/** How a peer message was delivered: `started` = the target was idle and a turn began; `queued` = held until its turn ends. */
export type PeerDelivery = "started" | "queued";

export interface SendMessageResult {
  to: LinkedSessionInfo;
  delivery: PeerDelivery;
}

/**
 * How `wait_for_session` ended: the target's turn ended and nothing is queued
 * (`idle`), it waits for the user (`needs_input`: a permission request), the
 * wait timed out (`timeout`), or the target went away (`closed`).
 */
export type WaitOutcome = "idle" | "needs_input" | "timeout" | "closed";

export interface WaitResult {
  /** The target as it is now; null when it closed. */
  session: LinkedSessionInfo | null;
  outcome: WaitOutcome;
  /** Text of the target's last agent message (≤ {@link LAST_ANSWER_MAX_CHARS}), null when none. */
  lastAnswer: string | null;
}

/** Where `start_session` opens the new session: a new chat tab, or the caller's tab / sidebar. */
export type StartWhere = "newTab" | "sameTab";

export interface StartSessionResult {
  session: LinkedSessionInfo;
  delivery: PeerDelivery;
}

/**
 * What the chat controller exposes to the tools. `target` is a handle
 * (`s3`, case-insensitive) or a session id. Semantic refusals throw
 * {@link AgentLinkError}; argument types and ranges are checked by the tools
 * before the call.
 */
export interface AgentLinkHost {
  /** Every live session, as seen by `callerSessionId` (which is marked `self`). */
  listSessions(callerSessionId: string): LinkedSessionInfo[];
  /** The last `last` transcript items of `target` as text (the caller may read itself). */
  readSession(callerSessionId: string, target: string, last: number): SessionReadResult;
  /**
   * Deliver `text` to `target` as a user turn framed as a message from the
   * caller (D30): an idle target starts a turn now, a busy one queues it.
   * May ask the user first (`kiroAcp.agentLink.confirm`); `signal` aborts
   * that wait. Never steers a running turn.
   */
  sendMessage(callerSessionId: string, target: string, text: string, signal: AbortSignal): Promise<SendMessageResult>;
  /**
   * Resolve when `target` is idle with nothing queued, needs the user, or
   * closes, or after `timeoutMs`. An already idle target resolves at once.
   * Aborting `signal` rejects.
   */
  waitForSession(callerSessionId: string, target: string, timeoutMs: number, signal: AbortSignal): Promise<WaitResult>;
  /** Create a session (`where`) and deliver `prompt` to it as a peer message from the caller. */
  startSession(callerSessionId: string, prompt: string, where: StartWhere, signal: AbortSignal): Promise<StartSessionResult>;
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
  /**
   * Refuse the token from now on (HTTP 403); pending calls waiting for a bind
   * fail, and running tool calls made with it are aborted (their `signal`).
   */
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
  /** Revoke every grant bound to `sessionId` (aborting their running tool calls). */
  revokeSession(sessionId: string): void;
  /** Live grants bound to a session. */
  readonly boundCount: number;
  /** Revoke every grant, abort running calls, close the listener and open sockets. Idempotent. */
  stop(): Promise<void>;
}
