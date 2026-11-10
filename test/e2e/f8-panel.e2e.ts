/** F8 — chat as an editor tab (WebviewPanel) and hidden-by-default settings. */
import * as vscode from "vscode";

import { Recorder, allTabs, assert, assertEqual, ensureReady, freshSession, runPrompt, test, waitFor } from "./harness.js";

const PANEL_VIEW_TYPE = "kiroAcp.chatPanel";

function panelTabs(): vscode.Tab[] {
  return allTabs().filter(
    (t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes(PANEL_VIEW_TYPE),
  );
}

test("F8.1 kiroAcp.focus opens the chat as an editor tab by default", async ({ api }) => {
  await ensureReady(api);
  const location = vscode.workspace.getConfiguration("kiroAcp").get<string>("chatLocation");
  assertEqual(location, "editor", "default chatLocation");

  await vscode.commands.executeCommand("kiroAcp.focus");
  await waitFor(() => panelTabs().length === 1 || undefined, 15_000, "the Kiro Chat editor tab");
  assertEqual(panelTabs()[0]?.label, "Kiro Chat", "tab label");

  // Focusing again reveals the same tab instead of opening a second one.
  await vscode.commands.executeCommand("kiroAcp.openInEditor");
  await new Promise((r) => setTimeout(r, 300));
  assertEqual(panelTabs().length, 1, "still one chat tab");
  assert(api.controller.hasView, "the panel webview is attached to the controller");
});

test("F8.2 messages reach both the editor tab and other attached views", async ({ api }) => {
  await freshSession(api);
  // The harness recorder is attached alongside the real panel webview; a turn
  // must still be delivered to the recorder (fan-out, not replacement).
  const recorder = new Recorder();
  const detach = api.controller.attach(recorder.poster);
  try {
    await runPrompt(api, "/scenario chat");
    await waitFor(
      () => (recorder.messages.some((m) => m.type === "turn" && m.active === false) ? true : undefined),
      15_000,
      "turn end at the recorder",
    );
    assert(
      recorder.messages.some((m) => m.type === "chunk" && m.role === "agent"),
      "agent chunks were fanned out to the recorder while the panel is open",
    );
  } finally {
    detach();
  }
});

test("F8.3 pickers are hidden by default (prefs.showSettings=false)", async ({ api }) => {
  const prefs = api.controller.snapshot().prefs;
  assert(prefs !== undefined, "snapshot carries prefs");
  assertEqual(prefs?.showSettings, false, "settings hidden by default");
  const setting = vscode.workspace.getConfiguration("kiroAcp").get<boolean>("showSettingsByDefault");
  assertEqual(setting, false, "showSettingsByDefault default");
});
