/** F10 — several sessions per view, session statuses, several chat tabs and session groups. */
import * as vscode from "vscode";

import {
  Recorder,
  allTabs,
  assert,
  assertEqual,
  closeAllEditors,
  deleteWorkspaceFile,
  ensureReady,
  freshSession,
  messagesOf,
  proposalTabsOpen,
  runPrompt,
  sleep,
  test,
  waitFor,
  withTimeout,
} from "./harness.js";
import type { KiroAcpApi } from "../../src/extension.js";
import type { SessionStatus } from "../../src/ui/protocol.js";

const PANEL_VIEW_TYPE = "kiroAcp.chatPanel";

function panelTabs(): vscode.Tab[] {
  return allTabs().filter(
    (t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes(PANEL_VIEW_TYPE),
  );
}

/** Ids of the two sessions the suite works with, created by F10.1. */
let sessionA = "";
let sessionB = "";

function statusOf(api: KiroAcpApi, id: string): SessionStatus | undefined {
  return api.controller.snapshot().sessions.find((s) => s.id === id)?.status;
}

test("F10.1 two newSession() calls keep both sessions; the newest is focused", async ({ api }) => {
  // Close the chat tab left by F8 first: closing a tab closes its sessions
  // (D20), and F10.3 closes all editors while A and B must survive.
  await closeAllEditors();
  await ensureReady(api);
  sessionA = await freshSession(api);
  sessionB = await freshSession(api);
  assert(sessionA !== sessionB, "two distinct session ids");

  const state = api.controller.snapshot();
  assertEqual(state.sessionId, sessionB, "the newest session is focused");
  const ids = state.sessions.map((s) => s.id);
  assert(ids.includes(sessionA), `sessions list keeps A (${JSON.stringify(ids)})`);
  assert(ids.includes(sessionB), `sessions list keeps B (${JSON.stringify(ids)})`);
  assertEqual(state.sessions[0]?.id, sessionB, "most recent session comes first");
  assertEqual(api.controller.focusedSessionId, sessionB, "focusedSessionId");
  for (const summary of state.sessions) {
    assertEqual(summary.status, "idle", `status of ${summary.id}`);
  }
});

test("F10.2 selectSession() switches the displayed transcript and keeps each session's messages", async ({ api, recorder }) => {
  api.controller.selectSession(sessionA);
  assertEqual(api.controller.snapshot().sessionId, sessionA, "A is displayed after selectSession(A)");
  await runPrompt(api, "/scenario chat");
  const inA = messagesOf(api.controller.snapshot());
  assert(inA.length >= 2, `A has the prompt and the answer (${inA.length} messages)`);
  const titleA = api.controller.snapshot().sessions.find((s) => s.id === sessionA)?.title;
  assertEqual(titleA, "/scenario chat", "A's title is its first prompt");

  const mark = recorder.mark();
  api.controller.selectSession(sessionB);
  const b = api.controller.snapshot();
  assertEqual(b.sessionId, sessionB, "B is displayed after selectSession(B)");
  assertEqual(b.items.length, 0, "B's transcript is empty");
  assert(
    recorder.ofType("session", mark).some((m) => m.sessionId === sessionB),
    "a following view received the session switch",
  );
  assert(recorder.ofType("state", mark).length > 0, "a state snapshot followed the session switch");

  api.controller.selectSession(sessionA);
  const a = api.controller.snapshot();
  assertEqual(a.sessionId, sessionA, "A is displayed again");
  assertEqual(messagesOf(a).length, inA.length, "A's messages are back");
});

test("F10.3 session statuses: running, idle and needs_input", async ({ api }) => {
  await closeAllEditors();
  await deleteWorkspaceFile("config.json");
  api.controller.selectSession(sessionA);

  const turn = api.controller.prompt("/scenario cancel", []);
  await waitFor(() => statusOf(api, sessionA) === "running" || undefined, 15_000, "A to be running");
  assertEqual(statusOf(api, sessionB), "idle", "B stays idle while A runs");
  await api.controller.cancel();
  await withTimeout(turn, 15_000, "the cancelled turn");
  await waitFor(() => statusOf(api, sessionA) === "idle" || undefined, 15_000, "A to be idle after cancel");

  const turn2 = api.controller.prompt("/scenario permission-reject", []);
  const permission = await waitFor(() => api.permissions.pending()[0], 15_000, "a pending permission request");
  await waitFor(() => statusOf(api, sessionA) === "needs_input" || undefined, 15_000, "A to need input");
  assertEqual(statusOf(api, sessionB), "idle", "B stays idle while A waits for input");
  const reject = permission.options.find((o) => o.kind === "reject_once");
  assert(reject, "the agent offers a reject_once option");
  api.permissions.resolve(permission.requestId, reject.optionId);
  await withTimeout(turn2, 30_000, "the permission turn");
  await waitFor(() => statusOf(api, sessionA) === "idle" || undefined, 15_000, "A to be idle again");
  await waitFor(() => !proposalTabsOpen(), 15_000, "proposal editors to close");
});

test("F10.4 closeSession() of the displayed session falls back to the remaining one", async ({ api, recorder }) => {
  api.controller.selectSession(sessionA);
  assertEqual(api.controller.snapshot().sessionId, sessionA, "A is displayed");
  const mark = recorder.mark();
  await withTimeout(api.controller.closeSession(sessionA), 15_000, "closeSession(A)");
  const state = api.controller.snapshot();
  assertEqual(state.sessionId, sessionB, "the view fell back to B");
  assert(!state.sessions.some((s) => s.id === sessionA), "A is gone from the session list");
  assert(state.sessions.some((s) => s.id === sessionB), "B is still listed");
  assert(
    recorder.ofType("session", mark).some((m) => m.sessionId === sessionB),
    "the following view was switched to B",
  );
  await waitFor(
    () => recorder.ofType("sessions", mark).some((m) => !m.sessions.some((s) => s.id === sessionA)) || undefined,
    15_000,
    "a sessions update without A",
  );
});

test("F10.5 ChatPanelManager.openNew() twice opens two tabs displaying different sessions", async ({ api }) => {
  const before = panelTabs().length;
  const p1 = api.panel.openNew();
  const p2 = api.panel.openNew();
  await waitFor(() => panelTabs().length === before + 2 || undefined, 15_000, "two more Kiro Chat tabs");
  assertEqual(api.panel.panels().length >= 2, true, "the manager tracks both panels");
  const [s1, s2] = await waitFor(
    () => {
      const a = api.panel.sessionOf(p1);
      const b = api.panel.sessionOf(p2);
      return a && b ? [a, b] : undefined;
    },
    15_000,
    "both tabs to get a session",
  );
  assert(s1 !== s2, `each tab displays its own session (${s1} vs ${s2})`);
  const ids = api.controller.snapshot().sessions.map((s) => s.id);
  assert(ids.includes(s1) && ids.includes(s2), "both tab sessions are live");
  p1.dispose();
  p2.dispose();
  await waitFor(() => panelTabs().length === before || undefined, 15_000, "the two tabs to close");
});

test("F10.6 incremental messages reach only the views displaying that session", async ({ api }) => {
  await ensureReady(api);
  const a = await freshSession(api);
  const b = await freshSession(api);
  const recorderB = new Recorder();
  const view = api.controller.attachView(recorderB.poster);
  try {
    view.setSession(b);
    assertEqual(view.sessionId, b, "the view displays B");
    assert(recorderB.ofType("state").some((m) => m.state.sessionId === b), "the view got B's state");
    recorderB.reset();

    api.controller.selectSession(a);
    await runPrompt(api, "/scenario chat");
    await sleep(200);

    assertEqual(recorderB.ofType("chunk").length, 0, "no chunk of A reached the view displaying B");
    assertEqual(recorderB.ofType("turn").length, 0, "no turn message of A reached the view displaying B");
    assert(recorderB.ofType("sessions").length > 0, "the session list update reached the view displaying B");
    assertEqual(view.sessionId, b, "the view still displays B");
    assertEqual(api.controller.snapshot(b).items.length, 0, "B's transcript is still empty");
    assert(messagesOf(api.controller.snapshot(a)).length >= 2, "A has the exchange");
  } finally {
    view.dispose();
  }
});

test("F10.7 each chat tab is a session group: its list, its new sessions, and closing it ends them", async ({ api }) => {
  await ensureReady(api);
  const before = panelTabs().length;
  const p1 = api.panel.openNew();
  const p2 = api.panel.openNew();
  const [s1, s2] = await waitFor(
    () => {
      const a = api.panel.sessionOf(p1);
      const b = api.panel.sessionOf(p2);
      return a && b ? [a, b] : undefined;
    },
    15_000,
    "both tabs to get a session",
  );
  const v1 = api.panel.viewOf(p1);
  const v2 = api.panel.viewOf(p2);
  assert(v1 && v2, "both tabs have a view handle");
  assert(v1.groupId && v2.groupId && v1.groupId !== v2.groupId, `tabs are distinct groups (${v1.groupId}, ${v2.groupId})`);
  assertEqual(v1.snapshot().sessions.map((s) => s.id).join(","), s1, "tab 1 lists only its own session");
  assertEqual(v2.snapshot().sessions.map((s) => s.id).join(","), s2, "tab 2 lists only its own session");

  const s3 = await withTimeout(api.controller.newSession(v1), 15_000, "newSession(tab 1)");
  assert(s3 && s3 !== s1 && s3 !== s2, "a third session was created");
  assertEqual(v1.sessionId, s3, "tab 1 displays the new session");
  const ids1 = v1.snapshot().sessions.map((s) => s.id);
  assertEqual(ids1.length, 2, `tab 1 lists its two sessions (${ids1.join(",")})`);
  assert(ids1.includes(s1) && ids1.includes(s3), "tab 1 lists s1 and s3");
  assertEqual(v2.snapshot().sessions.map((s) => s.id).join(","), s2, "tab 2's list is unchanged");
  assert(
    api.controller.snapshot().sessions.some((s) => s.id === s3),
    "a view without a group (the test recorder) still sees every session",
  );

  // Switching a tab to another tab's session is refused.
  api.controller.selectSession(s2, v1);
  assertEqual(v1.sessionId, s3, "tab 1 keeps its session when asked to show tab 2's");

  p1.dispose();
  await waitFor(
    () => {
      const ids = api.controller.sessionIds();
      return !ids.includes(s1) && !ids.includes(s3) ? true : undefined;
    },
    15_000,
    "tab 1's sessions to close with the tab",
  );
  assert(api.controller.sessionIds().includes(s2), "tab 2's session survives");
  assertEqual(v2.snapshot().sessions.map((s) => s.id).join(","), s2, "tab 2 still lists only its own session");
  p2.dispose();
  await waitFor(() => panelTabs().length === before || undefined, 15_000, "the two tabs to close");
});

test("F10.8 closeSession() of a session waiting for permission rejects the request and settles the turn", async ({ api }) => {
  await closeAllEditors();
  await deleteWorkspaceFile("config.json");
  const id = await freshSession(api);
  const turn = api.controller.prompt("/scenario permission-reject", [], id);
  await waitFor(() => api.permissions.pending()[0], 15_000, "a pending permission request");
  await waitFor(() => statusOf(api, id) === "needs_input" || undefined, 15_000, "the session to need input");

  await withTimeout(api.controller.closeSession(id), 15_000, "closeSession() with a pending permission");
  assertEqual(api.permissions.pending().length, 0, "no permission request is pending any more");
  await withTimeout(turn, 15_000, "the prompt promise to settle");
  assert(!api.controller.sessionIds().includes(id), "the session is gone");
  assert(api.controller.snapshot().sessionId, "a session remains focused");
  await closeAllEditors();
});

test("F10.9 stopping the agent marks every session error; restart() recovers with a fresh session", async ({ api }) => {
  await ensureReady(api);
  const a = await freshSession(api);
  await withTimeout(api.controller.shutdownAgent(), 15_000, "shutdownAgent()");
  await waitFor(() => api.controller.snapshot().connection.status === "stopped" || undefined, 15_000, "connection stopped");
  const summaries = api.controller.snapshot().sessions;
  assert(summaries.length > 0, "the sessions are still listed after the agent stopped");
  for (const summary of summaries) {
    assertEqual(summary.status, "error", `status of ${summary.id} while the agent is down`);
  }

  await withTimeout(api.controller.restart(), 30_000, "restart()");
  const state = await ensureReady(api);
  assert(state.sessionId && state.sessionId !== a, "a fresh session after restart");
  assert(!state.sessions.some((s) => s.id === a), "the old sessions are gone");
  for (const summary of state.sessions) {
    assertEqual(summary.status, "idle", `status of ${summary.id} after restart`);
  }
});
