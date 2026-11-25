/**
 * F14 — sign-in: a prompt rejected as "not logged in" switches the connection
 * to `auth_required` with the terminal login fallback; `login()` runs
 * `<cliPath> login` in a terminal and reconnects, keeping a session in the view;
 * every session of every tab comes back with the new process (D25), and a
 * restart (or a sign-in that did not complete) keeps them in their tabs.
 */
import { writeFileSync } from "node:fs";

import * as vscode from "vscode";

import type { KiroAcpApi } from "../../src/extension.js";
import {
  Recorder,
  assert,
  assertEqual,
  ensureReady,
  freshSession,
  messagesOf,
  runPrompt,
  sleep,
  test,
  textOf,
  waitFor,
  withTimeout,
} from "./harness.js";

function loginTerminals(): vscode.Terminal[] {
  return vscode.window.terminals.filter((t) => t.name === "Kiro login");
}

/** `login()` with the fake sign-in (exits 0, the chat reconnects by itself); closes the login terminals after. */
async function signInAgain(api: KiroAcpApi): Promise<void> {
  const opened: vscode.Terminal[] = [];
  const sub = vscode.window.onDidOpenTerminal((t) => opened.push(t));
  try {
    await withTimeout(api.controller.login(), 60_000, "login() and the restore after it");
  } finally {
    sub.dispose();
  }
  for (const t of [...opened, ...loginTerminals()]) t.dispose();
}

test("F14.1 expired token: the prompt failure offers the kiro-cli login fallback and login() reconnects", async ({ api }) => {
  await freshSession(api);
  const before = api.controller.snapshot();
  assertEqual(before.connection.authMethods, undefined, "no auth methods while signed in");

  await runPrompt(api, "/scenario auth-expired");
  const state = await waitFor(
    () => {
      const s = api.controller.snapshot();
      return s.connection.status === "auth_required" ? s : undefined;
    },
    15_000,
    "connection switches to auth_required",
  );
  assert(/not logged in/i.test(state.connection.message ?? ""), `banner carries the agent's reason: ${state.connection.message}`);
  const methods = state.connection.authMethods ?? [];
  assertEqual(methods.length, 1, "one login method offered");
  assertEqual(methods[0]!.id, "kiro-cli-login", "fallback method id");
  assertEqual(methods[0]!.terminal, true, "fallback is a terminal method");
  assertEqual(state.turnActive, false, "turn ended");
  assert(
    !state.notices.some((n) => n.text.startsWith("Prompt failed")),
    "no duplicate 'Prompt failed' notice next to the sign-in banner",
  );

  // `/login` typed in the chat must work in this very state (no ready agent).
  // The sign-in dialog is left unanswered (the harness stub dismisses it): the
  // fake `login` process exits 0, the terminal closes and the chat reconnects
  // by itself.
  const opened: vscode.Terminal[] = [];
  const openedNames: string[] = [];
  const sub = vscode.window.onDidOpenTerminal((t) => {
    opened.push(t);
    openedNames.push(t.name); // the name at creation time; `t.name` may change later
  });
  try {
    await withTimeout(api.controller.prompt("/login", []), 30_000, "/login (auto-reconnect on exit 0)");
  } finally {
    sub.dispose();
  }
  assert(openedNames.includes("Kiro login"), `a 'Kiro login' terminal was opened (opened: ${JSON.stringify(openedNames)})`);
  assert(
    !api.controller.snapshot().notices.some((n) => n.text.startsWith("No active session")),
    "/login was not refused with 'No active session'",
  );
  for (const t of [...opened, ...loginTerminals()]) t.dispose();

  const ready = await ensureReady(api);
  assertEqual(ready.connection.status, "ready", "reconnected after login");
  assert(ready.sessionId, "the view has a session again");
  await sleep(50);
});

test("F14.2 signing in again brings back every session of a tab, the shown one in place, and opens no extra one", async ({ api }) => {
  await ensureReady(api);
  const tabA = api.controller.attachView(new Recorder().poster, { prefer: "fresh", groupId: "f14-tab-a" });
  const tabB = api.controller.attachView(new Recorder().poster, { prefer: "fresh", groupId: "f14-tab-b" });
  try {
    await withTimeout(api.controller.ensureViewSession(tabA), 15_000, "tab A's first session");
    await withTimeout(api.controller.ensureViewSession(tabB), 15_000, "tab B's first session");
    const emptyA = tabA.sessionId;
    const lostB = tabB.sessionId;
    assert(emptyA && lostB && emptyA !== lostB, "each tab has a session of its own");

    // Tab A: two past sessions next to its empty first session, past-1 shown.
    for (const id of ["past-2", "past-1"]) {
      assertEqual(await withTimeout(api.controller.openPastSession(id, tabA), 15_000, `restore ${id}`), id, `${id} opened in tab A`);
      assertEqual(api.controller.sessionGroup(id), "f14-tab-a", `${id} belongs to tab A`);
    }
    assertEqual(tabA.sessionId, "past-1", "tab A shows past-1");
    const conversationsA = tabA
      .snapshot()
      .sessions.map((s) => s.id)
      .filter((id) => id !== emptyA);
    assertEqual([...conversationsA].sort().join(","), "past-1,past-2", "tab A lists both past sessions");

    // Tab B: a conversation the new process will not know (the fake agent keeps live sessions in memory only).
    await withTimeout(api.controller.prompt("/scenario chat", [], lostB), 30_000, "a chat turn in tab B");
    await waitFor(() => !api.controller.snapshot(lostB).turnActive || undefined, 15_000, "tab B's turn to end");
    tabA.focus();
    assertEqual(api.controller.focusedSessionId, "past-1", "tab A's session is focused");

    await signInAgain(api);

    assertEqual(api.controller.snapshot().connection.status, "ready", "reconnected");
    assertEqual(tabA.sessionId, "past-1", "tab A shows past-1 again");
    const a = tabA.snapshot();
    assertEqual(
      a.sessions.map((s) => s.id).join(","),
      conversationsA.join(","),
      "tab A lists its sessions with a conversation in their old order, the empty one and no new one",
    );
    for (const s of a.sessions) assertEqual(s.status, "idle", `status of ${s.id}`);
    assert(
      messagesOf(a).some((m) => m.role === "user" && textOf(m).includes("Why is CI flaky?")),
      "past-1's conversation is back",
    );
    assert(!a.notices.some((n) => n.text.startsWith("Restoring") || n.text.startsWith("Could not")), "tab A shows no restore notice");
    assert(
      messagesOf(api.controller.snapshot("past-2")).some((m) => m.role === "user" && textOf(m).includes("retry")),
      "past-2 (not shown) is restored too, not just listed",
    );
    assert(!api.controller.sessionIds().includes(emptyA), "the empty session was not loaded back");
    assertEqual(api.controller.focusedSessionId, "past-1", "focus is back on the session tab A shows");

    const b = tabB.snapshot();
    assert(b.sessionId && b.sessionId !== lostB, "tab B shows a fresh session in place of the one that could not be loaded");
    assertEqual(b.sessions.map((s) => s.id).join(","), b.sessionId, "tab B lists only its fresh session");
    assert(
      b.notices.some((n) => n.severity === "warning" && n.text.startsWith("Could not restore") && n.text.includes(lostB)),
      `tab B names the session it could not restore (${JSON.stringify(b.notices)})`,
    );
    assert(!api.controller.sessionIds().includes(lostB), "the session that could not be loaded is gone");
  } finally {
    tabA.dispose();
    tabB.dispose();
    await api.controller.closeGroup("f14-tab-a");
    await api.controller.closeGroup("f14-tab-b");
  }
});

// ---------------------------------------------------------------------------
// A restart keeps the sessions (D25 addendum 0.4.4)
// ---------------------------------------------------------------------------

/** The fake agent's shared sign-in state (scripts/run-e2e.mjs sets the path). */
function setSignIn(state: { signedIn: boolean; loginCompletes: boolean }): void {
  const file = process.env.KIRO_FAKE_AUTH_FILE;
  if (!file) throw new Error("KIRO_FAKE_AUTH_FILE is not set (run the e2e tests through scripts/run-e2e.mjs)");
  writeFileSync(file, JSON.stringify(state));
}

type Tab = ReturnType<KiroAcpApi["controller"]["attachView"]>;

/** A tab with its first (empty) session and past-2, past-1 opened in it, past-1 shown. */
async function tabWithPastSessions(api: KiroAcpApi, groupId: string): Promise<Tab> {
  await ensureReady(api);
  const tab = api.controller.attachView(new Recorder().poster, { prefer: "fresh", groupId });
  await withTimeout(api.controller.ensureViewSession(tab), 15_000, `${groupId}'s first session`);
  for (const id of ["past-2", "past-1"]) {
    assertEqual(await withTimeout(api.controller.openPastSession(id, tab), 15_000, `open ${id}`), id, `${id} opened in ${groupId}`);
  }
  assertEqual(tab.sessionId, "past-1", `${groupId} shows past-1`);
  return tab;
}

/** past-1 and past-2 listed in this order, past-1 shown with its conversation. */
function assertPastSessionsShown(tab: Tab, when: string): void {
  const s = tab.snapshot();
  assertEqual(
    s.sessions
      .map((x) => x.id)
      .filter((id) => id.startsWith("past-"))
      .join(","),
    "past-1,past-2",
    `${when}: the tab still lists past-1 and past-2 in their order`,
  );
  assertEqual(s.sessionId, "past-1", `${when}: the tab still shows past-1`);
  assert(
    messagesOf(s).some((m) => m.role === "user" && textOf(m).includes("Why is CI flaky?")),
    `${when}: past-1's conversation is still shown`,
  );
}

function assertHosted(api: KiroAcpApi, ids: readonly string[], when: string): void {
  const processes = api.controller.agentProcesses();
  for (const id of ids) {
    assert(
      processes.some((p) => p.sessionIds.includes(id)),
      `${when}: a process hosts ${id} again (${JSON.stringify(processes)})`,
    );
  }
}

test("F14.3 a sign-in that does not complete keeps every session in its tab; the next sign-in loads them back", async ({ api }) => {
  setSignIn({ signedIn: true, loginCompletes: true });
  const tab = await tabWithPastSessions(api, "f14-tab-incomplete");
  try {
    // The login terminal exits 0, yet Kiro has no usable token (it ended early, or Reconnect was clicked first).
    setSignIn({ signedIn: true, loginCompletes: false });
    await signInAgain(api);

    const waiting = tab.snapshot();
    assertEqual(waiting.connection.status, "auth_required", "the new agent asks for a sign-in");
    assert(/not signed in/i.test(waiting.connection.message ?? ""), `the banner says why: ${waiting.connection.message}`);
    assertPastSessionsShown(tab, "signed out");
    assert(
      waiting.notices.some((n) => n.text.startsWith("This session is not loaded: Kiro is not signed in")),
      `past-1 says it waits for the sign-in (${JSON.stringify(waiting.notices)})`,
    );
    assert(
      waiting.notices.some((n) => n.severity === "warning" && n.text.startsWith("Signing in did not complete")),
      `the sign-in is reported incomplete (${JSON.stringify(waiting.notices)})`,
    );
    assert(!waiting.notices.some((n) => n.text.startsWith("Could not restore")), "no session was given up");

    // This time the sign-in completes (Kiro's own terminal method, `acp --login`).
    setSignIn({ signedIn: false, loginCompletes: true });
    await signInAgain(api);

    const back = tab.snapshot();
    assertEqual(back.connection.status, "ready", "signed in");
    assertPastSessionsShown(tab, "signed in again");
    assertHosted(api, ["past-1", "past-2"], "signed in again");
    assert(
      !back.notices.some((n) => n.text.startsWith("This session is not loaded")),
      `the waiting notice is withdrawn (${JSON.stringify(back.notices)})`,
    );
    assert(
      messagesOf(api.controller.snapshot("past-2")).some((m) => m.role === "user" && textOf(m).includes("retry")),
      "past-2 (not shown) kept its conversation too",
    );
  } finally {
    setSignIn({ signedIn: true, loginCompletes: true });
    tab.dispose();
    await api.controller.closeGroup("f14-tab-incomplete");
  }
});

test("F14.4 Restart keeps every session of a tab and loads it back", async ({ api }) => {
  const tab = await tabWithPastSessions(api, "f14-tab-restart");
  try {
    tab.focus();
    await withTimeout(api.controller.restart(), 60_000, "restart()");
    const s = tab.snapshot();
    assertEqual(s.connection.status, "ready", "restarted");
    assertPastSessionsShown(tab, "after Restart");
    assertHosted(api, ["past-1", "past-2"], "after Restart");
    assertEqual(api.controller.focusedSessionId, "past-1", "focus stays on the session the tab shows");
    assert(
      !s.notices.some((n) => n.text.startsWith("Could not restore") || n.text.startsWith("This session is not loaded")),
      `no restore notice (${JSON.stringify(s.notices)})`,
    );
  } finally {
    tab.dispose();
    await api.controller.closeGroup("f14-tab-restart");
  }
});

test("F14.5 signing in while the agent is down keeps the sessions", async ({ api }) => {
  const tab = await tabWithPastSessions(api, "f14-tab-down");
  try {
    await withTimeout(api.controller.shutdownAgent(), 15_000, "shutdownAgent()");
    await waitFor(
      () => (["stopped", "error"].includes(api.controller.snapshot().connection.status) ? true : undefined),
      15_000,
      "the agent is down",
    );
    assertPastSessionsShown(tab, "agent down");
    await signInAgain(api);
    assertEqual(tab.snapshot().connection.status, "ready", "signed in");
    assertPastSessionsShown(tab, "after the sign-in");
    assertHosted(api, ["past-1", "past-2"], "after the sign-in");
  } finally {
    tab.dispose();
    await api.controller.closeGroup("f14-tab-down");
  }
});
