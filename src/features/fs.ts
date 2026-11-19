/**
 * `fs/read_text_file` and `fs/write_text_file` (DECISIONS.md D8).
 *
 * Reads prefer open (possibly dirty) editors so the agent sees unsaved
 * edits; writes go through a `WorkspaceEdit` and are saved so the file on
 * disk matches what the agent believes it wrote.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import { isAbsolutePath, isWithinRoot, normalizeFsPath, sliceLines } from "./pure/textRange.js";
import { DEFAULT_WRITE_ROOTS, matchWriteRoot } from "./pure/writeRoots.js";

/** User-level setting (scope `machine`: a workspace's own settings cannot widen it). */
const WRITE_ROOTS_KEY = "fs.allowedWriteRoots";

export interface FsServiceOptions {
  /**
   * Transform content before it is written (used by the diff feature to
   * substitute the user's edited proposal, D7).
   */
  writeInterceptor?: (absPath: string, content: string) => string;
  /**
   * Ask before writing outside every workspace folder and every allowed root.
   * Defaults to a modal warning dialog; tests can inject a stub. `true`
   * allows this write, `"always"` also adds the file's folder to
   * `kiroAcp.fs.allowedWriteRoots`.
   */
  confirmOutsideWorkspace?: (absPath: string) => Promise<boolean | "always">;
  /** The configured allowed roots (default: `kiroAcp.fs.allowedWriteRoots` from user settings). */
  allowedWriteRoots?: () => readonly unknown[];
  /** Add `folder` to the allowed roots (default: append it to the user setting). */
  allowWriteRoot?: (folder: string) => Promise<void>;
}

export interface FsWriteEvent {
  path: string;
  content: string;
}

const decoder = new TextDecoder("utf-8");

function findOpenDocument(absPath: string): vscode.TextDocument | undefined {
  const wanted = normalizeFsPath(absPath);
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === "file" && normalizeFsPath(d.uri.fsPath) === wanted,
  );
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

/** Replace a document's whole text with `content` and save it. */
export async function replaceDocumentText(uri: vscode.Uri, content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, fullRange, content);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error(`Workspace edit rejected for ${uri.fsPath}`);
  }
  if (doc.isDirty) {
    const saved = await doc.save();
    if (!saved) {
      throw new Error(`Could not save ${uri.fsPath}`);
    }
  }
}

export class FsService implements vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<FsWriteEvent>();
  /** Fires after a successful `writeTextFile` with the content actually written. */
  readonly onDidWrite: vscode.Event<FsWriteEvent> = this.writeEmitter.event;

  constructor(private readonly options: FsServiceOptions = {}) {}

  /** ClientServices.readTextFile */
  async readTextFile(req: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const absPath = req.path;
    if (!isAbsolutePath(absPath)) {
      throw new Error("path must be absolute");
    }
    let text: string;
    const open = findOpenDocument(absPath);
    if (open) {
      text = open.getText();
    } else {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
      text = decoder.decode(bytes);
    }
    return { content: sliceLines(text, req.line, req.limit) };
  }

  /** ClientServices.writeTextFile */
  async writeTextFile(req: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const absPath = req.path;
    if (!isAbsolutePath(absPath)) {
      throw new Error("path must be absolute");
    }
    if (!this.isInsideWorkspace(absPath) && !this.isInsideAllowedRoot(absPath)) {
      const confirm = this.options.confirmOutsideWorkspace ?? defaultConfirmOutsideWorkspace;
      const answer = await confirm(absPath);
      if (!answer) {
        throw new Error(`Write to ${absPath} denied by user (outside the workspace)`);
      }
      if (answer === "always") {
        const allow = this.options.allowWriteRoot ?? defaultAllowWriteRoot;
        try {
          await allow(path.dirname(absPath));
        } catch (error) {
          // The write itself was allowed; only remembering the folder failed.
          void vscode.window.showWarningMessage(
            `Could not add ${path.dirname(absPath)} to kiroAcp.fs.allowedWriteRoots: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const content = this.options.writeInterceptor
      ? this.options.writeInterceptor(absPath, req.content)
      : req.content;
    const uri = vscode.Uri.file(absPath);

    if (await fileExists(uri)) {
      await replaceDocumentText(uri, content);
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(absPath)));
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { contents: Buffer.from(content, "utf8"), overwrite: false });
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error(`Workspace edit rejected for ${absPath}`);
      }
      // createFile with contents writes to disk; make sure nothing stays dirty.
      const doc = findOpenDocument(absPath);
      if (doc?.isDirty) {
        await doc.save();
      }
    }
    this.writeEmitter.fire({ path: absPath, content });
    return {};
  }

  dispose(): void {
    this.writeEmitter.dispose();
  }

  private isInsideWorkspace(absPath: string): boolean {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.some((f) => f.uri.scheme === "file" && isWithinRoot(absPath, f.uri.fsPath));
  }

  /** Inside a folder of `kiroAcp.fs.allowedWriteRoots` (by default the OS temp folder). */
  private isInsideAllowedRoot(absPath: string): boolean {
    const roots = this.options.allowedWriteRoots ? this.options.allowedWriteRoots() : configuredWriteRoots();
    return matchWriteRoot(absPath, roots, { tmpdir: os.tmpdir(), home: os.homedir(), env: process.env }) !== null;
  }
}

/** `kiroAcp.fs.allowedWriteRoots`; a non-array value falls back to the default. */
function configuredWriteRoots(): readonly unknown[] {
  const value = vscode.workspace.getConfiguration("kiroAcp").get<unknown>(WRITE_ROOTS_KEY, DEFAULT_WRITE_ROOTS);
  return Array.isArray(value) ? value : DEFAULT_WRITE_ROOTS;
}

/** Append `folder` to the user-level `kiroAcp.fs.allowedWriteRoots` (kept as is when already listed). */
async function defaultAllowWriteRoot(folder: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("kiroAcp");
  const current = config.inspect<unknown>(WRITE_ROOTS_KEY)?.globalValue;
  const list: unknown[] = Array.isArray(current) ? [...current] : [...DEFAULT_WRITE_ROOTS];
  const listed = list.some(
    // The same folder (case-insensitive on Windows): each contains the other.
    (entry) => typeof entry === "string" && isAbsolutePath(entry) && isWithinRoot(entry, folder) && isWithinRoot(folder, entry),
  );
  if (!listed) list.push(folder);
  await config.update(WRITE_ROOTS_KEY, list, vscode.ConfigurationTarget.Global);
}

async function defaultConfirmOutsideWorkspace(absPath: string): Promise<boolean | "always"> {
  const folder = path.dirname(absPath);
  const always = `Always allow in ${folder}`;
  const choice = await vscode.window.showWarningMessage(
    `Kiro wants to write a file outside the workspace:\n${absPath}`,
    {
      modal: true,
      detail: "Folders listed in kiroAcp.fs.allowedWriteRoots (by default the system temp folder) are written without asking.",
    },
    "Write",
    always,
    "Deny",
  );
  if (choice === always) return "always";
  return choice === "Write";
}
