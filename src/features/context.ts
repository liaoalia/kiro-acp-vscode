/**
 * Context chips (active file, `@` files, selections) and the `@` file search.
 */
import * as vscode from "vscode";
import type { ContextChip, FileSuggestion } from "../ui/protocol.js";
import { SEARCH_EXCLUDE, globForQuery, sortByScore } from "./pure/fileSearch.js";

export interface ContextTrackerOptions {
  /** Override the `kiroAcp.attachActiveFile` setting (tests). */
  attachActiveFile?: () => boolean;
}

function isTrackableDocument(doc: vscode.TextDocument | undefined): doc is vscode.TextDocument {
  return !!doc && doc.uri.scheme === "file";
}

function relativeLabel(absPath: string): string {
  return vscode.workspace.asRelativePath(absPath, false).replace(/\\/g, "/");
}

export function fileChipId(absPath: string): string {
  return `file:${absPath}`;
}

export function selectionChipId(absPath: string, start: number, end: number): string {
  return `sel:${absPath}:${start}-${end}`;
}

export class ContextTracker implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ContextChip[]>();
  private readonly disposables: vscode.Disposable[] = [];
  private implicit: ContextChip | undefined;
  private implicitRemoved = false;
  private readonly explicit = new Map<string, ContextChip>();
  private readonly attachActiveFile: () => boolean;

  /** Fires with the full chip list after any change. */
  readonly onDidChange: vscode.Event<ContextChip[]> = this.changeEmitter.event;

  constructor(options: ContextTrackerOptions = {}) {
    this.attachActiveFile =
      options.attachActiveFile ??
      (() => vscode.workspace.getConfiguration("kiroAcp").get<boolean>("attachActiveFile", true));
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this.trackEditor(editor)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("kiroAcp.attachActiveFile")) {
          this.fire();
        }
      }),
    );
    this.trackEditor(vscode.window.activeTextEditor);
  }

  /** Current chips: the implicit active-file chip (if any) followed by explicit ones. */
  chips(): ContextChip[] {
    const out: ContextChip[] = [];
    if (this.implicit && !this.implicitRemoved && this.attachActiveFile()) {
      const duplicate = [...this.explicit.values()].some(
        (c) => c.kind === "file" && c.path === this.implicit!.path,
      );
      if (!duplicate) {
        out.push({ ...this.implicit });
      }
    }
    for (const chip of this.explicit.values()) {
      out.push({ ...chip });
    }
    return out;
  }

  /** Remove a chip; the implicit chip stays removed until the next editor change or prompt. */
  removeChip(id: string): void {
    if (this.implicit && id === this.implicit.id) {
      this.implicitRemoved = true;
    } else if (!this.explicit.delete(id)) {
      return;
    }
    this.fire();
  }

  /** Add an explicit `@file` chip. */
  addFileChip(absPath: string): ContextChip {
    const chip: ContextChip = {
      id: fileChipId(absPath),
      kind: "file",
      path: absPath,
      label: relativeLabel(absPath),
      implicit: false,
    };
    this.explicit.set(chip.id, chip);
    this.fire();
    return chip;
  }

  /**
   * Add a selection chip for the active editor's selection (whole current
   * line when the selection is empty). Returns `undefined` when there is no
   * file editor.
   */
  addSelectionChip(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): ContextChip | undefined {
    if (!editor || !isTrackableDocument(editor.document)) {
      return undefined;
    }
    const sel = editor.selection;
    let start: number;
    let end: number;
    if (sel.isEmpty) {
      start = end = sel.active.line + 1;
    } else {
      start = sel.start.line + 1;
      end = sel.end.line + 1;
      if (sel.end.character === 0 && end > start) {
        end -= 1;
      }
    }
    const absPath = editor.document.uri.fsPath;
    const chip: ContextChip = {
      id: selectionChipId(absPath, start, end),
      kind: "selection",
      path: absPath,
      label: relativeLabel(absPath),
      startLine: start,
      endLine: end,
      implicit: false,
    };
    this.explicit.set(chip.id, chip);
    this.fire();
    return chip;
  }

  /** After a prompt: drop explicit chips, re-attach the implicit one. */
  clearExplicit(): void {
    this.explicit.clear();
    this.implicitRemoved = false;
    this.fire();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changeEmitter.dispose();
  }

  private trackEditor(editor: vscode.TextEditor | undefined): void {
    const doc = editor?.document;
    if (!isTrackableDocument(doc)) {
      // Output panels, our kiro-* documents, etc. keep the previous chip.
      return;
    }
    const absPath = doc.uri.fsPath;
    if (this.implicit?.path === absPath && !this.implicitRemoved) {
      return;
    }
    this.implicit = {
      id: fileChipId(absPath),
      kind: "file",
      path: absPath,
      label: relativeLabel(absPath),
      implicit: true,
    };
    this.implicitRemoved = false;
    this.fire();
  }

  private fire(): void {
    this.changeEmitter.fire(this.chips());
  }
}

/**
 * `@` file picker search: `workspace.findFiles` with a `**\/*query*` glob
 * (node_modules/.git/dist/out excluded), ranked by basename match.
 */
export async function searchFiles(
  query: string,
  max = 30,
  token?: vscode.CancellationToken,
): Promise<FileSuggestion[]> {
  const uris = await vscode.workspace.findFiles(
    globForQuery(query),
    SEARCH_EXCLUDE,
    Math.max(max * 5, 50),
    token,
  );
  const items: FileSuggestion[] = uris
    .filter((u) => u.scheme === "file")
    .map((u) => ({ path: u.fsPath, label: relativeLabel(u.fsPath) }));
  return sortByScore(query, items).slice(0, max);
}
