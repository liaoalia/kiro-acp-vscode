/**
 * Entry point loaded by VS Code (`--extensionTestsPath`). Exports `run()`,
 * which registers the suites in a fixed order, activates the extension and
 * executes every test sequentially, failing fast with a diagnostic dump.
 */
import * as vscode from "vscode";

import {
  Recorder,
  allTabs,
  dialogs,
  getApi,
  installDialogStubs,
  registeredTests,
  withTimeout,
  type TestContext,
} from "./harness.js";

// Order matters: F5 reveals the chat view (which attaches the real webview
// poster), so it runs last. The runner re-attaches the recorder before each
// test anyway.
import "./f1-chat.e2e.js";
import "./f2-diff.e2e.js";
import "./f3-plan.e2e.js";
import "./f4-context.e2e.js";
import "./f6-fs-terminal.e2e.js";
import "./f7-permissions.e2e.js";
import "./f8-panel.e2e.js";
import "./f5-selection.e2e.js";

const TEST_TIMEOUT_MS = 60_000;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

function describeTabs(): string[] {
  return allTabs().map((tab) => {
    const input = tab.input;
    let detail: string;
    if (input instanceof vscode.TabInputTextDiff) {
      detail = `diff ${input.original.toString()} <> ${input.modified.toString()}`;
    } else if (input instanceof vscode.TabInputText) {
      detail = `text ${input.uri.toString()}`;
    } else {
      detail = `other ${JSON.stringify(input)}`;
    }
    return `${tab.group.viewColumn}:${tab.label} [${detail}]${tab.isDirty ? " dirty" : ""}${tab.isPreview ? " preview" : ""}`;
  });
}

function dumpDiagnostics(ctx: TestContext): void {
  const state = ctx.api.controller.snapshot();
  console.log("---- diagnostics ----");
  console.log(`connection: ${JSON.stringify(state.connection)}`);
  console.log(`sessionId: ${state.sessionId} turnActive: ${state.turnActive}`);
  console.log(`pending permissions: ${JSON.stringify(state.permissions)}`);
  console.log(`notices: ${JSON.stringify(state.notices)}`);
  console.log(`dialogs: ${JSON.stringify(dialogs)}`);
  console.log(`open tabs: ${JSON.stringify(describeTabs())}`);
  console.log(`open diffs: ${JSON.stringify(ctx.api.diff.openToolCallIds())}`);
  console.log("last ToWebview messages (max 50):");
  for (const message of ctx.recorder.last(50)) {
    let line: string;
    try {
      line = JSON.stringify(message);
    } catch {
      line = String(message);
    }
    console.log(`  ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
  }
  console.log("---------------------");
}

export async function run(): Promise<void> {
  const tests = registeredTests();
  console.log(`[e2e] ${tests.length} tests registered`);
  const restoreDialogs = installDialogStubs();
  const api = await getApi();
  const recorder = new Recorder();
  const ctx: TestContext = { api, recorder };
  const suiteStart = Date.now();
  let passed = 0;

  try {
    for (const { name, fn } of tests) {
      api.controller.attach(recorder.poster);
      recorder.reset();
      const start = Date.now();
      try {
        await withTimeout(fn(ctx), TEST_TIMEOUT_MS, `test "${name}"`);
        passed++;
        console.log(`PASS ${name} (${Date.now() - start} ms)`);
      } catch (error) {
        console.log(`FAIL ${name} (${Date.now() - start} ms)`);
        console.log(describeError(error));
        dumpDiagnostics(ctx);
        throw new Error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`[e2e] ${passed}/${tests.length} passed in ${((Date.now() - suiteStart) / 1000).toFixed(1)} s`);
  } finally {
    restoreDialogs();
    api.controller.detach();
  }
}
