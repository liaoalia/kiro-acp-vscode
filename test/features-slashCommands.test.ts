import { test } from "node:test";
import assert from "node:assert/strict";

import {
  builtinCommands,
  describeOptions,
  findExtension,
  formatExtensionResult,
  mergeCommands,
  parseSlash,
  routeSlash,
  unavailableCommands,
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
  assert.deepEqual(routeSlash(parseSlash("/login")!, bare), { kind: "login" });
  const help = routeSlash(parseSlash("/help")!, bare);
  assert.equal(help.kind, "help");
  if (help.kind === "help") {
    assert.deepEqual(
      help.unavailable.map((u) => u.name),
      ["usage", "context", "compact", "effort", "model"],
    );
  }
  const helpV3 = routeSlash(parseSlash("/help")!, v3);
  assert.equal(helpV3.kind, "help");
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

test("extension-backed commands match advertised methods by pattern, not by exact name", () => {
  const renamed: SlashContext = {
    ...bare,
    extensionMethods: ["_kiro/Quota/get", "_kiro/session/summarize", "_kiro/other/Context", "_kiro/contextual/thing"],
  };
  assert.deepEqual(routeSlash(parseSlash("/usage")!, renamed), {
    kind: "extension",
    method: "_kiro/Quota/get",
    label: "usage",
  });
  assert.deepEqual(routeSlash(parseSlash("/compact")!, renamed), {
    kind: "extension",
    method: "_kiro/session/summarize",
    label: "compact",
  });
  // `context` must end the name (or be `session/context`); `_kiro/contextual/thing` does not qualify.
  assert.deepEqual(routeSlash(parseSlash("/context")!, renamed), {
    kind: "extension",
    method: "_kiro/other/Context",
    label: "context",
  });
  assert.equal(findExtension({ ...bare, extensionMethods: ["_kiro/contextual/thing"] }, "context"), undefined);
  assert.equal(findExtension({ ...bare, extensionMethods: ["_kiro/account/getCredits"] }, "usage"), "_kiro/account/getCredits");
  assert.deepEqual(
    builtinCommands(renamed).map((c) => c.name),
    ["clear", "help", "capabilities", "usage", "context", "compact", "cancel", "restart", "login"],
  );
  assert.deepEqual(unavailableCommands(renamed).map((u) => u.name), ["effort", "model"]);
  const help = routeSlash(parseSlash("/help")!, bare);
  assert.equal(help.kind, "help");
  if (help.kind === "help") {
    assert.match(help.unavailable.find((u) => u.name === "usage")!.reason, /usage extension method/);
  }
});

test("/capabilities and /caps are answered locally by the controller", () => {
  assert.deepEqual(routeSlash(parseSlash("/capabilities")!, bare), { kind: "capabilities" });
  assert.deepEqual(routeSlash(parseSlash("/caps extra")!, v3), { kind: "capabilities" });
  assert.ok(builtinCommands(bare).some((c) => c.name === "capabilities"));
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
  assert.deepEqual(names, [
    "clear",
    "help",
    "capabilities",
    "mode",
    "plan",
    "model",
    "effort",
    "usage",
    "context",
    "cancel",
    "restart",
    "login",
  ]);
  assert.deepEqual(
    builtinCommands(bare).map((c) => c.name),
    ["clear", "help", "capabilities", "cancel", "restart", "login"],
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
