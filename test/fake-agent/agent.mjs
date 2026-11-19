#!/usr/bin/env node
/**
 * Fake Kiro ACP agent for tests and manual runs.
 *
 * Speaks ACP over stdio with the official SDK and replays recordings from
 * `test/recordings/<scenario>.json` when it receives `session/prompt`.
 *
 * Usage:
 *   node test/fake-agent/agent.mjs [acp] [--scenario <name>] [--auth-required] [--engine v2|v3] [--no-image] [--no-mcp-http]
 *
 * A leading `acp` argument is ignored so the extension can be pointed at it
 * with `kiroAcp.cliPath = "node"` and `cliArgs = ["<path>/agent.mjs", ...]`.
 * A prompt whose text starts with `/scenario <name>` selects that recording
 * for the turn instead of the launch scenario; a prompt of images only runs
 * the `images` recording. Every turn gets the vars `images` (a summary of the
 * prompt's image blocks, e.g. `1 image(s): image/png 67 B shot.png`) and
 * `blockTypes` (the prompt's block types in order, e.g. `text,image`).
 * `--no-image` stops advertising `promptCapabilities.image`.
 *
 * MCP servers (v3 only): `initialize` advertises `mcpCapabilities: { http, sse }`
 * like the real CLI; `--no-mcp-http` advertises `{ sse }` only. `session/new`
 * and `session/load` remember the session's `mcpServers` (names and urls are
 * logged to stderr, header values never); `session/new` with an `http` entry
 * while `http` is not advertised (v2, `--no-mcp-http`) fails with -32602, like
 * a strict agent. The `mcp_call` step acts as an MCP Streamable HTTP client.
 *
 * Recording step format (all string values support `{{var}}` placeholders;
 * `cwd`, `sessionId` and anything stored through `save` are available):
 *   { "kind": "update", "update": { ...SessionUpdate... } }
 *   { "kind": "notify", "method": "_kiro/...", "params": {...} }
 *   { "kind": "client_request", "method": "fs/read_text_file", "params": {...},
 *     "expect": {...partial match of the result...}, "expectError": { "code": -32601 },
 *     "save": { "<var>": "<result field path>" }, "optional": true }
 *   { "kind": "permission", "toolCall": { ...ToolCallUpdate... }, "options": [...PermissionOption...],
 *     "meta": {...}, "allow": [steps], "reject": [steps] }
 *       -> allow: runs `allow` steps then emits tool_call_update completed
 *       -> reject: runs `reject` steps then emits tool_call_update failed (_meta.kiro.failureReason "denied")
 *       -> cancelled: emits tool_call_update failed ("cancelled") and ends the turn with stopReason cancelled
 *   { "kind": "delay", "ms": 10 }
 *   { "kind": "hang" }                   -> never returns, even after session/cancel (a stuck agent)
 *   { "kind": "delay_uncancellable", "ms": 6500 } -> waits that long ignoring session/cancel, then goes on
 *   { "kind": "stderr", "text": "..." }
 *   { "kind": "repeat", "times": 40, "steps": [ ...steps using {{i}}... ] }
 *   { "kind": "mcp_call", "server": "kiro-acp-tabs", "tool": "list_sessions", "arguments": {...},
 *     "toolCallId": "mcp-1", "save": { "<var>": "<tool result field path>" },
 *     "expect": {...partial match of the CallToolResult...},
 *     "expectError": { "status": 403, "code": -32601, "message": "..." }, "optional": true }
 *       -> finds the session's `mcpServers` entry with that name and type "http" (none: reported
 *          unless `optional`), emits `tool_call` (title "<server>/<tool>", kind "other", rawInput =
 *          arguments), POSTs `initialize`, `notifications/initialized` and `tools/call` to its url
 *          with its headers, then `tool_call_update` completed (failed when `isError`) with the
 *          result text as content and the result as rawOutput. An HTTP error or JSON-RPC error
 *          fails the tool call and is reported unless `expectError` matches it or `optional`.
 *          Sets the vars `mcp.text` (the result's text blocks joined by "\n", or the error text)
 *          and `mcp.status` ("completed" | "failed" | "missing"); session/cancel aborts the call.
 *   { "kind": "exit", "code": 3 }          -> the process exits mid-turn
 *   { "kind": "stop", "stopReason": "end_turn" }
 *
 * Session history (v3 only): every prompt's user text and the updates emitted
 * during the turn are kept per session. `session/list` reports live sessions
 * plus two canned past sessions (`past-1`, `past-2`), paginated in pages of
 * `--list-page-size N` (default 2) entries via `cursor`/`nextCursor`;
 * `session/load` replays a
 * session's history as `session/update`s marked `_meta.kiro.replay: true`
 * before answering, after which the session accepts prompts.
 *
 * Steering (v3 only): `_session/steer { sessionId, prompt }` during a turn
 * answers `{}` and, 150 ms later, emits `session_info_update`
 * (`_meta.kiro.kind: "steering_injected"`) followed by an agent chunk
 * `Steered: <text>` inside the running turn; without a turn it fails with
 * -32602. The v2 engine does not register the method (-32601).
 */
import * as acp from "@agentclientprotocol/sdk";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const recordingsDir = join(here, "..", "recordings");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const standaloneLogin = argv[0] === "login";
if (argv[0] === "acp") argv.shift();
if (argv[0] === "logout") {
  process.stdout.write("fake kiro-cli: logged out\n");
  process.exit(0);
}
// Sign-in stand-ins: the fallback runs `<cliPath> login`; the advertised terminal
// method appends `--login` to the agent invocation (`<cliPath> acp … --login`).
if (standaloneLogin || argv.includes("--login")) {
  process.stdout.write("fake kiro-cli: logged in\n");
  process.exit(0);
}
/** `listPageSize`: `session/list` pages of this many entries (`--list-page-size N`, default 2). */
/** `mcpHttp`: advertise `mcpCapabilities.http` (v3; `--no-mcp-http` turns it off). */
const config = { scenario: "tour", authRequired: false, authAgentMethods: false, engine: "v3", listPageSize: 2, image: true, mcpHttp: true };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--scenario") config.scenario = argv[++i] ?? config.scenario;
  else if (arg.startsWith("--scenario=")) config.scenario = arg.slice("--scenario=".length);
  else if (arg === "--auth-required") config.authRequired = true;
  // Like the real Kiro CLI 3.x: agent-type methods are advertised, yet `authenticate`
  // only re-checks the cached token and fails while signed out.
  else if (arg === "--auth-agent-methods") config.authRequired = config.authAgentMethods = true;
  else if (arg === "--engine") config.engine = argv[++i] ?? config.engine;
  else if (arg.startsWith("--engine=")) config.engine = arg.slice("--engine=".length);
  else if (arg.startsWith("--agent-engine=")) config.engine = arg.slice("--agent-engine=".length);
  else if (arg === "--no-image") config.image = false;
  else if (arg === "--no-mcp-http") config.mcpHttp = false;
  else if (arg === "--list-page-size") config.listPageSize = parsePageSize(argv[++i]);
  else if (arg.startsWith("--list-page-size=")) config.listPageSize = parsePageSize(arg.slice("--list-page-size=".length));
}
const isV2 = config.engine === "v2";
const AGENT_VERSION = isV2 ? "2.0.0-fake" : "3.0.0-fake";
/** Whether `session/new` accepts `http` MCP servers (what `initialize` advertises). */
const mcpHttpAdvertised = !isV2 && config.mcpHttp;

function parsePageSize(value) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (text) => process.stderr.write(`[fake-agent] ${text}\n`);

/**
 * `images` turn var: "no images", or "N image(s): <mime> <bytes> B[ <file name>], ..."
 * (the byte count is the decoded size of `data`; the name is the last segment of `uri`).
 */
function describeImages(blocks) {
  const images = blocks.filter((b) => b && b.type === "image");
  if (images.length === 0) return "no images";
  const parts = images.map((b) => {
    const bytes = typeof b.data === "string" ? Buffer.from(b.data, "base64").length : 0;
    const name = typeof b.uri === "string" && b.uri ? ` ${decodeURIComponent(b.uri.split(/[\\/]/).pop() ?? "")}` : "";
    return `${b.mimeType} ${bytes} B${name}`;
  });
  return `${images.length} image(s): ${parts.join(", ")}`;
}

function loadRecording(name) {
  const file = join(recordingsDir, `${name}.json`);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? { steps: parsed } : parsed;
}

function substitute(value, vars) {
  if (typeof value === "string") {
    const whole = /^\{\{([\w.]+)\}\}$/.exec(value);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return value.replace(/\{\{([\w.]+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function partialMatch(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((e, i) => partialMatch(actual[i], e));
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => partialMatch(actual[k], v));
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function flattenOptions(options) {
  const out = [];
  for (const entry of options ?? []) {
    if (Array.isArray(entry.options)) out.push(...entry.options);
    else out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

let authenticated = !config.authRequired;
const sessions = new Map();
let sessionCounter = 0;
/**
 * Session ids never repeat across processes (the real CLI uses UUIDs): a
 * restarted agent must not hand out an id the previous process used. The
 * counter comes first, so the 12-character short id in terminal names stays
 * distinct per session.
 */
const sessionIdSuffix = `${process.pid.toString(36)}${Date.now().toString(36).slice(-3)}`;
let messageCounter = 0;
/** cwd reported for the canned past sessions: the first `session/new` cwd, else process.cwd(). */
let cannedCwdPinned = false;

const extensionMethods = ["_kiro/session/context", "_kiro/account/getUsage"];
/** Delay between accepting `_session/steer` and reporting `steering_injected` (lets tests observe the badge). */
const STEER_INJECT_DELAY_MS = 150;
/** While the `slow-steer` scenario runs, `_session/steer` fails only after this long (a late refusal, see D22). */
const SLOW_STEER_REFUSAL_MS = 1500;

/** Update kinds kept in the per-session history for `session/load` replay. */
const HISTORY_KINDS = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

function makeSession(id, cwd, extra = {}) {
  return {
    id,
    cwd,
    title: null,
    updatedAt: new Date().toISOString(),
    modes: makeModes(),
    configOptions: isV2 ? null : makeConfigOptions(),
    models: isV2 ? makeModels() : null,
    /** false for canned past sessions until `session/load` activates them. */
    live: true,
    history: [],
    turn: null,
    /** The `mcpServers` of the last `session/new` / `session/load`. */
    mcpServers: [],
    ...extra,
  };
}

function cannedHistory(id, cwd, question, file, answer) {
  const path = `${cwd}/${file}`;
  return [
    { sessionUpdate: "user_message_chunk", messageId: `u-${id}-1`, content: { type: "text", text: question } },
    { sessionUpdate: "agent_message_chunk", messageId: `a-${id}-1`, content: { type: "text", text: `Let me look at ${file}. ` } },
    {
      sessionUpdate: "tool_call",
      toolCallId: `call-${id}-read`,
      title: `Read ${file}`,
      kind: "read",
      status: "completed",
      locations: [{ path }],
      rawInput: { path },
      content: [{ type: "content", content: { type: "text", text: `Read ${file}` } }],
    },
    { sessionUpdate: "agent_message_chunk", messageId: `a-${id}-1`, content: { type: "text", text: answer } },
  ];
}

const CANNED_SESSIONS = [
  {
    id: "past-1",
    title: "Investigate flaky CI",
    updatedAt: "2026-11-09T10:00:00.000Z",
    question: "Why is CI flaky?",
    file: ".github/workflows/ci.yml",
    answer: "The test job has no retry and the network step times out.",
  },
  {
    id: "past-2",
    title: "Add retry to fetch",
    updatedAt: "2026-11-08T15:30:00.000Z",
    question: "Add a retry to the fetch helper.",
    file: "src/fetch.ts",
    answer: "I would wrap fetch in a loop with exponential backoff.",
  },
];

/** (Re)create the canned past sessions under `cwd`; sessions already loaded are left alone. */
function seedCannedSessions(cwd) {
  for (const entry of CANNED_SESSIONS) {
    if (sessions.get(entry.id)?.live) continue;
    sessions.set(
      entry.id,
      makeSession(entry.id, cwd, {
        title: entry.title,
        updatedAt: entry.updatedAt,
        live: false,
        history: cannedHistory(entry.id, cwd, entry.question, entry.file, entry.answer),
      }),
    );
  }
}

/** Point the canned sessions at the first real session cwd (once). */
function pinCannedCwd(cwd) {
  if (cannedCwdPinned) return;
  cannedCwdPinned = true;
  seedCannedSessions(cwd);
}

if (!isV2) seedCannedSessions(process.cwd());

function withReplayMeta(update) {
  const meta = update._meta && typeof update._meta === "object" ? update._meta : {};
  const kiro = meta.kiro && typeof meta.kiro === "object" ? meta.kiro : {};
  return { ...update, _meta: { ...meta, kiro: { ...kiro, replay: true } } };
}

function sessionInfo(session) {
  return { sessionId: session.id, cwd: session.cwd, title: session.title, updatedAt: session.updatedAt };
}

function makeModes() {
  return {
    currentModeId: "vibe",
    availableModes: [
      { id: "vibe", name: "Vibe", description: "Act directly" },
      { id: "plan", name: "Plan", description: "Plan before acting" },
    ],
  };
}

function makeConfigOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "claude-sonnet-4",
      options: [
        {
          group: "anthropic",
          name: "Anthropic",
          options: [
            { value: "claude-sonnet-4", name: "Claude Sonnet 4", description: "Balanced" },
            { value: "claude-opus-4", name: "Claude Opus 4", description: "Most capable" },
          ],
        },
        { group: "amazon", name: "Amazon", options: [{ value: "nova-pro", name: "Nova Pro" }] },
      ],
    },
    {
      id: "effortLevel",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
    { id: "autoCompact", name: "Auto compact", type: "boolean", currentValue: true },
  ];
}

function makeModels() {
  return {
    currentModelId: "claude-sonnet-4",
    availableModels: [
      { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
      { modelId: "claude-opus-4", name: "Claude Opus 4", description: "Most capable" },
    ],
  };
}

function authError() {
  return new acp.RequestError(-32000, "authentication required");
}

function requireAuth() {
  if (!authenticated) throw authError();
}

function requireSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.live) throw acp.RequestError.sessionNotFound(sessionId);
  return session;
}

/** The `mcpServers` param of `session/new` / `session/load` (`[]` when absent). */
function mcpServersOf(params) {
  return Array.isArray(params?.mcpServers) ? params.mcpServers : [];
}

/** "name (type url|command)" per server; header values are never included. */
function describeMcpServers(servers) {
  return servers
    .map((s) => {
      const type = s?.type ?? "stdio";
      const where = typeof s?.url === "string" ? s.url : typeof s?.command === "string" ? s.command : "?";
      return `${s?.name ?? "?"} (${type} ${where})`;
    })
    .join(", ");
}

function logMcpServers(method, sessionId, servers) {
  if (servers.length > 0) log(`${method} ${sessionId} mcpServers: ${describeMcpServers(servers)}`);
}

function announceCommands(ctx, session) {
  setTimeout(() => {
    if (isV2) {
      void ctx.client.notify("_kiro.dev/commands/available", {
        sessionId: session.id,
        commands: [
          { name: "help", description: "Show help" },
          { name: "context", description: "Manage context", hint: "add <file>" },
        ],
      });
    } else {
      void sendUpdate(ctx, session, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Create a plan", input: { hint: "goal" } },
          { name: "compact", description: "Compact the conversation" },
        ],
      });
    }
  }, 5);
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

async function report(ctx, session, text) {
  log(text);
  await ctx.client.notify(acp.methods.client.session.update, {
    sessionId: session.id,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[fake-agent] ${text}` } },
  });
}

async function sendUpdate(ctx, session, update) {
  if (HISTORY_KINDS.has(update?.sessionUpdate)) {
    session.history.push(update);
    session.updatedAt = new Date().toISOString();
  }
  // `_kiro/session/context` reports the last percentage a recording announced.
  const kiro = update?._meta?.kiro;
  if (update?.sessionUpdate === "session_info_update" && kiro?.kind === "context_usage" && typeof kiro.usagePercentage === "number") {
    session.contextPercent = kiro.usagePercentage;
  }
  await ctx.client.notify(acp.methods.client.session.update, { sessionId: session.id, update });
}

// ---------------------------------------------------------------------------
// MCP client (Streamable HTTP, stateless) for the `mcp_call` step
// ---------------------------------------------------------------------------

const MCP_CLIENT_PROTOCOL_VERSION = "2025-06-18";
let mcpCallCounter = 0;

/** A failed MCP exchange: `status` (HTTP), `code` (JSON-RPC), `message`, and the `stage` it failed at. */
class McpCallError extends Error {
  constructor(stage, message, { status, code } = {}) {
    super(message);
    this.stage = stage;
    this.status = status;
    this.code = code;
  }

  /** What `expectError` is matched against. */
  info() {
    const info = { message: this.message };
    if (this.status !== undefined) info.status = this.status;
    if (this.code !== undefined) info.code = this.code;
    return info;
  }

  describe() {
    const parts = [];
    if (this.status !== undefined && (this.status < 200 || this.status > 299)) parts.push(`HTTP ${this.status}`);
    if (this.code !== undefined) parts.push(`MCP error ${this.code}`);
    return `${parts.join(", ") || "MCP request failed"} at ${this.stage}: ${this.message}`;
  }
}

/** One JSON-RPC message out of an `application/json` or `text/event-stream` body (the one with `id`, else the first). */
function parseMcpBody(stage, contentType, body, id) {
  let messages;
  try {
    if (contentType.includes("text/event-stream")) {
      messages = body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice("data:".length).trim()));
    } else {
      messages = [JSON.parse(body)];
    }
  } catch (error) {
    throw new McpCallError(stage, `unparsable response body (${contentType || "no content type"}): ${error.message}`);
  }
  const message = messages.find((m) => m && m.id === id) ?? messages[0];
  if (!message || typeof message !== "object") throw new McpCallError(stage, "empty response body");
  return message;
}

/**
 * POST one JSON-RPC message to the MCP server. Returns the JSON-RPC response
 * for a request (`id` set) and null for a notification. Throws McpCallError on
 * an HTTP error, a JSON-RPC error or an unreadable body; an abort propagates.
 */
async function mcpPost(entry, state, stage, message, signal) {
  const headers = new Headers();
  for (const header of Array.isArray(entry.headers) ? entry.headers : []) {
    if (header && typeof header.name === "string") headers.set(header.name, String(header.value ?? ""));
  }
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  if (state.protocolVersion) headers.set("MCP-Protocol-Version", state.protocolVersion);
  if (state.sessionId) headers.set("Mcp-Session-Id", state.sessionId);
  let response;
  let body;
  try {
    response = await fetch(entry.url, { method: "POST", headers, body: JSON.stringify(message), signal });
    body = await response.text();
  } catch (error) {
    if (signal.aborted) throw error;
    const cause = error?.cause?.code ?? error?.cause?.message;
    throw new McpCallError(stage, `${error.message}${cause ? ` (${cause})` : ""}`, { status: response?.status });
  }
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) state.sessionId = sessionId;
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    // The body may carry a JSON-RPC error; otherwise its text (or the status text) is the message.
    let rpcError;
    try {
      rpcError = JSON.parse(body)?.error;
    } catch {
      rpcError = undefined;
    }
    if (rpcError && typeof rpcError === "object") {
      throw new McpCallError(stage, String(rpcError.message ?? ""), { status: response.status, code: rpcError.code });
    }
    throw new McpCallError(stage, body.trim().slice(0, 500) || response.statusText, { status: response.status });
  }
  if (message.id === undefined) {
    if (response.status !== 202 && response.status !== 200) {
      throw new McpCallError(stage, `expected HTTP 202 for a notification, got ${response.status}`, { status: response.status });
    }
    return null;
  }
  const reply = parseMcpBody(stage, contentType, body, message.id);
  if (reply.error) {
    throw new McpCallError(stage, String(reply.error.message ?? ""), { status: response.status, code: reply.error.code });
  }
  if (!("result" in reply)) throw new McpCallError(stage, "response has neither result nor error", { status: response.status });
  return reply.result;
}

/** initialize → notifications/initialized → tools/call; resolves with the CallToolResult. */
async function mcpToolCall(entry, tool, args, signal) {
  const state = { protocolVersion: null, sessionId: null };
  const init = await mcpPost(
    entry,
    state,
    "initialize",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "fake-kiro", version: AGENT_VERSION },
      },
    },
    signal,
  );
  state.protocolVersion = typeof init?.protocolVersion === "string" ? init.protocolVersion : MCP_CLIENT_PROTOCOL_VERSION;
  await mcpPost(entry, state, "notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" }, signal);
  const result = await mcpPost(
    entry,
    state,
    "tools/call",
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
    signal,
  );
  if (!result || typeof result !== "object") throw new McpCallError("tools/call", "tools/call result is not an object");
  return result;
}

/** The text blocks of a CallToolResult, joined by newlines. */
function toolResultText(result) {
  return (Array.isArray(result.content) ? result.content : [])
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** The `mcp_call` step (see the header comment). */
async function runMcpCall(ctx, session, turn, step) {
  const label = `${step.server}/${step.tool}`;
  const entry = session.mcpServers.find((s) => s && s.name === step.server && s.type === "http");
  if (!entry) {
    turn.vars["mcp.status"] = "missing";
    turn.vars["mcp.text"] = `no http MCP server named '${step.server}'`;
    if (!step.optional) {
      const names = session.mcpServers.map((s) => s?.name).join(", ") || "none";
      await report(ctx, session, `mcp_call ${label}: no http MCP server named '${step.server}' in this session (servers: ${names})`);
    }
    return;
  }
  const args = step.arguments ?? {};
  const toolCallId = step.toolCallId ?? `mcp-${++mcpCallCounter}`;
  await sendUpdate(ctx, session, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: label,
    kind: "other",
    status: "in_progress",
    rawInput: args,
  });
  let result;
  try {
    result = await mcpToolCall(entry, step.tool, args, turn.signal);
  } catch (error) {
    if (turn.signal.aborted) {
      log(`mcp_call ${label} at ${entry.url} -> cancelled`);
      turn.vars["mcp.status"] = "failed";
      turn.vars["mcp.text"] = "cancelled";
      await sendUpdate(ctx, session, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        _meta: { kiro: { failureReason: "cancelled" } },
      });
      return;
    }
    const failure = error instanceof McpCallError ? error : new McpCallError("tools/call", String(error?.message ?? error));
    const text = failure.describe();
    log(`mcp_call ${label} at ${entry.url} -> ${text}`);
    turn.vars["mcp.status"] = "failed";
    turn.vars["mcp.text"] = text;
    await sendUpdate(ctx, session, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [{ type: "content", content: { type: "text", text } }],
      rawOutput: { error: failure.info() },
    });
    if (step.expectError) {
      if (!partialMatch(failure.info(), step.expectError)) {
        await report(ctx, session, `expected error ${JSON.stringify(step.expectError)} for mcp_call ${label} but got ${JSON.stringify(failure.info())}`);
      }
    } else if (!step.optional) {
      await report(ctx, session, `mcp_call ${label} failed: ${text}`);
    }
    return;
  }
  const text = toolResultText(result);
  const status = result.isError === true ? "failed" : "completed";
  log(`mcp_call ${label} at ${entry.url} -> ${status}`);
  turn.vars["mcp.status"] = status;
  turn.vars["mcp.text"] = text;
  if (step.save) {
    for (const [name, path] of Object.entries(step.save)) turn.vars[name] = getPath(result, path);
  }
  await sendUpdate(ctx, session, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status,
    content: [{ type: "content", content: { type: "text", text } }],
    rawOutput: result,
  });
  if (step.expectError) {
    await report(ctx, session, `expected mcp_call ${label} to fail with ${JSON.stringify(step.expectError)} but it succeeded`);
  }
  if (step.expect && !partialMatch(result, step.expect)) {
    await report(ctx, session, `expectation failed for mcp_call ${label}: got ${JSON.stringify(result)}`);
  }
}

/** Returns a PromptResponse to end the turn, or null to continue. */
async function runSteps(ctx, session, turn, steps) {
  for (const rawStep of steps ?? []) {
    if (turn.cancelled) return { stopReason: "cancelled" };
    const step = substitute(rawStep, turn.vars);
    switch (step.kind) {
      case "update":
        await sendUpdate(ctx, session, step.update);
        break;
      case "notify":
        await ctx.client.notify(step.method, step.params);
        break;
      case "delay":
        await sleep(step.ms ?? 10, turn.signal);
        break;
      case "hang":
        // A stuck agent: the prompt never answers, not even after session/cancel.
        await new Promise(() => {});
        break;
      case "delay_uncancellable":
        // An agent that honours session/cancel only after its current wait (a late answer).
        await new Promise((resolve) => setTimeout(resolve, step.ms ?? 1000));
        break;
      case "stderr":
        process.stderr.write(`${step.text}\n`);
        break;
      case "mcp_call":
        await runMcpCall(ctx, session, turn, step);
        break;
      case "stop":
        return { stopReason: step.stopReason ?? "end_turn" };
      case "exit":
        process.stdout.write("", () => process.exit(step.code ?? 1));
        await sleep(5000, turn.signal);
        return { stopReason: "end_turn" };
      case "repeat": {
        const times = Number(step.times ?? 1);
        for (let i = 0; i < times; i++) {
          turn.vars.i = i;
          const result = await runSteps(ctx, session, turn, rawStep.steps);
          if (result) return result;
          if (turn.cancelled) return { stopReason: "cancelled" };
        }
        break;
      }
      case "client_request": {
        try {
          const result = await ctx.client.request(step.method, step.params);
          if (step.expectError) {
            await report(ctx, session, `expected ${step.method} to fail with ${JSON.stringify(step.expectError)} but it succeeded`);
          }
          if (step.expect && !partialMatch(result, step.expect)) {
            await report(ctx, session, `expectation failed for ${step.method}: got ${JSON.stringify(result)}`);
          }
          if (step.save) {
            for (const [name, path] of Object.entries(step.save)) turn.vars[name] = getPath(result, path);
          }
        } catch (error) {
          if (step.expectError) {
            if (!partialMatch({ code: error.code, message: error.message }, step.expectError)) {
              await report(ctx, session, `expected error ${JSON.stringify(step.expectError)} for ${step.method} but got ${error.code}: ${error.message}`);
            }
          } else if (!step.optional) {
            await report(ctx, session, `request ${step.method} failed: ${error.message}`);
          }
        }
        break;
      }
      case "permission": {
        const toolCallId = step.toolCall?.toolCallId;
        const request = { sessionId: session.id, toolCall: step.toolCall, options: step.options ?? [] };
        if (step.meta) request._meta = step.meta;
        const response = await ctx.client.request(acp.methods.client.session.requestPermission, request);
        const outcome = response?.outcome ?? { outcome: "cancelled" };
        if (outcome.outcome === "cancelled") {
          await sendUpdate(ctx, session, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            _meta: { kiro: { failureReason: "cancelled" } },
          });
          return { stopReason: "cancelled" };
        }
        const option = (step.options ?? []).find((o) => o.optionId === outcome.optionId);
        if (!option) {
          await report(ctx, session, `permission answered with unknown optionId ${outcome.optionId}`);
        }
        const allowed = option ? option.kind === "allow_once" || option.kind === "allow_always" : false;
        if (allowed) {
          const result = await runSteps(ctx, session, turn, step.allow);
          if (result) return result;
          await sendUpdate(ctx, session, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
        } else {
          const result = await runSteps(ctx, session, turn, step.reject);
          if (result) return result;
          await sendUpdate(ctx, session, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            _meta: { kiro: { failureReason: "denied" } },
          });
        }
        break;
      }
      default:
        await report(ctx, session, `unknown step kind ${String(step.kind)}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Agent app
// ---------------------------------------------------------------------------

const app = acp
  .agent({ name: "fake-kiro" })
  .onRequest(acp.methods.agent.initialize, (ctx) => {
    const agentCapabilities = {
      loadSession: !isV2,
      promptCapabilities: config.image ? { image: true, embeddedContext: true } : { embeddedContext: true },
      sessionCapabilities: isV2 ? {} : { list: {} },
    };
    if (!isV2) {
      agentCapabilities.mcpCapabilities = config.mcpHttp ? { http: true, sse: true } : { sse: true };
      agentCapabilities._meta = { kiro: { extensionMethods } };
    }
    const response = {
      protocolVersion: Math.min(ctx.params.protocolVersion ?? acp.PROTOCOL_VERSION, acp.PROTOCOL_VERSION),
      agentCapabilities,
      agentInfo: { name: "fake-kiro", title: "Fake Kiro", version: AGENT_VERSION },
      authMethods: [],
    };
    if (config.authAgentMethods) {
      response.authMethods = [
        { id: "aws-builder-id", name: "AWS Builder ID" },
        { id: "aws-iam-identity-center", name: "AWS IAM Identity Center" },
      ];
    } else if (config.authRequired) {
      const terminalAuth =
        ctx.params.clientCapabilities?.auth?.terminal === true ||
        ctx.params.clientCapabilities?._meta?.["terminal-auth"] === true;
      response.authMethods = terminalAuth
        ? [{ id: "kiro-login", name: "Log in to Kiro", type: "terminal", args: ["--login"] }]
        : [{ id: "kiro-login-manual", name: "Run `kiro-cli login`", description: "Sign in from a terminal" }];
    }
    return response;
  })
  .onRequest(acp.methods.agent.authenticate, () => {
    if (config.authAgentMethods) {
      throw new acp.RequestError(
        -32603,
        "Auth refresh callback failed: Internal error: You are not logged in. Please log in with `kiro-cli login`.",
      );
    }
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    requireAuth();
    const mcpServers = mcpServersOf(ctx.params);
    // A strict agent: an http server it did not advertise support for is refused.
    const unsupported = mcpServers.filter((s) => s?.type === "http");
    if (!mcpHttpAdvertised && unsupported.length > 0) {
      log(`session/new refused: http MCP servers are not supported: ${describeMcpServers(unsupported)}`);
      throw acp.RequestError.invalidParams(
        undefined,
        `http MCP servers are not supported (mcpCapabilities.http is not advertised): ${unsupported.map((s) => s.name).join(", ")}`,
      );
    }
    const id = `sess-${++sessionCounter}-${sessionIdSuffix}`;
    if (!isV2) pinCannedCwd(ctx.params.cwd);
    const session = makeSession(id, ctx.params.cwd, { mcpServers });
    sessions.set(id, session);
    logMcpServers("session/new", id, mcpServers);
    const response = { sessionId: id, modes: session.modes, _meta: { kiro: { engine: config.engine } } };
    if (session.configOptions) response.configOptions = session.configOptions;
    if (session.models) response.models = session.models;
    announceCommands(ctx, session);
    return response;
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    requireAuth();
    const session = requireSession(ctx.params.sessionId);
    const blocks = ctx.params.prompt ?? [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const imageBlocks = blocks.filter((b) => b && b.type === "image");
    let scenario = config.scenario;
    const selector = /^\/scenario\s+([\w-]+)/.exec(text.trim());
    if (selector) scenario = selector[1];
    else if (!text.trim() && imageBlocks.length > 0) scenario = "images";
    // Signed-in agent whose token expired: the real CLI accepts session/new and
    // rejects the prompt with this message (no authMethods were advertised).
    if (scenario === "auth-expired") {
      throw new acp.RequestError(
        -32603,
        "Auth refresh callback failed: Internal error: You are not logged in. Please log in with `kiro-cli login`.",
      );
    }

    // Remember the user turn (not echoed live; replayed by session/load), images included.
    const userMessageId = `u-${++messageCounter}`;
    session.history.push({
      sessionUpdate: "user_message_chunk",
      messageId: userMessageId,
      content: { type: "text", text },
    });
    for (const image of imageBlocks) {
      session.history.push({ sessionUpdate: "user_message_chunk", messageId: userMessageId, content: image });
    }
    session.updatedAt = new Date().toISOString();
    if (!session.title) session.title = text.trim().slice(0, 40) || null;

    const abort = new AbortController();
    const vars = {
      cwd: session.cwd,
      sessionId: session.id,
      images: describeImages(blocks),
      blockTypes: blocks.map((b) => b?.type ?? "?").join(","),
    };
    const turn = { scenario, cancelled: false, signal: abort.signal, abort, vars };
    session.turn = turn;
    try {
      const recording = loadRecording(scenario);
      if (!recording) {
        await report(ctx, session, `unknown scenario '${scenario}'`);
        return { stopReason: "end_turn" };
      }
      const result = await runSteps(ctx, session, turn, recording.steps);
      if (result) return result;
      return { stopReason: turn.cancelled ? "cancelled" : "end_turn" };
    } finally {
      if (session.turn === turn) session.turn = null;
    }
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (session?.turn) {
      session.turn.cancelled = true;
      session.turn.abort.abort();
    }
  })
  .onRequest(acp.methods.agent.session.setMode, async (ctx) => {
    requireAuth();
    const session = requireSession(ctx.params.sessionId);
    if (!session.modes.availableModes.some((m) => m.id === ctx.params.modeId)) {
      throw acp.RequestError.invalidParams(undefined, `unknown mode ${ctx.params.modeId}`);
    }
    session.modes.currentModeId = ctx.params.modeId;
    await sendUpdate(ctx, session, { sessionUpdate: "current_mode_update", currentModeId: ctx.params.modeId });
    return {};
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    requireAuth();
    const session = requireSession(ctx.params.sessionId);
    const option = (session.configOptions ?? []).find((o) => o.id === ctx.params.configId);
    if (!option) throw acp.RequestError.invalidParams(undefined, `unknown config option ${ctx.params.configId}`);
    if (option.type === "boolean") {
      option.currentValue = Boolean(ctx.params.value);
    } else {
      if (!flattenOptions(option.options).some((o) => o.value === ctx.params.value)) {
        throw acp.RequestError.invalidParams(undefined, `unknown value ${ctx.params.value}`);
      }
      option.currentValue = ctx.params.value;
    }
    return { configOptions: session.configOptions };
  });

if (isV2) {
  app.onRequest(
    "session/set_model",
    (params) => params,
    (ctx) => {
      requireAuth();
      const session = requireSession(ctx.params?.sessionId);
      if (!session.models.availableModels.some((m) => m.modelId === ctx.params.modelId)) {
        throw acp.RequestError.invalidParams(undefined, `unknown model ${ctx.params.modelId}`);
      }
      session.models.currentModelId = ctx.params.modelId;
      return {};
    },
  );
} else {
  app.onRequest(acp.methods.agent.session.list, (ctx) => {
    requireAuth();
    const filterCwd = typeof ctx.params?.cwd === "string" ? ctx.params.cwd : null;
    const all = [...sessions.values()].filter((s) => filterCwd === null || s.cwd === filterCwd);
    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    // Paginated like a real agent: `cursor` is opaque to the client (here the
    // start index as a string); `nextCursor` is null on the last page.
    const start = typeof ctx.params?.cursor === "string" ? Number.parseInt(ctx.params.cursor, 10) : 0;
    if (!Number.isInteger(start) || start < 0 || (start > 0 && start >= all.length)) {
      throw acp.RequestError.invalidParams(undefined, `unknown cursor ${ctx.params?.cursor}`);
    }
    const end = Math.min(start + config.listPageSize, all.length);
    const page = all.slice(start, end);
    return { sessions: page.map(sessionInfo), nextCursor: end < all.length ? String(end) : null };
  });
  app.onRequest(acp.methods.agent.session.load, async (ctx) => {
    requireAuth();
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw new acp.RequestError(-32002, `session not found: ${ctx.params.sessionId}`);
    // Kiro V3 expects cwd/mcpServers to be resent on load; the cwd and the servers win.
    session.cwd = ctx.params.cwd;
    session.mcpServers = mcpServersOf(ctx.params);
    session.live = true;
    logMcpServers("session/load", session.id, session.mcpServers);
    for (const update of session.history) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: withReplayMeta(update),
      });
    }
    announceCommands(ctx, session);
    return { modes: session.modes, configOptions: session.configOptions };
  });
  app.onRequest(
    "_kiro/session/context",
    (params) => params,
    (ctx) => {
      requireAuth();
      // The real reply shape is unknown; the extension reads it defensively
      // (nested keys). 7% is what a session that never announced a
      // `context_usage` reports.
      const session = sessions.get(ctx.params?.sessionId);
      const usagePercentage = session?.contextPercent ?? 7;
      // `calls` lets a test count the polls (one after a turn without a percentage, then none).
      if (session) session.contextCalls = (session.contextCalls ?? 0) + 1;
      return {
        ok: true,
        echoed: ctx.params,
        calls: session?.contextCalls ?? 0,
        contextWindow: { usagePercentage, contextWindowSize: 200000 },
      };
    },
  );
  app.onRequest(
    "_kiro/account/getUsage",
    (params) => params,
    () => {
      requireAuth();
      return { ok: true, usage: { used: 12, limit: 100 } };
    },
  );
  // Steering (V3 only): `{ sessionId, prompt: ContentBlock[] }` while a turn
  // runs is accepted at once; a little later (like the real CLI, which injects
  // at the next model round trip) the session reports `steering_injected` and
  // the running turn answers with `Steered: <text>`. Without a turn: -32602.
  // During the `slow-steer` scenario the request is refused instead, but only
  // after SLOW_STEER_REFUSAL_MS — whether or not the turn was cancelled
  // meanwhile — so the client sees a refusal for a turn that already ended.
  app.onRequest(
    "_session/steer",
    (params) => params,
    async (ctx) => {
      requireAuth();
      const session = requireSession(ctx.params?.sessionId);
      const turn = session.turn;
      if (!turn) throw acp.RequestError.invalidParams(undefined, "no active turn to steer");
      if (turn.scenario === "slow-steer") {
        log(`steer for ${session.id} will be refused in ${SLOW_STEER_REFUSAL_MS} ms (slow-steer)`);
        await sleep(SLOW_STEER_REFUSAL_MS);
        throw acp.RequestError.invalidParams(undefined, "steer refused (slow-steer scenario)");
      }
      const steerBlocks = ctx.params.prompt ?? [];
      const text = steerBlocks
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join("\n");
      // Steered images are reported like a turn's (`describeImages`), so a test can see them arrive.
      const steeredImages = steerBlocks.some((b) => b && b.type === "image") ? ` [${describeImages(steerBlocks)}]` : "";
      log(`steer accepted for ${session.id}: ${JSON.stringify(text)}${steeredImages}`);
      setTimeout(() => {
        if (session.turn !== turn || turn.cancelled) {
          void sendUpdate(ctx, session, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "steering_cleared" } } });
          return;
        }
        void (async () => {
          await sendUpdate(ctx, session, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "steering_injected" } } });
          await sendUpdate(ctx, session, {
            sessionUpdate: "agent_message_chunk",
            messageId: `steer-${++messageCounter}`,
            content: { type: "text", text: `Steered: ${text}${steeredImages}` },
          });
        })();
      }, STEER_INJECT_DELAY_MS);
      return {};
    },
  );
}

const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
void connection.closed.then(() => process.exit(0));
process.stdin.on("end", () => process.exit(0));
