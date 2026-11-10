/** F6 — fs/read_text_file with a dirty editor and agent terminals. */
import * as vscode from "vscode";

import { sharedTerminalName } from "../../src/features/pure/terminalPresentation.js";
import {
  assert,
  assertEqual,
  closeAllEditors,
  fakeAgentReports,
  freshSession,
  runTourAccepting,
  sleep,
  test,
  toolCall,
  waitFor,
  workspacePath,
} from "./harness.js";

/** Every terminal this extension creates (`Kiro · <session>` or `Kiro: <command>`). */
function kiroTerminals(): vscode.Terminal[] {
  return vscode.window.terminals.filter((t) => t.name.startsWith("Kiro"));
}

test("F6.1 the read tool sees unsaved edits and the execute tool runs in the session's shared terminal", async ({ api }) => {
  const sessionId = await freshSession(api);
  await closeAllEditors();

  // Open README.md with an unsaved modification so fs/read_text_file must
  // read the editor buffer rather than the disk.
  const readmeUri = vscode.Uri.file(workspacePath("README.md"));
  const readme = await vscode.workspace.openTextDocument(readmeUri);
  await vscode.window.showTextDocument(readme, { preview: false });
  const edit = new vscode.WorkspaceEdit();
  edit.insert(readmeUri, new vscode.Position(0, 0), "unsaved line added by the e2e test\n");
  assert(await vscode.workspace.applyEdit(edit), "README edit applied");
  assertEqual(readme.isDirty, true, "README is dirty before the prompt");

  assertEqual(api.terminal.currentMode(), "shared", "default terminal mode");
  const terminalsBefore = kiroTerminals().length;
  const state = await runTourAccepting(api);

  const reports = fakeAgentReports(state);
  assertEqual(reports.length, 0, `fake agent reported no failures: ${JSON.stringify(reports)}`);

  const read = toolCall(state, "call-read");
  assertEqual(read.kind, "read", "read tool kind");
  assertEqual(read.status, "completed", "read tool status");
  assert(read.locations.some((l) => l.path.endsWith("README.md")), "read tool location is README.md");
  assertEqual(readme.isDirty, true, "README is still dirty (the read did not save it)");

  // Exactly one new terminal, named after the session rather than the command.
  const expectedName = sharedTerminalName(sessionId);
  const sharedTerminal = await waitFor(
    () => kiroTerminals().find((t) => t.name === expectedName),
    15_000,
    `a terminal named ${expectedName}`,
  );
  assertEqual(
    kiroTerminals().length,
    terminalsBefore + 1,
    `one Kiro terminal added: ${kiroTerminals().map((t) => t.name).join(", ")}`,
  );
  assertEqual(api.terminal.activeIds().length, 0, "the agent released its terminal");

  const exec = toolCall(state, "call-exec");
  assertEqual(exec.kind, "execute", "execute tool kind");
  assertEqual(exec.status, "completed", "execute tool status");
  const terminal = exec.content.find((c) => c.type === "terminal");
  assert(terminal && terminal.type === "terminal", "execute card has terminal content");
  assert(terminal.output.includes("hello"), `terminal output: ${JSON.stringify(terminal.output)}`);
  assertEqual(terminal.exitCode, 0, "terminal exit code");
  // Ids are unique per extension-host run (`term-<run>-<n>`) and lookups are
  // session-checked, so a restored session's replayed ids never resolve to
  // another session's live terminal (D9/D21).
  assert(
    /^term-[A-Za-z0-9]+-\d+$/.test(terminal.terminalId),
    `terminal id carries the run id: ${terminal.terminalId}`,
  );
  assert(api.terminal.snapshot(terminal.terminalId, sessionId), "snapshot works with the owning session id");
  assert(api.terminal.showTerminal(terminal.terminalId, sessionId), "showTerminal works with the owning session id");
  assertEqual(
    api.terminal.snapshot(terminal.terminalId, "some-other-session"),
    undefined,
    "snapshot is refused for another session",
  );
  assertEqual(
    api.terminal.showTerminal(terminal.terminalId, "some-other-session"),
    false,
    "showTerminal is refused for another session",
  );
  assert(api.terminal.showTerminal(terminal.terminalId), "showTerminal works after release");
  // After terminal/release the command is cut off: its snapshot is frozen
  // (the pseudoterminal's bytes are not observable through the public API,
  // so the mirroring cut-off itself is covered by the unit test of
  // shouldMirrorOutput in test/features-terminalPresentation.test.ts).
  const released = api.terminal.snapshot(terminal.terminalId);
  assert(released, "the released terminal still has a snapshot");
  assertEqual(released.exitCode, 0, "the released snapshot carries the exit code");
  await sleep(200);
  assertEqual(api.terminal.snapshot(terminal.terminalId)?.output, released.output, "no bytes reach the released snapshot later");

  // A second command in the same session reuses the shared terminal.
  const again = await runTourAccepting(api);
  assertEqual(fakeAgentReports(again).length, 0, "second tour reported no failures");
  const exec2 = toolCall(again, "call-exec");
  const terminal2 = exec2.content.find((c) => c.type === "terminal");
  assert(terminal2 && terminal2.type === "terminal", "second execute card has terminal content");
  assert(terminal2.terminalId !== terminal.terminalId, "the second command has its own terminal id");
  assertEqual(terminal2.exitCode, 0, "second terminal exit code");
  assertEqual(
    kiroTerminals().length,
    terminalsBefore + 1,
    `still one Kiro terminal after a second command: ${kiroTerminals().map((t) => t.name).join(", ")}`,
  );
  assert(kiroTerminals().includes(sharedTerminal), "the same shared terminal is still open");
  assert(api.terminal.showTerminal(terminal2.terminalId), "showTerminal works for the second command");

  // Leave the workspace clean for the next test.
  await vscode.window.showTextDocument(readme, { preview: false });
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await waitFor(() => !readme.isDirty, 15_000, "README to be reverted");
});

test("F6.2 terminal.mode=hidden creates no VS Code terminal but the card still gets the output", async ({ api }) => {
  const config = vscode.workspace.getConfiguration("kiroAcp");
  const previous = config.inspect<string>("terminal.mode")?.workspaceValue;
  await config.update("terminal.mode", "hidden", vscode.ConfigurationTarget.Workspace);
  try {
    await waitFor(() => api.terminal.currentMode() === "hidden", 15_000, "terminal mode to be hidden");
    await freshSession(api);
    await closeAllEditors();
    const terminalsBefore = kiroTerminals().length;

    const state = await runTourAccepting(api);
    assertEqual(fakeAgentReports(state).length, 0, "fake agent reported no failures");

    const exec = toolCall(state, "call-exec");
    assertEqual(exec.status, "completed", "execute tool status");
    const terminal = exec.content.find((c) => c.type === "terminal");
    assert(terminal && terminal.type === "terminal", "execute card has terminal content");
    assert(terminal.output.includes("hello"), `terminal output: ${JSON.stringify(terminal.output)}`);
    assertEqual(terminal.exitCode, 0, "terminal exit code");
    assertEqual(api.terminal.activeIds().length, 0, "the agent released its terminal");
    assertEqual(kiroTerminals().length, terminalsBefore, "no Kiro terminal was created in hidden mode");
    assertEqual(api.terminal.showTerminal(terminal.terminalId), false, "showTerminal reports no terminal");
  } finally {
    await vscode.workspace
      .getConfiguration("kiroAcp")
      .update("terminal.mode", previous, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => api.terminal.currentMode() === "shared", 15_000, "terminal mode restored");
  }
});
