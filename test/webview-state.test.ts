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

test("`messageDelivery` sets, replaces and clears the badge of a user message", () => {
  let state = reduce(initialState(), { type: "chunk", messageId: "u1", role: "user", segment: { type: "text", text: "steer" } });
  const first = state.items[0];
  assert.ok(first.type === "message");
  assert.equal(first.message.delivery, undefined, "a new message starts without a delivery badge");

  state = reduce(state, { type: "messageDelivery", messageId: "u1", delivery: "steering" });
  const steering = state.items[0];
  assert.ok(steering.type === "message");
  assert.notEqual(steering.message, first.message, "message object is replaced so the renderer re-renders it");
  assert.equal(steering.message.delivery, "steering");
  assert.deepEqual(steering.message.segments, first.message.segments);

  // Same value again: nothing changes (same object).
  assert.equal(reduce(state, { type: "messageDelivery", messageId: "u1", delivery: "steering" }), state);

  state = reduce(state, { type: "messageDelivery", messageId: "u1", delivery: "queued" });
  const queued = state.items[0];
  assert.ok(queued.type === "message");
  assert.equal(queued.message.delivery, "queued");

  // A later chunk keeps the badge.
  state = reduce(state, { type: "chunk", messageId: "u1", role: "user", segment: { type: "text", text: "!" } });
  const grown = state.items[0];
  assert.ok(grown.type === "message");
  assert.equal(grown.message.delivery, "queued");

  const before = state;
  state = reduce(state, { type: "messageDelivery", messageId: "u1", delivery: null });
  const cleared = state.items[0];
  assert.ok(cleared.type === "message");
  assert.notEqual(state, before);
  assert.equal(cleared.message.delivery, undefined);
  assert.equal("delivery" in cleared.message, false, "a cleared badge leaves no key behind");
  // Clearing an already clear message is a no-op.
  assert.equal(reduce(state, { type: "messageDelivery", messageId: "u1", delivery: null }), state);
});

test("`messageDelivery` for an unknown message id is a no-op", () => {
  const state = reduce(initialState(), { type: "chunk", messageId: "u1", role: "user", segment: { type: "text", text: "hi" } });
  assert.equal(reduce(state, { type: "messageDelivery", messageId: "nope", delivery: "steering" }), state);
  assert.equal(reduce(initialState(), { type: "messageDelivery", messageId: "u1", delivery: "queued" }).items.length, 0);
});

test("a state snapshot carries `acceptsPromptsDuringTurn` and per-message `delivery`", () => {
  const withFlag = reduce(initialState(), snapshot({ sessionId: "s1", acceptsPromptsDuringTurn: true, turnActive: true }));
  assert.equal(withFlag.acceptsPromptsDuringTurn, true);
  assert.equal(reduce(initialState(), snapshot({ sessionId: "s1", acceptsPromptsDuringTurn: false })).acceptsPromptsDuringTurn, false);
  assert.equal(reduce(initialState(), snapshot({ sessionId: "s1" })).acceptsPromptsDuringTurn, undefined);
  // Not a session field: a session switch keeps it.
  assert.equal(reduce(withFlag, { type: "session", sessionId: "s2" }).acceptsPromptsDuringTurn, true);

  const next = reduce(
    initialState(),
    snapshot({
      sessionId: "s1",
      items: [
        { type: "message", message: { id: "u1", role: "user", segments: [{ type: "text", text: "a" }], delivery: "steering" } },
        { type: "message", message: { id: "u2", role: "user", segments: [{ type: "text", text: "b" }], delivery: "queued" } },
        { type: "message", message: { id: "u3", role: "user", segments: [{ type: "text", text: "c" }] } },
      ],
    }),
  );
  const deliveries = next.items.map((it) => (it.type === "message" ? it.message.delivery : "tool"));
  assert.deepEqual(deliveries, ["steering", "queued", undefined]);
});

const ORIGIN = { sessionId: "sess-2", handle: "s2", title: "Fix the login bug" };

test("`messageOrigin` marks a user message and survives later chunks and delivery changes", () => {
  let state = reduce(initialState(), { type: "chunk", messageId: "u1", role: "user", segment: { type: "text", text: "Please " } });
  state = reduce(state, { type: "chunk", messageId: "a1", role: "agent", segment: { type: "text", text: "ok" } });
  const first = state.items[0];
  const agent = state.items[1];
  assert.ok(first.type === "message");
  assert.equal(first.message.origin, undefined, "a new message has no origin");

  const before = state;
  state = reduce(state, { type: "messageOrigin", messageId: "u1", origin: ORIGIN });
  assert.notEqual(state, before);
  assert.notEqual(state.items, before.items, "items array is copied on change");
  const marked = state.items[0];
  assert.ok(marked.type === "message");
  assert.notEqual(marked.message, first.message, "message object is replaced so the renderer re-renders it");
  assert.deepEqual(marked.message.origin, ORIGIN);
  assert.deepEqual(marked.message.segments, first.message.segments);
  assert.equal(state.items[1], agent, "other messages are untouched");
  // Not activity of its own: the echo chunk before it already stamped the session.
  assert.equal(state.lastActivityAt, before.lastActivityAt);

  // The same origin again is a no-op (same object).
  assert.equal(reduce(state, { type: "messageOrigin", messageId: "u1", origin: { ...ORIGIN } }), state);

  // Later chunks and a delivery badge keep it.
  state = reduce(state, { type: "chunk", messageId: "u1", role: "user", segment: { type: "text", text: "review" } });
  state = reduce(state, { type: "messageDelivery", messageId: "u1", delivery: "queued" });
  const grown = state.items[0];
  assert.ok(grown.type === "message");
  assert.deepEqual(grown.message.segments, [{ type: "text", text: "Please review" }]);
  assert.equal(grown.message.delivery, "queued");
  assert.deepEqual(grown.message.origin, ORIGIN);
  state = reduce(state, { type: "messageDelivery", messageId: "u1", delivery: null });
  const delivered = state.items[0];
  assert.ok(delivered.type === "message");
  assert.deepEqual(delivered.message.origin, ORIGIN);

  // A different origin replaces it.
  const renamed = { ...ORIGIN, title: "Fix the login bug (v2)" };
  state = reduce(state, { type: "messageOrigin", messageId: "u1", origin: renamed });
  const replaced = state.items[0];
  assert.ok(replaced.type === "message");
  assert.deepEqual(replaced.message.origin, renamed);
});

test("`messageOrigin` for an unknown message, before its echo or malformed is ignored", () => {
  const state = reduce(initialState(), { type: "chunk", messageId: "u1", role: "user", segment: { type: "text", text: "hi" } });
  assert.equal(reduce(state, { type: "messageOrigin", messageId: "nope", origin: ORIGIN }), state);
  // Arriving before the message exists: dropped, and the later echo is a plain user message.
  let early = reduce(initialState(), { type: "messageOrigin", messageId: "u9", origin: ORIGIN });
  assert.equal(early.items.length, 0);
  early = reduce(early, { type: "chunk", messageId: "u9", role: "user", segment: { type: "text", text: "late echo" } });
  const echo = early.items[0];
  assert.ok(echo.type === "message");
  assert.equal(echo.message.origin, undefined);
  // An origin without a session id cannot be revealed: ignored.
  const bad = { handle: "s2", title: "x" } as unknown as typeof ORIGIN;
  assert.equal(reduce(state, { type: "messageOrigin", messageId: "u1", origin: bad }), state);
  assert.equal(reduce(state, { type: "messageOrigin", messageId: "u1", origin: null as unknown as typeof ORIGIN }), state);
  // Missing handle / title degrade to "" rather than breaking the label.
  const sparse = reduce(state, { type: "messageOrigin", messageId: "u1", origin: { sessionId: "sess-2" } as unknown as typeof ORIGIN });
  const item = sparse.items[0];
  assert.ok(item.type === "message");
  assert.deepEqual(item.message.origin, { sessionId: "sess-2", handle: "", title: "" });
});

test("a state snapshot carries per-message `origin` and later updates keep it", () => {
  let state = reduce(
    initialState(),
    snapshot({
      sessionId: "s1",
      items: [
        { type: "message", message: { id: "u1", role: "user", segments: [{ type: "text", text: "mine" }] } },
        {
          type: "message",
          message: { id: "u2", role: "user", segments: [{ type: "text", text: "from a peer" }], delivery: "queued", origin: ORIGIN },
        },
      ],
    }),
  );
  const origins = state.items.map((it) => (it.type === "message" ? it.message.origin : undefined));
  assert.deepEqual(origins, [undefined, ORIGIN]);
  // The host re-posting the same origin after the snapshot changes nothing.
  assert.equal(reduce(state, { type: "messageOrigin", messageId: "u2", origin: { ...ORIGIN } }), state);
  // Clearing the badge when the queued message is sent keeps the origin.
  state = reduce(state, { type: "messageDelivery", messageId: "u2", delivery: null });
  const sent = state.items[1];
  assert.ok(sent.type === "message");
  assert.equal(sent.message.delivery, undefined);
  assert.deepEqual(sent.message.origin, ORIGIN);
  // A session switch drops it with the rest of the transcript.
  assert.deepEqual(reduce(state, { type: "session", sessionId: "s2" }).items, []);
});
