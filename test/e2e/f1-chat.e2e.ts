/** F1 — chat: streamed answer, turn lifecycle, new session, cancel. */
import {
  assert,
  assertEqual,
  ensureReady,
  freshSession,
  lastStopReason,
  messagesOf,
  runPrompt,
  sleep,
  test,
  textOf,
  waitFor,
  withTimeout,
} from "./harness.js";

test("F1.1 chat scenario streams an answer and ends the turn", async ({ api, recorder }) => {
  const ready = await ensureReady(api);
  assertEqual(ready.connection.status, "ready", "connection status");
  assert(ready.connection.agentName === "Fake Kiro", `agent name: ${ready.connection.agentName}`);
  await freshSession(api);

  const mark = recorder.mark();
  await runPrompt(api, "/scenario chat");

  const state = api.controller.snapshot();
  assertEqual(state.turnActive, false, "turnActive after the turn");
  const messages = messagesOf(state);
  const user = messages.find((m) => m.role === "user");
  const agent = messages.find((m) => m.role === "agent");
  assert(user, "transcript has a user message");
  assertEqual(textOf(user), "/scenario chat", "user message text");
  assert(agent, "transcript has an agent message");
  assertEqual(textOf(agent), "The answer is 42.", "agent message text");

  const chunks = recorder.ofType("chunk", mark).filter((c) => c.role === "agent");
  assert(chunks.length >= 3, `expected >= 3 agent chunks, got ${chunks.length}`);
  assertEqual(lastStopReason(recorder, mark), "end_turn", "stop reason");
  assert(
    recorder.ofType("turn", mark).some((t) => t.active),
    "a turn-active message was posted while streaming",
  );
});

test("F1.2 newSession() yields a different, empty session", async ({ api, recorder }) => {
  await ensureReady(api);
  await runPrompt(api, "/scenario chat");
  const before = api.controller.snapshot();
  assert(before.sessionId, "session id before newSession");
  assert(before.items.length > 0, "transcript is non-empty before newSession");

  const mark = recorder.mark();
  await withTimeout(api.controller.newSession(), 15_000, "newSession()");
  const after = api.controller.snapshot();
  assert(after.sessionId, "session id after newSession");
  assert(after.sessionId !== before.sessionId, `session id changed (${before.sessionId} -> ${after.sessionId})`);
  assertEqual(after.items.length, 0, "transcript length after newSession");
  assertEqual(after.turnActive, false, "turnActive after newSession");
  assert(
    recorder.ofType("session", mark).some((s) => s.sessionId === after.sessionId),
    "a session message with the new id was posted",
  );
  assert(recorder.ofType("state", mark).length > 0, "a full state snapshot was posted");
});

test("F1.3 cancel() interrupts a slow turn with stopReason cancelled", async ({ api, recorder }) => {
  await freshSession(api);
  const mark = recorder.mark();
  const agentChunks = () => recorder.ofType("chunk", mark).filter((c) => c.role === "agent");

  const turn = api.controller.prompt("/scenario cancel", []);
  await waitFor(() => agentChunks().length >= 3, 15_000, "three streamed chunks");
  assertEqual(api.controller.snapshot().turnActive, true, "turnActive while streaming");

  await api.controller.cancel();
  await withTimeout(turn, 15_000, "prompt() to resolve after cancel");

  assertEqual(lastStopReason(recorder, mark), "cancelled", "stop reason");
  assertEqual(api.controller.snapshot().turnActive, false, "turnActive after cancel");
  const count = agentChunks().length;
  assert(count < 40, `cancel happened before the scenario finished (${count} chunks)`);
  await sleep(500);
  assertEqual(agentChunks().length, count, "no chunks arrive after the turn was cancelled");
});
