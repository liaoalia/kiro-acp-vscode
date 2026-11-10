/** F6 — fs/read_text_file with a dirty editor and agent terminals. */
import * as vscode from "vscode";

import {
  assert,
  assertEqual,
  closeAllEditors,
  fakeAgentReports,
  freshSession,
  runTourAccepting,
  test,
  toolCall,
  waitFor,
  workspacePath,
} from "./harness.js";

test("F6.1 the read tool sees unsaved edits and the execute tool runs in a Kiro terminal", async ({ api }) => {
  await freshSession(api);
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

  const terminalsBefore = vscode.window.terminals.filter((t) => t.name.startsWith("Kiro:")).length;
  const state = await runTourAccepting(api);

  const reports = fakeAgentReports(state);
  assertEqual(reports.length, 0, `fake agent reported no failures: ${JSON.stringify(reports)}`);

  const read = toolCall(state, "call-read");
  assertEqual(read.kind, "read", "read tool kind");
  assertEqual(read.status, "completed", "read tool status");
  assert(read.locations.some((l) => l.path.endsWith("README.md")), "read tool location is README.md");
  assertEqual(readme.isDirty, true, "README is still dirty (the read did not save it)");

  const kiroTerminals = await waitFor(
    () => {
      const list = vscode.window.terminals.filter((t) => t.name.startsWith("Kiro:"));
      return list.length > terminalsBefore ? list : undefined;
    },
    15_000,
    "a Kiro terminal",
  );
  assert(kiroTerminals.some((t) => t.name.includes("echo")), `terminal name: ${kiroTerminals.map((t) => t.name).join(", ")}`);
  assertEqual(api.terminal.activeIds().length, 0, "the agent released its terminal");

  const exec = toolCall(state, "call-exec");
  assertEqual(exec.kind, "execute", "execute tool kind");
  assertEqual(exec.status, "completed", "execute tool status");
  const terminal = exec.content.find((c) => c.type === "terminal");
  assert(terminal && terminal.type === "terminal", "execute card has terminal content");
  assert(terminal.output.includes("hello"), `terminal output: ${JSON.stringify(terminal.output)}`);
  assertEqual(terminal.exitCode, 0, "terminal exit code");
  assert(api.terminal.showTerminal(terminal.terminalId), "showTerminal works after release");

  // Leave the workspace clean for the next test.
  await vscode.window.showTextDocument(readme, { preview: false });
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await waitFor(() => !readme.isDirty, 15_000, "README to be reverted");
});
