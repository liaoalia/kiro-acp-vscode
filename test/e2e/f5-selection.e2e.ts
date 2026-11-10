/** F5 — selection: the sendSelection command adds a selection chip. */
import * as vscode from "vscode";

import { assert, assertEqual, closeAllEditors, samePath, test, waitFor, workspacePath } from "./harness.js";

test("F5.1 kiroAcp.sendSelection adds a selection chip for lines 3-5", async ({ api }) => {
  await closeAllEditors();
  const sample = workspacePath("src", "sample.ts");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sample));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  // 0-based positions: line 2 col 0 .. line 4 col 3 → 1-based lines 3-5.
  editor.selection = new vscode.Selection(new vscode.Position(2, 0), new vscode.Position(4, 3));
  assertEqual(vscode.window.activeTextEditor?.document.uri.fsPath, doc.uri.fsPath, "sample.ts is the active editor");

  await vscode.commands.executeCommand("kiroAcp.sendSelection");

  const chip = await waitFor(
    () => api.contextTracker.chips().find((c) => c.kind === "selection"),
    15_000,
    "a selection chip",
  );
  assertEqual(chip.startLine, 3, "selection start line");
  assertEqual(chip.endLine, 5, "selection end line");
  assertEqual(chip.implicit, false, "selection chip is explicit");
  assertEqual(chip.label, "src/sample.ts", "selection chip label");
  assert(samePath(chip.path, sample), `selection chip path: ${chip.path}`);
  assert(api.controller.snapshot().chips.some((c) => c.id === chip.id), "snapshot lists the selection chip");
});
