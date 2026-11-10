/**
 * `fs/read_text_file` and `fs/write_text_file` (DECISIONS.md D8).
 *
 * Reads prefer open (possibly dirty) editors so the agent sees unsaved
 * edits; writes go through a `WorkspaceEdit` and are saved so the file on
 * disk matches what the agent believes it wrote.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import { isAbsolutePath, isWithinRoot, normalizeFsPath, sliceLines } from "./pure/textRange.js";

export interface FsServiceOptions {
  /**
   * Transform content before it is written (used by the diff feature to
   * substitute the user's edited proposal, D7).
   */
  writeInterceptor?: (absPath: string, content: string) => string;
  /**
   * Ask before writing outside every workspace folder. Defaults to a modal
   * warning dialog; tests can inject a stub. Return `true` to allow.
   */
  confirmOutsideWorkspace?: (absPath: string) => Promise<boolean>;
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
    if (!this.isInsideWorkspace(absPath)) {
      const confirm = this.options.confirmOutsideWorkspace ?? defaultConfirmOutsideWorkspace;
      if (!(await confirm(absPath))) {
        throw new Error(`Write to ${absPath} denied by user (outside the workspace)`);
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
}

async function defaultConfirmOutsideWorkspace(absPath: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Kiro wants to write a file outside the workspace:\n${absPath}`,
    { modal: true },
    "Write",
    "Deny",
  );
  return choice === "Write";
}
