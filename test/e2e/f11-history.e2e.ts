/** F11 — browsing the agent's past sessions and restoring one (session/list + session/load, D21). */
import {
  assert,
  assertEqual,
  closeAllEditors,
  ensureReady,
  freshSession,
  messagesOf,
  runPrompt,
  test,
  textOf,
  toolCall,
  waitFor,
  withTimeout,
} from "./harness.js";

const PAST_1 = "past-1";
const PAST_1_TITLE = "Investigate flaky CI";
const PAST_1_QUESTION = "Why is CI flaky?";
const PAST_1_TOOL = "call-past-1-read";

test("F11.1 the fake agent advertises session/list + session/load: canBrowseSessions is true", async ({ api }) => {
  await closeAllEditors();
  const state = await ensureReady(api);
  assertEqual(state.connection.canBrowseSessions, true, "connection.canBrowseSessions");
});

test("F11.2 listPastSessions() returns the canned past sessions with titles, excluding live ones", async ({ api }) => {
  await ensureReady(api);
  // The fake agent pages `session/list` two entries at a time (newest first).
  // With at least two live sessions in this workspace the canned past ones
  // (older) land beyond the first page: the controller must follow nextCursor.
  while (api.controller.sessionIds().length < 2) await freshSession(api);
  const entries = await withTimeout(api.controller.listPastSessions(), 15_000, "listPastSessions()");
  const byId = new Map(entries.map((e) => [e.sessionId, e]));
  const past1 = byId.get(PAST_1);
  const past2 = byId.get("past-2");
  assert(past1, `past-1 is listed (${JSON.stringify(entries.map((e) => e.sessionId))})`);
  assert(past2, `past-2 is listed although it is on a later session/list page (${JSON.stringify(entries.map((e) => e.sessionId))})`);
  assertEqual(entries.filter((e) => e.sessionId === PAST_1).length, 1, "past-1 is listed exactly once across pages");
  assertEqual(past1.title, PAST_1_TITLE, "past-1 title");
  assertEqual(past1.label, PAST_1_TITLE, "past-1 label is its title");
  assertEqual(past2.title, "Add retry to fetch", "past-2 title");
  assert(past1.description.length > 0, `past-1 has a relative time (${JSON.stringify(past1.description)})`);
  assert(past1.detail.length > 0, "past-1 has a cwd detail");
  const live = new Set(api.controller.sessionIds());
  for (const entry of entries) {
    assert(!live.has(entry.sessionId), `live session ${entry.sessionId} is not offered as a past session`);
  }
  // Sessions closed locally earlier (F10) stay on the agent and are listed
  // too (no session/delete); among the canned ones the newer comes first.
  const ids = entries.map((e) => e.sessionId);
  assert(ids.indexOf(PAST_1) < ids.indexOf("past-2"), `past-1 (newer) is listed before past-2 (${ids.join(",")})`);
});

test("F11.3 openPastSession('past-1') restores the transcript: user text, answer, completed tool call, title; prompts wait for the restore", async ({ api, recorder }) => {
  await ensureReady(api);
  // Known title → openPastSession() registers the session before its first await on the agent.
  await withTimeout(api.controller.listPastSessions(), 15_000, "listPastSessions()");
  const before = api.controller.snapshot().sessionId;
  assert(before && before !== PAST_1, "a live session is displayed before the restore");
  const mark = recorder.mark();
  const restore = api.controller.openPastSession(PAST_1);
  // Not awaited: the session is still restoring (session/load pending) when
  // this prompt arrives. It must be refused with a notice, not sent to the
  // agent, where its live answer would be flagged as replayed history (D21).
  await withTimeout(api.controller.prompt("/scenario chat", [], PAST_1), 15_000, "prompt during restore");
  const waitNotice = recorder.ofType("notice", mark).find((m) => m.notice.text === "Wait for the session to finish restoring.");
  assert(waitNotice, `a notice asks to wait for the restore (${JSON.stringify(recorder.ofType("notice", mark))})`);
  const restoring = api.controller.snapshot();
  assertEqual(restoring.sessionId, PAST_1, "the restoring session is already displayed");
  assert(
    restoring.notices.some((n) => n.id === waitNotice.notice.id),
    "the notice is part of the restoring session's state",
  );
  assertEqual(api.controller.snapshot().turnActive, false, "no turn is active while restoring");
  assertEqual(recorder.ofType("turn", mark).length, 0, "no turn started during the restore");
  const id = await withTimeout(restore, 15_000, "openPastSession(past-1)");
  assertEqual(id, PAST_1, "openPastSession() returns the restored id");
  assertEqual(recorder.ofType("turn", mark).length, 0, "no turn started by the time the restore finished");
  assert(
    !messagesOf(api.controller.snapshot()).some((m) => m.role === "user" && textOf(m).includes("/scenario chat")),
    "the refused prompt was not echoed into the transcript",
  );

  const state = api.controller.snapshot();
  assertEqual(state.sessionId, PAST_1, "the restored session is displayed");
  assertEqual(state.turnActive, false, "no turn is active after the restore");
  const messages = messagesOf(state);
  const user = messages.find((m) => m.role === "user");
  assert(user, "the replayed user message is rendered");
  assert(textOf(user).includes(PAST_1_QUESTION), `the user message carries the replayed text (${textOf(user)})`);
  assertEqual(messages[0]?.role, "user", "the conversation starts with the user's message");
  const agentText = messages.filter((m) => m.role === "agent").map(textOf).join("\n");
  assert(agentText.length > 0, "the replayed agent messages are rendered");
  // The tool call splits the answer into two agent messages (before / after the call).
  assert(agentText.includes("ci.yml") && agentText.includes("no retry"), `agent text (${agentText})`);
  const call = toolCall(state, PAST_1_TOOL);
  assertEqual(call.status, "completed", "the replayed tool call is completed");
  assert(state.items.some((i) => i.type === "tool" && i.toolCallId === PAST_1_TOOL), "the tool call is in the transcript order");
  assert(!state.notices.some((n) => n.text.startsWith("Restoring")), "the progress notice was withdrawn");
  // Terminal ids replayed from an earlier run (`term-N` / another run's id)
  // resolve to nothing on behalf of the restored session (D9/D21).
  assertEqual(api.terminal.snapshot("term-1", PAST_1), undefined, "a replayed-style terminal id has no live snapshot");
  assertEqual(api.terminal.showTerminal("term-1", PAST_1), false, "a replayed-style terminal id reveals nothing");

  const summary = state.sessions.find((s) => s.id === PAST_1);
  assert(summary, "the restored session is listed");
  assertEqual(summary.title, PAST_1_TITLE, "its title is the agent's");
  assertEqual(summary.status, "idle", "its status is idle");
  assert(api.controller.sessionIds().includes(before), "the previously displayed session is still live");

  assert(
    recorder.ofType("session", mark).some((m) => m.sessionId === PAST_1),
    "the following view was switched to the restored session",
  );
  assert(
    recorder.ofType("state", mark).some((m) => m.state.sessionId === PAST_1 && m.state.toolCalls[PAST_1_TOOL]),
    "a state snapshot with the restored transcript was posted",
  );
  await waitFor(
    () => recorder.ofType("sessions", mark).some((m) => m.sessions.some((s) => s.id === PAST_1 && s.title === PAST_1_TITLE)) || undefined,
    15_000,
    "a sessions update listing the restored session",
  );
  assert(
    !(await api.controller.listPastSessions()).some((e) => e.sessionId === PAST_1),
    "a restored session is no longer offered as a past session",
  );
});

test("F11.4 a prompt on the restored session streams normally and keeps the replayed items", async ({ api }) => {
  assertEqual(api.controller.snapshot().sessionId, PAST_1, "the restored session is still displayed");
  const beforeItems = api.controller.snapshot().items.length;
  await runPrompt(api, "/scenario chat");
  const state = api.controller.snapshot();
  assertEqual(state.sessionId, PAST_1, "still on the restored session");
  assert(state.items.length > beforeItems, `the turn added items (${beforeItems} -> ${state.items.length})`);
  const messages = messagesOf(state);
  assert(textOf(messages[0]!).includes(PAST_1_QUESTION), "the replayed user message is still first");
  assertEqual(toolCall(state, PAST_1_TOOL).status, "completed", "the replayed tool call is still there");
  assert(
    messages.some((m) => m.role === "user" && textOf(m).includes("/scenario chat")),
    "the new prompt was echoed locally",
  );
  const agentMessages = messages.filter((m) => m.role === "agent");
  assert(agentMessages.length >= 2, `the agent answered again (${agentMessages.length} agent messages)`);
  assertEqual(state.sessions.find((s) => s.id === PAST_1)?.title, PAST_1_TITLE, "the title is unchanged");
});

test("F11.5 openPastSession() of an unknown id fails with a notice and keeps the previous session", async ({ api, recorder }) => {
  const before = api.controller.snapshot().sessionId;
  assert(before, "a session is displayed");
  const liveBefore = api.controller.sessionIds();
  const mark = recorder.mark();
  const id = await withTimeout(api.controller.openPastSession("nope"), 15_000, "openPastSession(nope)");
  assertEqual(id, null, "the restore reports failure");
  assertEqual(api.controller.snapshot().sessionId, before, "the view kept its previous session");
  assertEqual(api.controller.focusedSessionId, before, "focus went back to the previous session");
  assert(!api.controller.sessionIds().includes("nope"), "the failed session is not listed");
  assertEqual(api.controller.sessionIds().length, liveBefore.length, "no session leaked");
  const notice = recorder
    .ofType("notice", mark)
    .find((m) => (m.notice.severity === "warning" || m.notice.severity === "error") && m.notice.text.includes("nope"));
  assert(notice, `a warning notice names the failed session (${JSON.stringify(recorder.ofType("notice", mark))})`);
  assert(
    api.controller.snapshot().notices.some((n) => n.id === notice.notice.id),
    "the notice is part of the displayed session's state",
  );
});
