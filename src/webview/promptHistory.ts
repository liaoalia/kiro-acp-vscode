/**
 * Composer history: the prompts sent from this webview, recalled with Up /
 * Down like a shell. Pure (no DOM); the composer owns persistence.
 */
export const HISTORY_LIMIT = 100;

export class PromptHistory {
  private readonly entries: string[];
  /** `entries.length` while not browsing; else the index of the shown entry. */
  private index: number;
  /** What the composer held when browsing started, restored past the newest entry. */
  private draft = "";

  constructor(entries: readonly string[] = []) {
    this.entries = entries.filter((e) => typeof e === "string" && e.length > 0).slice(-HISTORY_LIMIT);
    this.index = this.entries.length;
  }

  /** The stored prompts, oldest first. */
  list(): readonly string[] {
    return this.entries;
  }

  /** True while an earlier prompt is shown instead of the draft. */
  get browsing(): boolean {
    return this.index < this.entries.length;
  }

  /** Record a sent prompt (a repeat of the newest entry is not stored twice) and leave browsing. */
  push(text: string): void {
    if (text.length > 0 && this.entries[this.entries.length - 1] !== text) {
      this.entries.push(text);
      if (this.entries.length > HISTORY_LIMIT) this.entries.splice(0, this.entries.length - HISTORY_LIMIT);
    }
    this.reset();
  }

  /** Forget the browsing position (the user edited the text or sent it). */
  reset(): void {
    this.index = this.entries.length;
    this.draft = "";
  }

  /**
   * Move one entry back (`-1`, Up) or forward (`+1`, Down). `current` is the
   * composer text; it becomes the draft when browsing starts. Returns the
   * text to show, or null at either end (the caller leaves the key to the
   * textarea).
   */
  recall(direction: -1 | 1, current: string): string | null {
    const next = this.index + direction;
    if (next < 0 || next > this.entries.length) return null;
    if (!this.browsing) this.draft = current;
    this.index = next;
    return next === this.entries.length ? this.draft : (this.entries[next] ?? null);
  }
}
