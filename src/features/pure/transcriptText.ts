/**
 * Plain-text rendering of a session transcript for the agent link's
 * `read_session` / `wait_for_session` (D30). Pure; no vscode or Node imports.
 */
import type { MessageSegment, MessageView, TranscriptItem } from "../../ui/protocol";
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

/** The text of an empty transcript. */
export const EMPTY_TRANSCRIPT_TEXT = "(no messages yet)";
/** Marks text cut at its start. */
const ELLIPSIS = "…";
/** Between two rendered items. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * One block per item, oldest first: `user:` / `agent:` text (images and
 * resources as `[image name]` / `[file label]`), a peer message as
 * `message from s2 "title":`, a tool call as `[tool] title — status`.
 * Agent thoughts are left out. Empty transcript → `(no messages yet)`.
 *
 * Thoughts, messages without text and tool items whose call is unknown do not
 * count toward `last` (at least 1). When the blocks do not fit `maxChars`, the
 * oldest are dropped; when the newest alone does not fit, its end is kept
 * after a leading `…`. `truncated` is set whenever anything was left out.
 */
export function transcriptText(
  state: Pick<TranscriptState, "items" | "toolCalls">,
  options: TranscriptTextOptions,
): TranscriptText {
  const all: string[] = [];
  for (const item of state.items) {
    const block = renderItem(item, state.toolCalls);
    if (block !== null) all.push(block);
  }
  if (all.length === 0) return { text: EMPTY_TRANSCRIPT_TEXT, items: 0, truncated: false };

  const last = Math.max(1, Math.floor(options.last));
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const wanted = all.slice(-last);
  let truncated = wanted.length < all.length;

  // Newest first, keep blocks while the joined text still fits.
  const kept: string[] = [];
  let length = 0;
  for (let i = wanted.length - 1; i >= 0; i -= 1) {
    const block = wanted[i]!;
    const added = kept.length === 0 ? block.length : block.length + BLOCK_SEPARATOR.length;
    if (length + added > maxChars) break;
    kept.unshift(block);
    length += added;
  }
  if (kept.length < wanted.length) truncated = true;
  if (kept.length === 0) {
    // The newest block alone is too long: keep its end.
    return { text: keepEnd(wanted[wanted.length - 1]!, maxChars), items: 1, truncated: true };
  }
  return { text: kept.join(BLOCK_SEPARATOR), items: kept.length, truncated };
}

/** Text of the last agent message (not a thought), cut to `maxChars` keeping its end; null when none. */
export function lastAgentAnswer(state: Pick<TranscriptState, "items">, maxChars: number): string | null {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i]!;
    if (item.type !== "message" || item.message.role !== "agent") continue;
    const text = item.message.segments
      .map((segment) => (segment.type === "text" ? segment.text : ""))
      .join("")
      .trim();
    if (text.length === 0) return null;
    return keepEnd(text, Math.max(1, Math.floor(maxChars)));
  }
  return null;
}

/** One item as a block of text, null when it is left out. */
function renderItem(item: TranscriptItem, toolCalls: TranscriptState["toolCalls"]): string | null {
  if (item.type === "tool") {
    const call = toolCalls[item.toolCallId];
    if (!call) return null;
    return `[tool] ${call.title || "(untitled)"} — ${call.status}`;
  }
  return renderMessage(item.message);
}

function renderMessage(message: MessageView): string | null {
  if (message.role === "thought") return null;
  const text = segmentsText(message.segments);
  if (text.length === 0) return null;
  if (message.role === "agent") return `agent: ${text}`;
  if (message.origin) {
    return `message from ${message.origin.handle} ${JSON.stringify(message.origin.title)}: ${text}`;
  }
  return `user: ${text}`;
}

/** Text and chips of a message, a space between a chip and its neighbours, trimmed. */
function segmentsText(segments: readonly MessageSegment[]): string {
  let out = "";
  let previousWasChip = false;
  for (const segment of segments) {
    const isChip = segment.type !== "text";
    const piece = segment.type === "text" ? segment.text : chipText(segment);
    if (piece.length === 0) continue;
    if ((isChip || previousWasChip) && out.length > 0 && !/\s$/.test(out) && !/^\s/.test(piece)) out += " ";
    out += piece;
    previousWasChip = isChip;
  }
  return out.trim();
}

function chipText(segment: Exclude<MessageSegment, { type: "text" }>): string {
  if (segment.type === "resource") return `[file ${segment.label || segment.uri}]`;
  return segment.name ? `[image ${segment.name}]` : "[image]";
}

/** The last `maxChars - 1` characters of `text` after `…`, or `text` when it fits; never splits a surrogate pair. */
function keepEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let start = text.length - (maxChars - ELLIPSIS.length);
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return ELLIPSIS + text.slice(start);
}
