/**
 * F14 — sign-in: a prompt rejected as "not logged in" switches the connection
 * to `auth_required` with the terminal login fallback; `login()` runs
 * `<cliPath> login` in a terminal and reconnects, keeping a session in the view.
 */
import * as vscode from "vscode";

import { assert, assertEqual, ensureReady, freshSession, runPrompt, sleep, test, waitFor, withTimeout } from "./harness.js";

function loginTerminals(): vscode.Terminal[] {
  return vscode.window.terminals.filter((t) => t.name === "Kiro login");
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

  // `/login` typed in the chat must work in this very state (no ready agent):
  // the sign-in dialog asks the user to click Reconnect; answer it for them.
  const win = vscode.window as unknown as Record<string, unknown>;
  const original = win.showInformationMessage;
  win.showInformationMessage = () => Promise.resolve("Reconnect");
  // VS Code renames the terminal after the (fake) `login` command exits, so
  // remember the terminals opened during the sign-in instead of filtering by name.
  const opened: vscode.Terminal[] = [];
  const openedNames: string[] = [];
  const sub = vscode.window.onDidOpenTerminal((t) => {
    opened.push(t);
    openedNames.push(t.name); // the name at creation time; `t.name` changes later
  });
  try {
    await withTimeout(api.controller.prompt("/login", []), 30_000, "/login");
  } finally {
    win.showInformationMessage = original;
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
