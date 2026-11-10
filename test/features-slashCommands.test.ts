import { test } from "node:test";
import assert from "node:assert/strict";

import {
  builtinCommands,
  describeOptions,
  formatExtensionResult,
  mergeCommands,
  parseSlash,
  routeSlash,
  type SlashContext,
} from "../src/features/pure/slashCommands.js";

const v3: SlashContext = {
  extensionMethods: ["_kiro/account/getUsage", "_kiro/session/context"],
  modes: {
    currentModeId: "vibe",
    availableModes: [
      { id: "vibe", name: "Autonomous" },
      { id: "plan", name: "Plan" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "auto",
      options: [
        { value: "auto", name: "Auto" },
        { value: "claude-sonnet", name: "Claude Sonnet" },
      ],
    },
    {
      id: "effortLevel",
      name: "Effort",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ],
  agentCommands: [{ name: "review", description: "Custom prompt" }],
};

const bare: SlashContext = { extensionMethods: [], modes: null, configOptions: [], agentCommands: [] };

test("parseSlash splits name and args, ignores non-commands", () => {
  assert.deepEqual(parseSlash("/clear"), { name: "clear", args: "" });
  assert.deepEqual(parseSlash("  /Plan  build a REST API "), { name: "plan", args: "build a REST API" });
  assert.equal(parseSlash("hello /clear"), null);
  assert.equal(parseSlash("/"), null);
});

test("session commands are client-side", () => {
  assert.deepEqual(routeSlash(parseSlash("/clear")!, bare), { kind: "new_session" });
  assert.deepEqual(routeSlash(parseSlash("/new")!, bare), { kind: "new_session" });
  assert.deepEqual(routeSlash(parseSlash("/cancel")!, bare), { kind: "cancel" });
  assert.deepEqual(routeSlash(parseSlash("/restart")!, bare), { kind: "restart" });
  const help = routeSlash(parseSlash("/help")!, bare);
  assert.equal(help.kind, "help");
  if (help.kind === "help") {
    assert.deepEqual(
      help.unavailable.map((u) => u.name),
      ["usage", "context", "compact", "effort", "model"],
    );
  }
  const helpV3 = routeSlash(parseSlash("/help")!, v3);
  if (helpV3.kind === "help") {
    assert.deepEqual(helpV3.unavailable.map((u) => u.name), ["compact"]);
  }
});

test("extension-backed commands are gated on the advertised method list", () => {
  assert.deepEqual(routeSlash(parseSlash("/usage")!, v3), {
    kind: "extension",
    method: "_kiro/account/getUsage",
    label: "usage",
  });
  const compact = routeSlash(parseSlash("/compact")!, v3);
  assert.equal(compact.kind, "unavailable");
  assert.equal(routeSlash(parseSlash("/usage")!, bare).kind, "unavailable");
});

test("/model and /effort map to config options, listing values when the argument is missing or wrong", () => {
  assert.deepEqual(routeSlash(parseSlash("/model claude-sonnet")!, v3), {
    kind: "set_config",
    configId: "model",
    value: "claude-sonnet",
  });
  // Matching by display name is accepted too.
  assert.deepEqual(routeSlash(parseSlash("/model Auto")!, v3), { kind: "set_config", configId: "model", value: "auto" });
  assert.deepEqual(routeSlash(parseSlash("/model")!, v3), { kind: "show_options", configId: "model" });
  assert.deepEqual(routeSlash(parseSlash("/model gpt-9")!, v3), { kind: "show_options", configId: "model" });
  assert.deepEqual(routeSlash(parseSlash("/effort high")!, v3), {
    kind: "set_config",
    configId: "effortLevel",
    value: "high",
  });
  assert.equal(routeSlash(parseSlash("/model x")!, bare).kind, "unavailable");
});

test("/mode, /agent and /plan use session modes", () => {
  assert.deepEqual(routeSlash(parseSlash("/mode plan")!, v3), { kind: "set_mode", modeId: "plan" });
  assert.deepEqual(routeSlash(parseSlash("/agent Autonomous")!, v3), { kind: "set_mode", modeId: "vibe" });
  assert.deepEqual(routeSlash(parseSlash("/mode")!, v3), { kind: "show_options" });
  assert.deepEqual(routeSlash(parseSlash("/plan add tests")!, v3), { kind: "plan", text: "add tests", modeId: "plan" });
  assert.deepEqual(routeSlash(parseSlash("/plan")!, bare), { kind: "plan", text: "", modeId: null });
});

test("agent-advertised and unknown commands are forwarded to the agent", () => {
  assert.deepEqual(routeSlash(parseSlash("/review src")!, v3), { kind: "forward" });
  assert.deepEqual(routeSlash(parseSlash("/frobnicate")!, v3), { kind: "forward" });
});

test("builtinCommands and mergeCommands reflect capabilities and keep agent commands first", () => {
  const names = builtinCommands(v3).map((c) => c.name);
  assert.deepEqual(names, ["clear", "help", "mode", "plan", "model", "effort", "usage", "context", "cancel", "restart"]);
  assert.deepEqual(
    builtinCommands(bare).map((c) => c.name),
    ["clear", "help", "cancel", "restart"],
  );
  const merged = mergeCommands([{ name: "clear", description: "agent's own clear" }, ...v3.agentCommands], v3);
  assert.equal(merged[0].description, "agent's own clear");
  assert.equal(merged.filter((c) => c.name === "clear").length, 1);
  assert.ok(merged.some((c) => c.name === "review"));
});

test("describeOptions and formatExtensionResult produce readable text", () => {
  const text = describeOptions(v3);
  assert.match(text, /Modes \(current: vibe\): vibe \(Autonomous\), plan \(Plan\)/);
  assert.match(text, /model \(current: auto\): auto \(Auto\), claude-sonnet \(Claude Sonnet\)/);
  assert.equal(describeOptions(bare), "The agent did not advertise any options.");
  assert.equal(formatExtensionResult("plain"), "plain");
  assert.equal(formatExtensionResult({ used: 1 }), '```json\n{\n  "used": 1\n}\n```');
  assert.equal(formatExtensionResult(undefined), "(no result)");
});
