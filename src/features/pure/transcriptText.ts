/**
 * Plain-text rendering of a session transcript for the agent link's
 * `read_session` / `wait_for_session` (D30). Pure; no vscode or Node imports.
 * CONTRACT STUB — implemented in plan Task 8.
 */
import type { TranscriptState } from "./transcript.js";

export interface TranscriptTextOptions {
  /** Render at most the last `last` items (messages and tool calls; thoughts excluded). */
  last: number;
  /** Cut the text to this many characters, dropping the oldest items first. */
  maxChars: number;
}

export interface TranscriptText {
  text: string;
  /** Items rendered. */
  items: number;
  /** Older items (or characters) were left out. */
  truncated: boolean;
}

/**
 * One block per item, oldest first: `user:` / `agent:` text (images and
 * resources as `[image name]` / `[file label]`), a peer message as
 * `message from s2 "title":`, a tool call as `[tool] title — status`.
 * Agent thoughts are left out. Empty transcript → `(no messages yet)`.
 */
export function transcriptText(
  state: Pick<TranscriptState, "items" | "toolCalls">,
  options: TranscriptTextOptions,
): TranscriptText {
  void state;
  void options;
  return { text: "(no messages yet)", items: 0, truncated: false };
}

/** Text of the last agent message (not a thought), cut to `maxChars` keeping its end; null when none. */
export function lastAgentAnswer(state: Pick<TranscriptState, "items">, maxChars: number): string | null {
  void state;
  void maxChars;
  return null;
}
