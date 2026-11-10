#!/usr/bin/env node
/**
 * Fake Kiro ACP agent for tests and manual runs.
 *
 * Speaks ACP over stdio with the official SDK and replays recordings from
 * `test/recordings/<scenario>.json` when it receives `session/prompt`.
 *
 * Usage:
 *   node test/fake-agent/agent.mjs [acp] [--scenario <name>] [--auth-required] [--engine v2|v3]
 *
 * A leading `acp` argument is ignored so the extension can be pointed at it
 * with `kiroAcp.cliPath = "node"` and `cliArgs = ["<path>/agent.mjs", ...]`.
 * A prompt whose text starts with `/scenario <name>` selects that recording
 * for the turn instead of the launch scenario.
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
 *   { "kind": "stderr", "text": "..." }
 *   { "kind": "repeat", "times": 40, "steps": [ ...steps using {{i}}... ] }
 *   { "kind": "exit", "code": 3 }          -> the process exits mid-turn
 *   { "kind": "stop", "stopReason": "end_turn" }
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
if (argv[0] === "acp") argv.shift();
const config = { scenario: "tour", authRequired: false, engine: "v3" };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--scenario") config.scenario = argv[++i] ?? config.scenario;
  else if (arg.startsWith("--scenario=")) config.scenario = arg.slice("--scenario=".length);
  else if (arg === "--auth-required") config.authRequired = true;
  else if (arg === "--engine") config.engine = argv[++i] ?? config.engine;
  else if (arg.startsWith("--engine=")) config.engine = arg.slice("--engine=".length);
  else if (arg.startsWith("--agent-engine=")) config.engine = arg.slice("--agent-engine=".length);
}
const isV2 = config.engine === "v2";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (text) => process.stderr.write(`[fake-agent] ${text}\n`);

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

const extensionMethods = ["_kiro/session/context", "_kiro/account/getUsage"];

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
  if (!session) throw acp.RequestError.sessionNotFound(sessionId);
  return session;
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
  await ctx.client.notify(acp.methods.client.session.update, { sessionId: session.id, update });
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
      case "stderr":
        process.stderr.write(`${step.text}\n`);
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
      loadSession: false,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: {},
    };
    if (!isV2) agentCapabilities._meta = { kiro: { extensionMethods } };
    const response = {
      protocolVersion: Math.min(ctx.params.protocolVersion ?? acp.PROTOCOL_VERSION, acp.PROTOCOL_VERSION),
      agentCapabilities,
      agentInfo: { name: "fake-kiro", title: "Fake Kiro", version: isV2 ? "2.0.0-fake" : "3.0.0-fake" },
      authMethods: [],
    };
    if (config.authRequired) {
      const terminalAuth =
        ctx.params.clientCapabilities?.auth?.terminal === true ||
        ctx.params.clientCapabilities?._meta?.["terminal-auth"] === true;
      response.authMethods = terminalAuth
        ? [{ id: "kiro-login", name: "Log in to Kiro", type: "terminal", args: ["login"] }]
        : [{ id: "kiro-login-manual", name: "Run `kiro-cli login`", description: "Sign in from a terminal" }];
    }
    return response;
  })
  .onRequest(acp.methods.agent.authenticate, () => {
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    requireAuth();
    const id = `sess-${++sessionCounter}`;
    const session = {
      id,
      cwd: ctx.params.cwd,
      modes: makeModes(),
      configOptions: isV2 ? null : makeConfigOptions(),
      models: isV2 ? makeModels() : null,
      turn: null,
    };
    sessions.set(id, session);
    const response = { sessionId: id, modes: session.modes, _meta: { kiro: { engine: config.engine } } };
    if (session.configOptions) response.configOptions = session.configOptions;
    if (session.models) response.models = session.models;
    setTimeout(() => {
      if (isV2) {
        void ctx.client.notify("_kiro.dev/commands/available", {
          sessionId: id,
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
    return response;
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    requireAuth();
    const session = requireSession(ctx.params.sessionId);
    const text = (ctx.params.prompt ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    let scenario = config.scenario;
    const selector = /^\/scenario\s+([\w-]+)/.exec(text.trim());
    if (selector) scenario = selector[1];

    const abort = new AbortController();
    const turn = { cancelled: false, signal: abort.signal, abort, vars: { cwd: session.cwd, sessionId: session.id } };
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
  app.onRequest(
    "_kiro/session/context",
    (params) => params,
    (ctx) => {
      requireAuth();
      return { ok: true, echoed: ctx.params };
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
}

const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
void connection.closed.then(() => process.exit(0));
process.stdin.on("end", () => process.exit(0));
