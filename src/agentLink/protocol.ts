/**
 * The MCP side of the agent link (DECISIONS D30) without sockets: one parsed
 * JSON-RPC message in, one decision out (a response body with its HTTP status,
 * or "accepted" for a notification). `server.ts` owns HTTP, tokens and
 * callers; keeping the dispatch pure lets the edge cases (batches, bad ids,
 * client responses, handler failures) be unit-tested without a listener.
 *
 * Only what a tools-only server needs is implemented: `initialize`, `ping`,
 * `tools/list` and `tools/call`; notifications are accepted and ignored. The
 * server is stateless, so nothing here remembers what `initialize` negotiated.
 */
import {
  LATEST_MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  type AgentLinkTool,
  type CallerContext,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

/** Invalid JSON (sent by `server.ts`, which does the parsing). */
export const JSONRPC_PARSE_ERROR = -32700;
/** Not a single JSON-RPC 2.0 request object (batches included). */
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
/** Bad `tools/call` params, unknown tool included (as the MCP spec asks). */
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** MCP request ids are strings or numbers; they are echoed back untouched. */
export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: JsonRpcErrorObject };

export interface McpServerInfo {
  name: string;
  title?: string;
  version: string;
}

export interface McpDispatchContext {
  tools: readonly AgentLinkTool[];
  serverInfo: McpServerInfo;
  /** `initialize` result `instructions`; omitted when undefined. */
  instructions?: string;
  /**
   * Resolves the caller for `tools/call` only (the server waits here for an
   * unbound grant to be bound). A rejection becomes an `isError` tool result
   * carrying its message, so the agent reads why instead of seeing a
   * transport failure.
   */
  resolveCaller(): Promise<CallerContext>;
}

export type McpDispatchResult =
  | {
      kind: "response";
      /** 400 only for messages that are not one JSON-RPC request; JSON-RPC errors of valid requests are 200. */
      status: 200 | 400;
      body: JsonRpcResponse;
      /** For the log line; absent when the message had no usable method. */
      method?: string;
      /** `tools/call` only: the requested tool name. */
      tool?: string;
      /**
       * `initialize` only, for the log line: what the client sent, already
       * sanitized (`client <name> <version>, protocol <requested> -> <negotiated>`),
       * so the real CLI's MCP client can be read off the output channel.
       */
      detail?: string;
    }
  /** A notification or a JSON-RPC response sent by the client: HTTP 202, no body. */
  | { kind: "accepted"; method?: string };

/** A JSON-RPC error response body. */
export function jsonRpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcErrorObject = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: "2.0", id, error };
}

/** Longest client-supplied string kept in a log line. */
export const LOG_FIELD_MAX_CHARS = 80;

/**
 * Make a client-supplied string safe for one log line: control characters
 * (newlines, C1, line/paragraph separators) become one space each run, and the
 * text is cut to `maxChars` code points. Without it a client could forge
 * output-channel lines or flood them.
 */
export function sanitizeForLog(text: string, maxChars: number = LOG_FIELD_MAX_CHARS): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : clean;
}

/** Echo the client's version when the server speaks it, else offer the latest (the client decides whether to go on). */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_MCP_PROTOCOL_VERSION;
}

/**
 * Dispatch one parsed JSON-RPC message. Never rejects: every failure, a
 * throwing tool included, is turned into a response.
 */
export async function dispatchMcpMessage(message: unknown, ctx: McpDispatchContext): Promise<McpDispatchResult> {
  if (Array.isArray(message)) {
    return invalid("Batches are not supported; send one JSON-RPC message per request");
  }
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    return invalid("Expected a JSON-RPC 2.0 message object");
  }

  let id: JsonRpcId | undefined;
  if (message.id !== undefined) {
    if (!isValidId(message.id)) return invalid("The request id must be a string or a number");
    id = message.id;
  }

  const method = message.method;
  if (method === undefined && id !== undefined && ("result" in message || "error" in message)) {
    // A response to a server-to-client request; this server sends none, so ignore it.
    return { kind: "accepted" };
  }
  if (typeof method !== "string" || method.length === 0) return invalid("Missing method");

  if (id === undefined) return { kind: "accepted", method };

  const params = message.params;
  switch (method) {
    case "initialize": {
      const result = initializeResult(params, ctx);
      return ok(id, method, result, { detail: initializeDetail(params, result.protocolVersion) });
    }
    case "ping":
      return ok(id, method, {});
    // Not advertised in `capabilities`, but some MCP clients list everything
    // on connect and give up on a -32601; empty lists cost nothing.
    case "resources/list":
      return ok(id, method, { resources: [] });
    case "resources/templates/list":
      return ok(id, method, { resourceTemplates: [] });
    case "prompts/list":
      return ok(id, method, { prompts: [] });
    case "tools/list":
      return ok(id, method, { tools: ctx.tools.map((tool): ToolDefinition => tool.definition) });
    case "tools/call":
      return callTool(id, params, ctx);
    default:
      return {
        kind: "response",
        status: 200,
        body: jsonRpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`),
        method,
      };
  }
}

interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools: { listChanged: boolean } };
  serverInfo: McpServerInfo;
  instructions?: string;
}

function initializeResult(params: unknown, ctx: McpDispatchContext): InitializeResult {
  const requested = isObject(params) ? params.protocolVersion : undefined;
  const result: InitializeResult = {
    protocolVersion: negotiateProtocolVersion(requested),
    capabilities: { tools: { listChanged: false } },
    serverInfo: { ...ctx.serverInfo },
  };
  if (ctx.instructions !== undefined) result.instructions = ctx.instructions;
  return result;
}

/** `client <name> <version>, protocol <requested> -> <negotiated>`; `?` for anything missing or not a string. */
function initializeDetail(params: unknown, negotiated: string): string {
  const field = (value: unknown): string => {
    if (typeof value !== "string") return "?";
    return sanitizeForLog(value) || "?";
  };
  const info = isObject(params) && isObject(params.clientInfo) ? params.clientInfo : {};
  const requested = isObject(params) ? params.protocolVersion : undefined;
  return `client ${field(info.name)} ${field(info.version)}, protocol ${field(requested)} -> ${negotiated}`;
}

async function callTool(id: JsonRpcId, params: unknown, ctx: McpDispatchContext): Promise<McpDispatchResult> {
  const method = "tools/call";
  const fail = (message: string, tool?: string): McpDispatchResult => ({
    kind: "response",
    status: 200,
    body: jsonRpcError(id, JSONRPC_INVALID_PARAMS, message),
    method,
    ...(tool === undefined ? {} : { tool }),
  });

  if (!isObject(params) || typeof params.name !== "string") return fail("tools/call needs params.name");
  const name = params.name;
  const tool = ctx.tools.find((candidate) => candidate.definition.name === name);
  if (!tool) return fail(`Unknown tool: ${name}`, name);

  const rawArgs = params.arguments;
  // `null` is read as "no arguments" (lenient); arrays and primitives are refused.
  if (rawArgs !== undefined && rawArgs !== null && !isObject(rawArgs)) {
    return fail(`Arguments of ${name} must be an object`, name);
  }
  const args: Record<string, unknown> = isObject(rawArgs) ? rawArgs : {};

  let result: ToolResult;
  try {
    const caller = await ctx.resolveCaller();
    result = normalizeToolResult(await tool.call(args, caller));
  } catch (error) {
    result = { content: [{ type: "text", text: errorMessage(error) }], isError: true };
  }
  return ok(id, method, result, { tool: name });
}

function normalizeToolResult(value: unknown): ToolResult {
  if (!isObject(value)) return { content: [] };
  const result = value as unknown as ToolResult;
  return Array.isArray(result.content) ? result : { ...result, content: [] };
}

function ok(
  id: JsonRpcId,
  method: string,
  result: unknown,
  extra: { tool?: string; detail?: string } = {},
): McpDispatchResult {
  return { kind: "response", status: 200, body: { jsonrpc: "2.0", id, result }, method, ...extra };
}

function invalid(message: string): McpDispatchResult {
  return { kind: "response", status: 400, body: jsonRpcError(null, JSONRPC_INVALID_REQUEST, message) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "The tool failed";
  }
}
