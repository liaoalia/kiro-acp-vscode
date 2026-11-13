/**
 * F14 — sign-in: a prompt rejected as "not logged in" switches the connection
 * to `auth_required` with the terminal login fallback; `login()` runs
 * `<cliPath> login` in a terminal and reconnects, keeping a session in the view;
 * every session of every tab comes back with the new process (D25).
 */
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
