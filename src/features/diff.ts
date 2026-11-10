/**
 * Native diff editors for proposed file changes (DECISIONS.md D7).
 *
 * - `kiro-original:` — read-only TextDocumentContentProvider for the current/old text.
 * - `kiro-proposed:` — in-memory, editable FileSystemProvider for the agent's proposal.
 *
 * Accept/Reject (editor title buttons or chat card) answer the pending
 * permission of the tool call. When the user edited the proposal before
 * accepting, the edited text is substituted for the agent's text at write
 * time (via {@link DiffManager.interceptWrite}) or reconciled after the tool
 * call completes.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { ToolDiffContent } from "../ui/protocol.js";
import type { PermissionManager } from "./permissions.js";
import { replaceDocumentText } from "./fs.js";
import { DiffState, type DiffSpec } from "./pure/diffState.js";
import { normalizeFsPath } from "./pure/textRange.js";

export const PROPOSED_SCHEME = "kiro-proposed";
export const ORIGINAL_SCHEME = "kiro-original";
export const DIFF_PENDING_CONTEXT_KEY = "kiroAcp.diffPending";
export const ACCEPT_DIFF_COMMAND = "kiroAcp.acceptDiff";
export const REJECT_DIFF_COMMAND = "kiroAcp.rejectDiff";

interface DiffEntry {
  toolCallId: string;
  index: number;
  /** Absolute path of the real file. */
  filePath: string;
  original: string;
  proposed: Uint8Array;
  ctime: number;
  mtime: number;
  /** `uri.path` shared by both schemes. */
  key: string;
}

export interface OpenDiffOptions {
  preview?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function makeKey(toolCallId: string, index: number, filePath: string): string {
  const base = path.basename(filePath) || "file";
  return `/${encodeURIComponent(toolCallId)}/${index}/${base}`;
}

function makeUri(scheme: string, key: string, filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme, path: key, query: `path=${encodeURIComponent(filePath)}` });
}

async function readDisk(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export class DiffManager implements vscode.Disposable, vscode.FileSystemProvider {
  private readonly entries = new Map<string, DiffEntry>();
  /** `vscode.diff` opens still in flight, by entry key; awaited before closing. */
  private readonly opening = new Map<string, Promise<void>>();
  private readonly state = new DiffState((p) => normalizeFsPath(p));
  private readonly fsEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly originalEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly logger: { info(m: string): void; warn(m: string): void };

  /** FileSystemProvider event for `kiro-proposed:`. */
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.fsEmitter.event;

  /**
   * @param permissions used to answer the tool call's permission on accept/reject
   *   and to learn when it was answered elsewhere (chat card, cancel).
   */
  constructor(
    private readonly permissions: PermissionManager,
    options: { logger?: { info(m: string): void; warn(m: string): void } } = {},
  ) {
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
    const originalProvider: vscode.TextDocumentContentProvider = {
      onDidChange: this.originalEmitter.event,
      provideTextDocumentContent: (uri) => this.entries.get(uri.path)?.original ?? "",
    };
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(PROPOSED_SCHEME, this, {
        isCaseSensitive: true,
      }),
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originalProvider),
      vscode.commands.registerCommand(ACCEPT_DIFF_COMMAND, (arg?: unknown) =>
        this.runCommand(arg, true),
      ),
      vscode.commands.registerCommand(REJECT_DIFF_COMMAND, (arg?: unknown) =>
        this.runCommand(arg, false),
      ),
      vscode.window.onDidChangeActiveTextEditor(() => void this.updateContextKey()),
      permissions.onDidChange(() => void this.updateContextKey()),
      permissions.onDidResolve((res) => {
        if (this.state.hasDiffs(res.toolCallId)) {
          void this.finalize(res.toolCallId, res.outcome === "allow");
        }
      }),
    );
    void this.updateContextKey();
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Open (or refresh) the diff editor for one `diff` content item of a tool
   * call. The original side is `oldText`, else the file on disk, else empty.
   * An already open proposed document with unsaved edits is not overwritten.
   */
  async openDiff(
    toolCallId: string,
    index: number,
    diff: { path: string; oldText: string | null; newText: string },
    options: OpenDiffOptions = {},
  ): Promise<void> {
    const key = makeKey(toolCallId, index, diff.path);
    const existing = this.entries.get(key);
    const original = diff.oldText ?? (await readDisk(diff.path)) ?? "";
    const spec: DiffSpec = { path: diff.path, oldText: diff.oldText, newText: diff.newText };
    this.state.register(toolCallId, index, spec);

    if (existing) {
      const doc = this.findProposedDocument(key);
      const changed: vscode.FileChangeEvent[] = [];
      if (existing.original !== original) {
        existing.original = original;
        this.originalEmitter.fire(makeUri(ORIGINAL_SCHEME, key, diff.path));
      }
      if (!(doc && doc.isDirty)) {
        const bytes = encoder.encode(diff.newText);
        if (decoder.decode(existing.proposed) !== diff.newText) {
          existing.proposed = bytes;
          existing.mtime = Date.now();
          changed.push({
            type: vscode.FileChangeType.Changed,
            uri: makeUri(PROPOSED_SCHEME, key, diff.path),
          });
        }
      }
      if (changed.length > 0) {
        this.fsEmitter.fire(changed);
      }
    } else {
      const now = Date.now();
      this.entries.set(key, {
        toolCallId,
        index,
        filePath: diff.path,
        original,
        proposed: encoder.encode(diff.newText),
        ctime: now,
        mtime: now,
        key,
      });
    }

    const title = `${path.basename(diff.path)} (Kiro proposal)`;
    // Track the open so finalize() cannot close the editor before it exists
    // (a policy-answered permission can arrive while vscode.diff is in flight).
    const open: Promise<void> = Promise.resolve(
      vscode.commands.executeCommand(
        "vscode.diff",
        makeUri(ORIGINAL_SCHEME, key, diff.path),
        makeUri(PROPOSED_SCHEME, key, diff.path),
        title,
        { preview: options.preview ?? false },
      ),
    ).then(() => undefined);
    this.opening.set(key, open);
    try {
      await open;
    } finally {
      if (this.opening.get(key) === open) {
        this.opening.delete(key);
      }
    }
    void this.updateContextKey();
  }

  /** Text of the proposed side, including unsaved edits in an open editor. */
  currentProposedText(toolCallId: string, index: number): string | undefined {
    const entry = this.findEntry(toolCallId, index);
    if (!entry) {
      return undefined;
    }
    const doc = this.findProposedDocument(entry.key);
    return doc ? doc.getText() : decoder.decode(entry.proposed);
  }

  /** Tool call ids that currently have diffs open, oldest first. */
  openToolCallIds(): string[] {
    return this.state.toolCallIds();
  }

  /**
   * Accept the proposal(s) of a tool call: record substitutions for edited
   * files, answer the pending permission with allow, close the diff editors.
   */
  async accept(toolCallId: string): Promise<void> {
    await this.finalize(toolCallId, true);
    const pending = this.permissions.pendingForToolCall(toolCallId);
    if (pending) {
      this.permissions.decideRequest(pending.requestId, "allow");
    }
  }

  /** Reject the proposal(s): answer the permission with reject, close editors. */
  async reject(toolCallId: string): Promise<void> {
    await this.finalize(toolCallId, false);
    const pending = this.permissions.pendingForToolCall(toolCallId);
    if (pending) {
      this.permissions.decideRequest(pending.requestId, "reject");
    }
  }

  /**
   * `writeInterceptor` for {@link FsService}: when the agent writes exactly
   * the text the user edited away from, write the user's text instead.
   */
  interceptWrite(filePath: string, content: string): string {
    const substituted = this.state.takeSubstitution(filePath, content);
    if (substituted !== undefined) {
      this.logger.info(`diff: substituted user edits for ${filePath}`);
      return substituted;
    }
    return content;
  }

  /**
   * Called when a tool call reaches `completed`: substitutions whose file on
   * disk now equals the agent's text (the agent wrote directly) are applied
   * via WorkspaceEdit + save. Remaining substitutions are dropped.
   * @param diffs the final diff contents of the tool call; a file equal to
   *   its final `newText` is treated like one equal to `agentText`.
   */
  async reconcileToolCallCompleted(toolCallId: string, diffs?: ToolDiffContent[]): Promise<void> {
    for (const sub of this.state.pendingFor(toolCallId)) {
      const disk = await readDisk(sub.path);
      if (disk === undefined) {
        continue;
      }
      const finalDiff = diffs?.find((d) => normalizeFsPath(d.path) === sub.path);
      const candidates = new Set<string>([sub.agentText]);
      if (finalDiff) {
        candidates.add(finalDiff.newText);
      }
      if (candidates.has(disk) && disk !== sub.userText) {
        try {
          await replaceDocumentText(vscode.Uri.file(sub.path), sub.userText);
          this.logger.info(`diff: applied user edits to ${sub.path} after completion`);
        } catch (err) {
          this.logger.warn(`diff: could not apply user edits to ${sub.path}: ${String(err)}`);
        }
      }
    }
    this.state.dropSubstitutions(toolCallId);
    if (this.state.hasDiffs(toolCallId) && !this.permissions.pendingForToolCall(toolCallId)) {
      await this.finalize(toolCallId, false);
    }
  }

  /** Called when a tool call ends `failed`/`cancelled`: drop everything for it. */
  async reconcileToolCallEnded(
    toolCallId: string,
    status: "completed" | "failed" | "cancelled",
    diffs?: ToolDiffContent[],
  ): Promise<void> {
    if (status === "completed") {
      await this.reconcileToolCallCompleted(toolCallId, diffs);
      return;
    }
    this.state.dropSubstitutions(toolCallId);
    if (this.state.hasDiffs(toolCallId)) {
      await this.finalize(toolCallId, false);
    }
  }

  /** Pending substitutions (diagnostics). */
  pendingSubstitutions(toolCallId: string) {
    return this.state.pendingFor(toolCallId);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.fsEmitter.dispose();
    this.originalEmitter.dispose();
    this.entries.clear();
    this.state.clear();
  }

  // ---------------------------------------------------------------------
  // FileSystemProvider (kiro-proposed:)
  // ---------------------------------------------------------------------

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.entries.get(uri.path);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type: vscode.FileType.File,
      ctime: entry.ctime,
      mtime: entry.mtime,
      size: entry.proposed.byteLength,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // Directories are implicit.
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const entry = this.entries.get(uri.path);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return entry.proposed;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const entry = this.entries.get(uri.path);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    entry.proposed = content;
    entry.mtime = Date.now();
    this.fsEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(uri: vscode.Uri): void {
    if (this.entries.delete(uri.path)) {
      this.fsEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Kiro proposals cannot be renamed");
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private findEntry(toolCallId: string, index: number): DiffEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.toolCallId === toolCallId && entry.index === index) {
        return entry;
      }
    }
    return undefined;
  }

  private entriesFor(toolCallId: string): DiffEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.toolCallId === toolCallId)
      .sort((a, b) => a.index - b.index);
  }

  private findProposedDocument(key: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === PROPOSED_SCHEME && d.uri.path === key,
    );
  }

  /** Which tool call a command invocation refers to. */
  private resolveTarget(arg: unknown): string | undefined {
    const uri =
      arg instanceof vscode.Uri
        ? arg
        : vscode.window.activeTextEditor?.document.uri;
    if (uri && (uri.scheme === PROPOSED_SCHEME || uri.scheme === ORIGINAL_SCHEME)) {
      const entry = this.entries.get(uri.path);
      if (entry) {
        return entry.toolCallId;
      }
    }
    // Command palette: most recent tool call with a pending permission, else newest diff.
    const ids = this.state.toolCallIds();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (this.permissions.pendingForToolCall(ids[i]!)) {
        return ids[i];
      }
    }
    return ids[ids.length - 1];
  }

  private async runCommand(arg: unknown, accept: boolean): Promise<void> {
    const toolCallId = this.resolveTarget(arg);
    if (!toolCallId) {
      void vscode.window.showInformationMessage("No Kiro proposal is open.");
      return;
    }
    if (accept) {
      await this.accept(toolCallId);
    } else {
      await this.reject(toolCallId);
    }
  }

  /**
   * Record substitutions (when accepted), close the diff editors of the tool
   * call and drop its in-memory documents. Idempotent.
   */
  private async finalize(toolCallId: string, accepted: boolean): Promise<void> {
    const entries = this.entriesFor(toolCallId);
    if (entries.length === 0 && !this.state.hasDiffs(toolCallId)) {
      return;
    }
    if (accepted) {
      for (const entry of entries) {
        const spec = this.state.diffAt(toolCallId, entry.index);
        const userText = this.currentProposedText(toolCallId, entry.index);
        if (spec && userText !== undefined && userText !== spec.newText) {
          this.state.addSubstitution(toolCallId, {
            path: spec.path,
            agentText: spec.newText,
            userText,
          });
          this.logger.info(`diff: recorded user edits for ${spec.path}`);
        }
      }
    }
    this.state.remove(toolCallId);
    await Promise.allSettled(entries.map((e) => this.opening.get(e.key) ?? Promise.resolve()));
    await this.closeEditors(entries);
    for (const entry of entries) {
      this.entries.delete(entry.key);
    }
    if (entries.length > 0) {
      this.fsEmitter.fire(
        entries.map((e) => ({
          type: vscode.FileChangeType.Deleted,
          uri: makeUri(PROPOSED_SCHEME, e.key, e.filePath),
        })),
      );
    }
    void this.updateContextKey();
  }

  private async closeEditors(entries: DiffEntry[]): Promise<void> {
    const keys = new Set(entries.map((e) => e.key));
    const isOurs = (uri: vscode.Uri) =>
      (uri.scheme === PROPOSED_SCHEME || uri.scheme === ORIGINAL_SCHEME) && keys.has(uri.path);
    // Save dirty proposals first so closing does not prompt.
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === PROPOSED_SCHEME && keys.has(doc.uri.path) && doc.isDirty) {
        try {
          await doc.save();
        } catch {
          // ignore
        }
      }
    }
    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff) {
          if (isOurs(input.original) || isOurs(input.modified)) {
            tabs.push(tab);
          }
        } else if (input instanceof vscode.TabInputText && isOurs(input.uri)) {
          tabs.push(tab);
        }
      }
    }
    if (tabs.length > 0) {
      try {
        await vscode.window.tabGroups.close(tabs, true);
      } catch (err) {
        this.logger.warn(`diff: could not close editors: ${String(err)}`);
      }
    }
  }

  private async updateContextKey(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    let pending = false;
    if (uri && uri.scheme === PROPOSED_SCHEME) {
      const entry = this.entries.get(uri.path);
      pending = !!entry && this.permissions.pendingForToolCall(entry.toolCallId) !== undefined;
    }
    try {
      await vscode.commands.executeCommand("setContext", DIFF_PENDING_CONTEXT_KEY, pending);
    } catch {
      // best-effort
    }
  }
}
