/** F6 — fs/read_text_file with a dirty editor and agent terminals. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { sharedTerminalName } from "../../src/features/pure/terminalPresentation.js";
import {
  assert,
  assertEqual,
  closeAllEditors,
  dialogs,
  fakeAgentReports,
  freshSession,
  runTourAccepting,
  sleep,
  test,
  toolCall,
  waitFor,
  workspacePath,
  workspaceRoot,
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

// ---------------------------------------------------------------------------
// Writes outside the workspace (D8 addendum: kiroAcp.fs.allowedWriteRoots)
// ---------------------------------------------------------------------------

/** Run the `fs-write` scenario for `target` in a fresh session and wait for its turn to end. */
async function writeThroughAgent(api: Parameters<Parameters<typeof test>[1]>[0]["api"], target: string): Promise<void> {
  const sessionId = await freshSession(api);
  await api.controller.prompt(`/scenario fs-write ${target.split(path.sep).join("/")}`, [], sessionId);
  await waitFor(
    () => {
      const s = api.controller.snapshot(sessionId);
      return !s.turnActive && s.items.length > 1 ? s : undefined;
    },
    15_000,
    "the fs-write turn to end",
  );
  assertEqual(fakeAgentReports(api.controller.snapshot(sessionId)).length, 0, "no fake-agent reports");
}

function fileText(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

async function withWriteRoots<T>(roots: string[] | undefined, fn: () => Promise<T>): Promise<T> {
  const config = vscode.workspace.getConfiguration("kiroAcp");
  const before = config.inspect<string[]>("fs.allowedWriteRoots")?.globalValue;
  await config.update("fs.allowedWriteRoots", roots, vscode.ConfigurationTarget.Global);
  try {
    return await fn();
  } finally {
    await vscode.workspace.getConfiguration("kiroAcp").update("fs.allowedWriteRoots", before, vscode.ConfigurationTarget.Global);
  }
}

test("F6.3 a write into the system temp folder needs no confirmation (default allowed root)", async ({ api }) => {
  const target = path.join(os.tmpdir(), `kiro-e2e-roots-${Date.now()}`, "scratch.txt");
  const dialogsBefore = dialogs.length;
  await withWriteRoots(undefined, () => writeThroughAgent(api, target));
  assertEqual(fileText(target), "written by kiro", "the file was written");
  assertEqual(
    dialogs.slice(dialogsBefore).filter((d) => d.includes("outside the workspace")).length,
    0,
    `no confirmation: ${JSON.stringify(dialogs.slice(dialogsBefore))}`,
  );
  fs.rmSync(path.dirname(target), { recursive: true, force: true });
});

test("F6.4 with no allowed roots a write outside the workspace asks; denied means not written", async ({ api }) => {
  const target = path.join(path.dirname(workspaceRoot()), `outside-${Date.now()}`, "denied.txt");
  const dialogsBefore = dialogs.length;
  await withWriteRoots([], () => writeThroughAgent(api, target));
  const asked = dialogs.slice(dialogsBefore).filter((d) => d.includes("Kiro wants to write a file outside the workspace"));
  assertEqual(asked.length, 1, `one confirmation: ${JSON.stringify(dialogs.slice(dialogsBefore))}`);
  assertEqual(fileText(target), null, "the denied file does not exist");
});

test("F6.5 'Always allow in <folder>' writes the file and adds its folder to the user setting, so the next write does not ask", async ({ api }) => {
  const folder = path.join(path.dirname(workspaceRoot()), `always-${Date.now()}`);
  const first = path.join(folder, "one.txt");
  const second = path.join(folder, "two.txt");
  const win = vscode.window as unknown as Record<string, unknown>;
  const stub = win["showWarningMessage"];
  const asked: string[] = [];
  win["showWarningMessage"] = (message: string, ...rest: unknown[]): Promise<unknown> => {
    asked.push(message);
    const always = rest.find((item): item is string => typeof item === "string" && item.startsWith("Always allow in "));
    return Promise.resolve(always);
  };
  try {
    await withWriteRoots([], async () => {
      await writeThroughAgent(api, first);
      assertEqual(asked.length, 1, "the first write asked");
      assertEqual(fileText(first), "written by kiro", "the first file was written");
      const roots = vscode.workspace.getConfiguration("kiroAcp").inspect<string[]>("fs.allowedWriteRoots")?.globalValue ?? [];
      assert(
        roots.some((r) => path.resolve(r).toLowerCase() === path.resolve(folder).toLowerCase()),
        `the folder was added: ${JSON.stringify(roots)}`,
      );
      await writeThroughAgent(api, second);
      assertEqual(asked.length, 1, "the second write did not ask");
      assertEqual(fileText(second), "written by kiro", "the second file was written");
    });
  } finally {
    win["showWarningMessage"] = stub;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
