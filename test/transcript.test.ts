import { test } from "node:test";
import assert from "node:assert/strict";
import type * as acp from "@agentclientprotocol/sdk";
import {
  applyUpdate,
  applyUpdates,
  createTranscript,
  snapshotToUiState,
  toConfigOptionViews,
  withSessionSnapshot,
} from "../src/features/pure/transcript.js";

function chunk(
  kind: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
  text: string,
  messageId?: string,
): acp.SessionUpdate {
  return { sessionUpdate: kind, content: { type: "text", text }, ...(messageId ? { messageId } : {}) };
}

test("consecutive chunks with the same messageId merge into one message", () => {
  const { state, emits } = applyUpdates(createTranscript(), [
    chunk("agent_message_chunk", "Hello ", "m1"),
    chunk("agent_message_chunk", "world", "m1"),
    chunk("agent_message_chunk", "!"),
  ]);
  assert.equal(state.items.length, 1);
  const item = state.items[0];
  assert.ok(item && item.type === "message");
  assert.equal(item.message.role, "agent");
  assert.deepEqual(item.message.segments, [{ type: "text", text: "Hello world!" }]);
  assert.equal(emits.length, 3);
  assert.ok(emits.every((e) => e.type === "chunk" && e.messageId === item.message.id));
});

test("a new messageId, a role change or an intervening tool call start a new message", () => {
  const { state } = applyUpdates(createTranscript(), [
    chunk("agent_message_chunk", "one", "m1"),
    chunk("agent_message_chunk", "two", "m2"),
    chunk("agent_thought_chunk", "thinking"),
    chunk("agent_message_chunk", "three"),
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", kind: "read", status: "in_progress" },
    chunk("agent_message_chunk", "four"),
    chunk("user_message_chunk", "me"),
  ]);
  const roles = state.items.map((i) => (i.type === "message" ? i.message.role : "tool"));
  assert.deepEqual(roles, ["agent", "agent", "thought", "agent", "tool", "agent", "user"]);
  const first = state.items[0];
  assert.ok(first && first.type === "message");
  assert.deepEqual(first.message.segments, [{ type: "text", text: "one" }]);
});

test("non-text content blocks become resource/image segments", () => {
  const { state } = applyUpdates(createTranscript(), [
    {
      sessionUpdate: "user_message_chunk",
      content: { type: "resource_link", uri: "file:///a.ts", name: "a.ts" },
    },
    { sessionUpdate: "user_message_chunk", content: { type: "image", data: "", mimeType: "image/png" } },
  ]);
  const item = state.items[0];
  assert.ok(item && item.type === "message");
  assert.deepEqual(item.message.segments, [
    { type: "resource", uri: "file:///a.ts", label: "a.ts" },
    { type: "image", mimeType: "image/png" },
  ]);
});

test("tool_call maps content (text, diff, terminal, non-text) and locations", () => {
  const { state, emits } = applyUpdate(createTranscript(), {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Edit file",
    kind: "edit",
    locations: [{ path: "/w/a.ts", line: 3 }, { path: "/w/b.ts" }],
    content: [
      { type: "content", content: { type: "text", text: "hello" } },
      { type: "content", content: { type: "image", data: "", mimeType: "image/png" } },
      { type: "diff", path: "/w/a.ts", oldText: null, newText: "new" },
      { type: "diff", path: "/w/b.ts", newText: "b" },
      { type: "terminal", terminalId: "term-1" },
    ],
    rawInput: { path: "/w/a.ts" },
  });
  const call = state.toolCalls.t1;
  assert.ok(call);
  assert.equal(call.status, "pending");
  assert.equal(call.kind, "edit");
  assert.deepEqual(call.locations, [
    { path: "/w/a.ts", line: 3 },
    { path: "/w/b.ts", line: null },
  ]);
  assert.deepEqual(call.content, [
    { type: "text", text: "hello" },
    { type: "text", text: "[image]" },
    { type: "diff", path: "/w/a.ts", oldText: null, newText: "new" },
    { type: "diff", path: "/w/b.ts", oldText: null, newText: "b" },
    { type: "terminal", terminalId: "term-1", output: "" },
  ]);
  assert.deepEqual(call.rawInput, { path: "/w/a.ts" });
  assert.deepEqual(state.items, [{ type: "tool", toolCallId: "t1" }]);
  assert.equal(emits.length, 1);
  assert.equal(emits[0]?.type, "toolCall");
});

test("tool_call_update merges only provided fields and captures failureReason", () => {
  const base = applyUpdate(createTranscript(), {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Run",
    kind: "execute",
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "a" } }],
    locations: [{ path: "/w/x" }],
    rawInput: { command: "ls" },
  }).state;

  const partial = applyUpdate(base, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    title: null,
    content: null,
    rawOutput: { exitCode: 0 },
  }).state;
  const after = partial.toolCalls.t1;
  assert.ok(after);
  assert.equal(after.status, "completed");
  assert.equal(after.title, "Run");
  assert.deepEqual(after.content, [{ type: "text", text: "a" }]);
  assert.deepEqual(after.locations, [{ path: "/w/x", line: null }]);
  assert.deepEqual(after.rawInput, { command: "ls" });
  assert.deepEqual(after.rawOutput, { exitCode: 0 });
  assert.equal(partial.items.length, 1, "no duplicate item");

  const replaced = applyUpdate(partial, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "failed",
    content: [{ type: "terminal", terminalId: "term-9" }],
    _meta: { kiro: { failureReason: "denied" } },
  }).state;
  const failed = replaced.toolCalls.t1;
  assert.ok(failed);
  assert.deepEqual(failed.content, [{ type: "terminal", terminalId: "term-9", output: "" }]);
  assert.equal(failed.failureReason, "denied");
  assert.equal(failed.status, "failed");
});

test("tool_call for an existing id replaces the card in place; update for unknown id creates one", () => {
  const first = applyUpdate(createTranscript(), {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "A",
  }).state;
  const second = applyUpdate(first, {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "B",
    status: "completed",
  }).state;
  assert.equal(second.items.length, 1);
  assert.equal(second.toolCalls.t1?.title, "B");

  const orphan = applyUpdate(second, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" }).state;
  assert.equal(orphan.items.length, 2);
  assert.equal(orphan.toolCalls.t2?.status, "completed");
});

test("plan updates replace the whole plan", () => {
  const a = applyUpdate(createTranscript(), {
    sessionUpdate: "plan",
    entries: [
      { content: "one", priority: "high", status: "pending" },
      { content: "two", priority: "low", status: "pending" },
    ],
  });
  assert.equal(a.state.plan.length, 2);
  const b = applyUpdate(a.state, {
    sessionUpdate: "plan",
    entries: [{ content: "one", priority: "high", status: "completed" }],
  });
  assert.deepEqual(b.state.plan, [{ content: "one", priority: "high", status: "completed" }]);
  assert.deepEqual(b.emits, [{ type: "plan", entries: b.state.plan }]);
});

test("config options flatten grouped select options and keep booleans", () => {
  const options: acp.SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "a",
      options: [
        { group: "g1", name: "Group One", options: [{ value: "a", name: "A", description: "first" }] },
        { group: "g2", name: "Group Two", options: [{ value: "b", name: "B" }] },
      ],
    },
    {
      id: "effortLevel",
      name: "Effort",
      type: "select",
      currentValue: "low",
      options: [{ value: "low", name: "Low" }],
    },
    { id: "auto", name: "Auto", type: "boolean", currentValue: true },
  ];
  const views = toConfigOptionViews(options);
  assert.deepEqual(views, [
    {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      type: "select",
      currentValue: "a",
      options: [
        { value: "a", name: "A", description: "first", group: "Group One" },
        { value: "b", name: "B", description: null, group: "Group Two" },
      ],
    },
    {
      id: "effortLevel",
      name: "Effort",
      description: null,
      category: null,
      type: "select",
      currentValue: "low",
      options: [{ value: "low", name: "Low", description: null }],
    },
    { id: "auto", name: "Auto", description: null, category: null, type: "boolean", currentValue: true },
  ]);

  const { state, emits } = applyUpdate(createTranscript(), { sessionUpdate: "config_option_update", configOptions: options });
  assert.equal(state.configOptions.length, 3);
  assert.equal(emits[0]?.type, "configOptions");
});

test("mode and command updates", () => {
  const seeded = withSessionSnapshot(createTranscript(), {
    modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }, { id: "vibe", name: "Vibe" }] },
  });
  const modeResult = applyUpdate(seeded, { sessionUpdate: "current_mode_update", currentModeId: "vibe" });
  assert.equal(modeResult.state.modes?.currentModeId, "vibe");
  assert.equal(modeResult.state.modes?.availableModes.length, 2);
  assert.deepEqual(modeResult.emits, [{ type: "modes", modes: modeResult.state.modes }]);

  const noModes = applyUpdate(createTranscript(), { sessionUpdate: "current_mode_update", currentModeId: "x" });
  assert.deepEqual(noModes.state.modes, { currentModeId: "x", availableModes: [] });

  const commands = applyUpdate(createTranscript(), {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "plan", description: "Plan it", input: { hint: "goal" } },
      { name: "compact", description: "Compact" },
    ],
  });
  assert.deepEqual(commands.state.commands, [
    { name: "plan", description: "Plan it", hint: "goal" },
    { name: "compact", description: "Compact" },
  ]);
  assert.equal(commands.emits[0]?.type, "commands");
});

test("unknown or irrelevant updates are ignored without error and do not mutate the input", () => {
  const initial = createTranscript();
  const before = JSON.stringify(initial);
  const info = applyUpdate(initial, { sessionUpdate: "session_info_update", title: "x" });
  assert.equal(info.state, initial);
  assert.deepEqual(info.emits, []);
  const unknown = applyUpdate(initial, { sessionUpdate: "kiro_custom" } as unknown as acp.SessionUpdate);
  assert.deepEqual(unknown.emits, []);
  applyUpdates(initial, [chunk("agent_message_chunk", "x", "m1"), { sessionUpdate: "tool_call", toolCallId: "t", title: "t" }]);
  assert.equal(JSON.stringify(initial), before);
});

test("snapshotToUiState composes transcript and host-owned fields", () => {
  const state = applyUpdates(createTranscript(), [chunk("agent_message_chunk", "hi", "m1")]).state;
  const ui = snapshotToUiState(state, {
    connection: { status: "ready" },
    sessionId: "s1",
    turnActive: false,
    permissions: [],
    models: null,
    chips: [],
    notices: [],
  });
  assert.equal(ui.items.length, 1);
  assert.equal(ui.sessionId, "s1");
  assert.equal(ui.connection.status, "ready");
  assert.deepEqual(ui.configOptions, []);
});
