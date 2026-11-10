/**
 * Pure bookkeeping for proposed-change diffs (DECISIONS.md D7).
 *
 * Tracks which diffs are open per tool call and the `{path, agentText,
 * userText}` substitutions recorded when the user accepted an edited
 * proposal. vscode-free; tested in `test/features-diffState.test.ts`.
 */

export interface DiffSpec {
  /** Absolute path of the file the agent wants to change. */
  path: string;
  /** Original content; `null` for new files. */
  oldText: string | null;
  /** Content proposed by the agent. */
  newText: string;
}

export interface Substitution {
  /** Normalised path (see the `normalize` constructor option). */
  path: string;
  /** What the agent proposed (and will presumably write). */
  agentText: string;
  /** What the user turned it into in the proposed editor. */
  userText: string;
}

export interface TrackedDiff {
  index: number;
  diff: DiffSpec;
}

export class DiffState {
  private readonly diffs = new Map<string, Map<number, DiffSpec>>();
  private subs: Array<{ toolCallId: string; sub: Substitution }> = [];

  /**
   * @param normalize path normaliser applied to every path so lookups by
   *   `takeSubstitution` match regardless of separators/drive-letter case.
   */
  constructor(private readonly normalize: (p: string) => string = (p) => p) {}

  /** Remember a diff (index within the tool call's content) for `toolCallId`. */
  register(toolCallId: string, index: number, diff: DiffSpec): void {
    let byIndex = this.diffs.get(toolCallId);
    if (!byIndex) {
      byIndex = new Map();
      this.diffs.set(toolCallId, byIndex);
    }
    byIndex.set(index, { ...diff });
  }

  /** Diffs registered for a tool call, ordered by index. */
  diffsFor(toolCallId: string): TrackedDiff[] {
    const byIndex = this.diffs.get(toolCallId);
    if (!byIndex) {
      return [];
    }
    return [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, diff]) => ({ index, diff }));
  }

  /** One diff by index. */
  diffAt(toolCallId: string, index: number): DiffSpec | undefined {
    return this.diffs.get(toolCallId)?.get(index);
  }

  hasDiffs(toolCallId: string): boolean {
    return (this.diffs.get(toolCallId)?.size ?? 0) > 0;
  }

  /** Tool call ids with open diffs, oldest first. */
  toolCallIds(): string[] {
    return [...this.diffs.keys()];
  }

  /** Forget the diffs (not the substitutions) of a tool call. */
  remove(toolCallId: string): void {
    this.diffs.delete(toolCallId);
  }

  /**
   * Record that the user accepted `userText` instead of `agentText` for
   * `path`. Replaces an earlier substitution for the same tool call + path.
   */
  addSubstitution(toolCallId: string, sub: Substitution): void {
    const path = this.normalize(sub.path);
    this.subs = this.subs.filter((s) => !(s.toolCallId === toolCallId && s.sub.path === path));
    this.subs.push({ toolCallId, sub: { ...sub, path } });
  }

  /**
   * If a substitution exists for `path` whose `agentText` equals `content`,
   * remove it and return its `userText`; otherwise `undefined`.
   */
  takeSubstitution(path: string, content: string): string | undefined {
    const key = this.normalize(path);
    const idx = this.subs.findIndex((s) => s.sub.path === key && s.sub.agentText === content);
    if (idx < 0) {
      return undefined;
    }
    const [hit] = this.subs.splice(idx, 1);
    return hit!.sub.userText;
  }

  /** Substitutions still pending for a tool call. */
  pendingFor(toolCallId: string): Substitution[] {
    return this.subs.filter((s) => s.toolCallId === toolCallId).map((s) => ({ ...s.sub }));
  }

  /** Drop every substitution of a tool call (e.g. on failed/cancelled). */
  dropSubstitutions(toolCallId: string): void {
    this.subs = this.subs.filter((s) => s.toolCallId !== toolCallId);
  }

  /** All pending substitutions (diagnostics/tests). */
  substitutions(): Array<{ toolCallId: string; sub: Substitution }> {
    return this.subs.map((s) => ({ toolCallId: s.toolCallId, sub: { ...s.sub } }));
  }

  /** Forget everything. */
  clear(): void {
    this.diffs.clear();
    this.subs = [];
  }
}
