import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary, ToWebview, UiState } from "../src/ui/protocol.js";
import { appendSegment, clearsSession, initialState, reduce } from "../src/webview/state.js";

function sessions(): SessionSummary[] {
  return [
    { id: "s1", title: "One", status: "running", updatedAt: 1000 },
    { id: "s2", title: "Two", status: "idle", updatedAt: 500 },
  ];
}

/** A `state` message from a partial snapshot (the host may omit fields on older builds). */
function snapshot(partial: Partial<UiState>): ToWebview {
  return { type: "state", state: partial as UiState };
}

test("a state snapshot keeps prefs and normalises every collection", () => {
  const next = reduce(
    initialState(),
    snapshot({
      connection: { status: "ready", agentName: "Kiro" },
      sessionId: "s1",
      sessions: sessions(),
      turnActive: true,
      prefs: { showSettings: true, sessionPanelCollapsed: true },
    }),
  );
  assert.deepEqual(next.prefs, { showSettings: true, sessionPanelCollapsed: true });
  assert.equal(next.sessionId, "s1");
  assert.equal(next.turnActive, true);
  assert.equal(next.sessions.length, 2);
  assert.deepEqual(next.items, []);
  assert.deepEqual(next.toolCalls, {});
  assert.deepEqual(next.plan, []);
  assert.deepEqual(next.permissions, []);
  assert.deepEqual(next.notices, []);
  assert.deepEqual(next.chips, []);
  assert.deepEqual(next.commands, []);
  assert.deepEqual(next.configOptions, []);
  assert.equal(next.modes, null);
  assert.equal(next.models, null);
});

test("a snapshot without sessions normalises to an empty list and no prefs", () => {
  const next = reduce(initialState(), snapshot({ sessionId: "s1", items: [] }));
  assert.deepEqual(next.sessions, []);
  assert.equal(next.prefs, undefined);
  // Arrays are copied, never shared with the message.
  const list = sessions();
  const copied = reduce(initialState(), snapshot({ sessions: list }));
  assert.notEqual(copied.sessions, list);
  assert.deepEqual(copied.sessions, list);
});

test("`sessions` replaces the list with a fresh array and leaves the rest alone", () => {
  const start = reduce(initialState(), snapshot({ sessionId: "s1", sessions: sessions(), turnActive: true }));
  const replacement: SessionSummary[] = [{ id: "s9", title: "Nine", status: "needs_input", updatedAt: 9 }];
  const next = reduce(start, { type: "sessions", sessions: replacement });
  assert.notEqual(next.sessions, start.sessions);
  assert.notEqual(next.sessions, replacement);
  assert.deepEqual(next.sessions, replacement);
  assert.equal(next.sessionId, "s1");
  assert.equal(next.turnActive, true);
  assert.equal(next.items, start.items);
  // Malformed payloads degrade to an empty list.
  const bad = reduce(start, { type: "sessions", sessions: undefined as unknown as SessionSummary[] });
  assert.deepEqual(bad.sessions, []);
});

test("`session` with a new id clears the session-scoped state but keeps sessions", () => {
  let state = reduce(initialState(), snapshot({ sessionId: "s1", sessions: sessions(), connection: { status: "ready" } }));
  state = reduce(state, { type: "turn", active: true });
  state = reduce(state, { type: "chunk", messageId: "m1", role: "agent", segment: { type: "text", text: "hi" } });
  state = reduce(state, {
    type: "toolCall",
    call: { toolCallId: "t1", title: "Read a.ts", kind: "read", status: "in_progress", content: [], locations: [] },
  });
  state = reduce(state, { type: "plan", entries: [{ content: "step", priority: "high", status: "pending" }] });
  state = reduce(state, {
    type: "permission",
    request: { requestId: "r1", toolCallId: "t1", title: "Allow?", kind: "read", options: [], hasDiff: false },
  });
  state = reduce(state, { type: "notice", notice: { id: "n1", severity: "info", text: "note" } });
  assert.equal(state.items.length, 2);
  assert.equal(state.permissions.length, 1);

  const msg: ToWebview = { type: "session", sessionId: "s2" };
  assert.equal(clearsSession(state, msg), true);
  const next = reduce(state, msg);
  assert.equal(next.sessionId, "s2");
  assert.equal(next.sessions, state.sessions);
  assert.equal(next.connection, state.connection);
  assert.equal(next.turnActive, false);
  assert.deepEqual(next.items, []);
  assert.deepEqual(next.toolCalls, {});
  assert.deepEqual(next.plan, []);
  assert.deepEqual(next.permissions, []);
  assert.deepEqual(next.notices, []);

  // Same id: nothing changes (same object).
  const same: ToWebview = { type: "session", sessionId: "s1" };
  assert.equal(clearsSession(state, same), false);
  assert.equal(reduce(state, same), state);
  // `null` ends the displayed session.
  assert.equal(reduce(state, { type: "session", sessionId: null }).sessionId, null);
});

test("chunks create a message, merge consecutive text and keep other segments apart", () => {
  let state = reduce(initialState(), { type: "chunk", messageId: "a1", role: "agent", segment: { type: "text", text: "Hello " } });
  assert.equal(state.items.length, 1);
  const first = state.items[0];
  assert.ok(first.type === "message");
  assert.equal(first.message.role, "agent");

  const before = state.items;
  state = reduce(state, { type: "chunk", messageId: "a1", role: "agent", segment: { type: "text", text: "world" } });
  assert.notEqual(state.items, before, "items array is copied on change");
  const merged = state.items[0];
  assert.ok(merged.type === "message");
  assert.notEqual(merged.message, first.message, "message object is replaced so the renderer re-renders it");
  assert.deepEqual(merged.message.segments, [{ type: "text", text: "Hello world" }]);

  state = reduce(state, { type: "chunk", messageId: "a1", role: "agent", segment: { type: "resource", uri: "file:///a", label: "a" } });
  state = reduce(state, { type: "chunk", messageId: "a1", role: "agent", segment: { type: "text", text: "!" } });
  const item = state.items[0];
  assert.ok(item.type === "message");
  assert.deepEqual(item.message.segments, [
    { type: "text", text: "Hello world" },
    { type: "resource", uri: "file:///a", label: "a" },
    { type: "text", text: "!" },
  ]);

  // A different message id appends a new item; chunks address the latest item with that id.
  state = reduce(state, { type: "chunk", messageId: "u2", role: "user", segment: { type: "text", text: "next" } });
  assert.equal(state.items.length, 2);
  state = reduce(state, { type: "chunk", messageId: "a1", role: "agent", segment: { type: "text", text: "?" } });
  const again = state.items[0];
  assert.ok(again.type === "message");
  assert.equal(again.message.segments[2].type, "text");
  assert.deepEqual(again.message.segments[2], { type: "text", text: "!?" });
});

test("appendSegment merges text onto text only", () => {
  assert.deepEqual(appendSegment([], { type: "text", text: "a" }), [{ type: "text", text: "a" }]);
  assert.deepEqual(appendSegment([{ type: "text", text: "a" }], { type: "text", text: "b" }), [{ type: "text", text: "ab" }]);
  assert.deepEqual(appendSegment([{ type: "image", mimeType: "image/png" }], { type: "text", text: "b" }), [
    { type: "image", mimeType: "image/png" },
    { type: "text", text: "b" },
  ]);
});

test("`turn` returns the same object when nothing changes", () => {
  const state = initialState();
  assert.equal(reduce(state, { type: "turn", active: false }), state);
  assert.equal(reduce(state, { type: "turn", active: true }).turnActive, true);
});
