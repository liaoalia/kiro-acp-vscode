/** F2 — diff: native diff editor, user edits before accept, reject path. */
import * as vscode from "vscode";

import {
  PROPOSED_SCHEME,
  assert,
  assertEqual,
  closeAllEditors,
  deleteWorkspaceFile,
  freshSession,
  lastStopReason,
  proposalTabsOpen,
  proposedDiffTabs,
  readWorkspaceFile,
  test,
  toolCall,
  waitFor,
  withTimeout,
  workspaceFileExists,
} from "./harness.js";

test("F2.1 accepting an edited proposal writes the user's text and closes the diff", async ({ api, recorder }) => {
  await freshSession(api);
  await closeAllEditors();
  await deleteWorkspaceFile("hello.txt");
  const mark = recorder.mark();

  const turn = api.controller.prompt("/scenario tour", []);
  const permission = await waitFor(
    () => api.permissions.pending().find((p) => p.hasDiff),
    15_000,
    "a pending permission with a diff",
  );
  assertEqual(permission.kind, "edit", "permission tool kind");
  assertEqual(permission.toolCallId, "call-edit", "permission tool call id");
  assertEqual(permission.title, "Create hello.txt", "permission title");
  assertEqual(permission.options.length, 4, "four permission options");
  assert(permission.consent?.capability === "fs_write", "Kiro consent context is surfaced");
  assert(
    recorder.ofType("permission", mark).some((p) => p.request.requestId === permission.requestId),
    "the permission request was posted to the webview",
  );

  const diff = await waitFor(() => proposedDiffTabs()[0], 15_000, "the proposal diff editor tab");
  assertEqual(diff.modified.scheme, PROPOSED_SCHEME, "modified side scheme");
  assertEqual(diff.original.scheme, "kiro-original", "original side scheme");
  assert(diff.tab.label.includes("hello.txt"), `diff tab label: ${diff.tab.label}`);

  // Edit the proposal before accepting.
  const doc = await vscode.workspace.openTextDocument(diff.modified);
  assertEqual(doc.getText(), "hello from kiro\n", "proposed text before editing");
  const edit = new vscode.WorkspaceEdit();
  edit.insert(diff.modified, doc.positionAt(doc.getText().length), "edited by user\n");
  assert(await vscode.workspace.applyEdit(edit), "workspace edit applied to the proposal");
  assertEqual(doc.isDirty, true, "proposal document is dirty after the edit");
  assertEqual(
    api.diff.currentProposedText("call-edit", 0),
    "hello from kiro\nedited by user\n",
    "DiffManager sees the unsaved edit",
  );

  // Accept from the active editor (command palette / title button without an argument).
  await vscode.window.showTextDocument(diff.modified, { preview: false });
  assertEqual(vscode.window.activeTextEditor?.document.uri.scheme, PROPOSED_SCHEME, "active editor is the proposal");
  await vscode.commands.executeCommand("kiroAcp.acceptDiff");

  await waitFor(() => api.permissions.pending().length === 0, 15_000, "the permission to be answered");
  await withTimeout(turn, 30_000, "the tour turn");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn to end");

  const state = api.controller.snapshot();
  assertEqual(lastStopReason(recorder, mark), "end_turn", "stop reason");
  const call = toolCall(state, "call-edit");
  assertEqual(call.status, "completed", "edit tool call status");
  assertEqual(call.failureReason, undefined, "edit tool call failure reason");
  assertEqual(await readWorkspaceFile("hello.txt"), "hello from kiro\nedited by user\n", "hello.txt on disk");
  await waitFor(() => !proposalTabsOpen(), 15_000, "proposal editors to close");
  assertEqual(api.diff.openToolCallIds().length, 0, "no diffs remain registered");
  assert(
    recorder.ofType("permissionResolved", mark).some((p) => p.requestId === permission.requestId),
    "permissionResolved was posted",
  );
});

test("F2.2 rejecting a proposal fails the tool call with reason denied and writes nothing", async ({ api, recorder }) => {
  await freshSession(api);
  await closeAllEditors();
  await deleteWorkspaceFile("config.json");
  const mark = recorder.mark();

  const turn = api.controller.prompt("/scenario permission-reject", []);
  const permission = await waitFor(
    () => api.permissions.pending().find((p) => p.hasDiff),
    15_000,
    "a pending permission with a diff",
  );
  assertEqual(permission.title, "Overwrite config.json", "permission title");
  const diff = await waitFor(() => proposedDiffTabs()[0], 15_000, "the proposal diff editor tab");
  const original = await vscode.workspace.openTextDocument(diff.original);
  assertEqual(original.getText(), "{}", "original side shows oldText");

  // Reject through the editor title button path (the resource URI is the argument).
  await vscode.commands.executeCommand("kiroAcp.rejectDiff", diff.modified);

  await waitFor(() => api.permissions.pending().length === 0, 15_000, "the permission to be answered");
  await withTimeout(turn, 30_000, "the permission-reject turn");
  await waitFor(() => !api.controller.snapshot().turnActive, 15_000, "turn to end");

  const state = api.controller.snapshot();
  assertEqual(lastStopReason(recorder, mark), "end_turn", "stop reason");
  const call = toolCall(state, "call-edit");
  assertEqual(call.status, "failed", "edit tool call status");
  assertEqual(call.failureReason, "denied", "edit tool call failure reason");
  assertEqual(await workspaceFileExists("config.json"), false, "config.json was not written");
  await waitFor(() => !proposalTabsOpen(), 15_000, "proposal editors to close");
});
