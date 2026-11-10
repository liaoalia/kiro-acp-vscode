/**
 * Minimal async test harness for the extension-host integration tests.
 *
 * No mocha: `test()` registers a case, `index.ts` runs them in order, prints
 * one line per test and stops at the first failure. Everything here runs
 * inside the VS Code extension host, so `vscode` is available.
 */
import * as path from "node:path";
import * as vscode from "vscode";

import type { KiroAcpApi } from "../../src/extension.js";
import type {
  ContextChip,
  MessageView,
  ToWebview,
  ToolCallView,
  UiState,
} from "../../src/ui/protocol.js";

export const EXTENSION_ID = "liaoalia.kiro-acp";
export const DEFAULT_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface TestContext {
  api: KiroAcpApi;
  recorder: Recorder;
}

export interface TestCase {
  name: string;
  fn: (t: TestContext) => Promise<void>;
}

const registry: TestCase[] = [];

export function test(name: string, fn: (t: TestContext) => Promise<void>): void {
  registry.push({ name, fn });
}

export function registeredTests(): readonly TestCase[] {
  return registry;
}

// ---------------------------------------------------------------------------
// Assertions and waiting
// ---------------------------------------------------------------------------

export class AssertionError extends Error {
  override name = "AssertionError";
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AssertionError(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` every 50 ms until it returns a truthy value (which is
 * returned) or `timeoutMs` elapses (which throws naming `label`).
 */
export async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs: number = DEFAULT_TIMEOUT,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new AssertionError(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    }
    await sleep(50);
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AssertionError(`Timed out after ${timeoutMs} ms waiting for ${label}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// ToWebview recorder (stands in for the chat webview)
// ---------------------------------------------------------------------------

export class Recorder {
  readonly messages: ToWebview[] = [];
  readonly poster = (message: ToWebview): void => {
    this.messages.push(message);
  };

  reset(): void {
    this.messages.length = 0;
  }

  /** Index to pass to `since()` later. */
  mark(): number {
    return this.messages.length;
  }

  since(mark: number): ToWebview[] {
    return this.messages.slice(mark);
  }

  ofType<K extends ToWebview["type"]>(type: K, mark = 0): Array<Extract<ToWebview, { type: K }>> {
    return this.since(mark).filter((m): m is Extract<ToWebview, { type: K }> => m.type === type);
  }

  last(n: number): ToWebview[] {
    return this.messages.slice(-n);
  }
}

// ---------------------------------------------------------------------------
// Extension / workspace access
// ---------------------------------------------------------------------------

let apiPromise: Promise<KiroAcpApi> | undefined;

export function getApi(): Promise<KiroAcpApi> {
  if (!apiPromise) {
    const extension = vscode.extensions.getExtension<KiroAcpApi>(EXTENSION_ID);
    if (!extension) {
      throw new Error(`Extension ${EXTENSION_ID} is not installed in the test host`);
    }
    apiPromise = Promise.resolve(extension.activate());
  }
  return apiPromise;
}

export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("No workspace folder is open in the test host");
  }
  return folder.uri.fsPath;
}

export function workspacePath(...segments: string[]): string {
  return path.join(workspaceRoot(), ...segments);
}

export function samePath(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export async function readWorkspaceFile(rel: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(workspacePath(rel)));
  return new TextDecoder("utf-8").decode(bytes);
}

export async function workspaceFileExists(rel: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(workspacePath(rel)));
    return true;
  } catch {
    return false;
  }
}

export async function deleteWorkspaceFile(rel: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(workspacePath(rel)), { useTrash: false });
  } catch {
    // did not exist
  }
}

// ---------------------------------------------------------------------------
// Modal dialog stubs
// ---------------------------------------------------------------------------

export const dialogs: string[] = [];

/**
 * The tour scenario sends `_kiro/openExternalUrl`, which the extension answers
 * with a *modal* information message; nobody can click it in the test host and
 * the fake agent waits for the answer. Replace the message functions with
 * stubs that record the text and resolve `undefined` ("dismissed"). The test
 * runner and the extension share the same `vscode` API object, so the stub is
 * visible to the extension.
 */
export function installDialogStubs(): () => void {
  const win = vscode.window as unknown as Record<string, unknown>;
  const names = ["showInformationMessage", "showWarningMessage", "showErrorMessage"] as const;
  const originals = new Map<string, unknown>();
  for (const name of names) {
    const original = win[name];
    originals.set(name, original);
    const stub = (message: string): Promise<undefined> => {
      dialogs.push(`${name}: ${message}`);
      return Promise.resolve(undefined);
    };
    try {
      win[name] = stub;
    } catch {
      Object.defineProperty(win, name, { value: stub, configurable: true, writable: true });
    }
    if (win[name] !== stub) {
      console.warn(`[e2e] could not stub vscode.window.${name}; modal dialogs may block the tour`);
    }
  }
  return () => {
    for (const [name, original] of originals) {
      try {
        win[name] = original;
      } catch {
        Object.defineProperty(win, name, { value: original, configurable: true, writable: true });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Agent / session helpers
// ---------------------------------------------------------------------------

/** Start the agent (idempotent) and wait until a session exists. */
export async function ensureReady(api: KiroAcpApi): Promise<UiState> {
  await withTimeout(api.controller.ensureStarted(), DEFAULT_TIMEOUT, "ensureStarted()");
  return waitFor(
    () => {
      const state = api.controller.snapshot();
      return state.connection.status === "ready" && state.sessionId ? state : undefined;
    },
    DEFAULT_TIMEOUT,
    "connection ready with a session",
  );
}

/** Open a fresh session (cancelling any running turn) and return its id. */
export async function freshSession(api: KiroAcpApi): Promise<string> {
  await ensureReady(api);
  const before = api.controller.snapshot().sessionId;
  await withTimeout(api.controller.newSession(), DEFAULT_TIMEOUT, "newSession()");
  const state = await waitFor(
    () => {
      const s = api.controller.snapshot();
      return s.sessionId && s.sessionId !== before && !s.turnActive ? s : undefined;
    },
    DEFAULT_TIMEOUT,
    "a new session id",
  );
  return state.sessionId!;
}

/** Send a prompt and wait for the turn to end. */
export async function runPrompt(api: KiroAcpApi, text: string, chips: ContextChip[] = []): Promise<void> {
  await withTimeout(api.controller.prompt(text, chips), 30_000, `turn for ${JSON.stringify(text)}`);
  await waitFor(() => !api.controller.snapshot().turnActive, DEFAULT_TIMEOUT, "turn to end");
}

export function messagesOf(state: UiState): MessageView[] {
  return state.items.flatMap((item) => (item.type === "message" ? [item.message] : []));
}

export function textOf(message: MessageView): string {
  return message.segments.map((s) => (s.type === "text" ? s.text : "")).join("");
}

export function toolCall(state: UiState, id: string): ToolCallView {
  const call = state.toolCalls[id];
  assert(call, `tool call ${id} is missing from the transcript`);
  return call;
}

export function lastStopReason(recorder: Recorder, mark: number): string | undefined {
  const turns = recorder.ofType("turn", mark).filter((t) => !t.active);
  return turns[turns.length - 1]?.stopReason;
}

/** Agent/thought messages that carry a fake-agent expectation report. */
export function fakeAgentReports(state: UiState): string[] {
  return messagesOf(state)
    .map(textOf)
    .filter((text) => text.includes("[fake-agent]"));
}

// ---------------------------------------------------------------------------
// Editor helpers
// ---------------------------------------------------------------------------

export const PROPOSED_SCHEME = "kiro-proposed";
export const PLAN_SCHEME = "kiro-plan";

export function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

/** Diff editor tabs whose modified side is a Kiro proposal. */
export function proposedDiffTabs(): Array<{ tab: vscode.Tab; original: vscode.Uri; modified: vscode.Uri }> {
  const out: Array<{ tab: vscode.Tab; original: vscode.Uri; modified: vscode.Uri }> = [];
  for (const tab of allTabs()) {
    const input = tab.input;
    if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === PROPOSED_SCHEME) {
      out.push({ tab, original: input.original, modified: input.modified });
    }
  }
  return out;
}

/** Any tab (diff or plain) showing a Kiro proposal document. */
export function proposalTabsOpen(): boolean {
  return allTabs().some((tab) => {
    const input = tab.input;
    if (input instanceof vscode.TabInputTextDiff) {
      return input.modified.scheme === PROPOSED_SCHEME || input.original.scheme === "kiro-original";
    }
    return input instanceof vscode.TabInputText && input.uri.scheme === PROPOSED_SCHEME;
  });
}

/** Revert dirty file documents, then close every editor tab. */
export async function closeAllEditors(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === "file" && doc.isDirty) {
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(() => allTabs().length === 0, DEFAULT_TIMEOUT, "all editors to close");
}

/**
 * Run the tour scenario and accept its `hello.txt` proposal unchanged through
 * the DiffManager API. Returns the final UI state.
 */
export async function runTourAccepting(api: KiroAcpApi): Promise<UiState> {
  const turn = api.controller.prompt("/scenario tour", []);
  const permission = await waitFor(
    () => api.permissions.pending().find((p) => p.hasDiff),
    DEFAULT_TIMEOUT,
    "the tour's edit permission request",
  );
  await waitFor(() => proposedDiffTabs().length > 0, DEFAULT_TIMEOUT, "the proposal diff editor");
  await api.diff.accept(permission.toolCallId);
  await withTimeout(turn, 30_000, "the tour turn");
  await waitFor(() => !api.controller.snapshot().turnActive, DEFAULT_TIMEOUT, "tour turn to end");
  return api.controller.snapshot();
}
