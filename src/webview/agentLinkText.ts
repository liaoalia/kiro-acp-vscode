/**
 * Agent link (D30) labels: the "from s2 · “title”" header of a message that
 * another agent session sent, and the session handles of the session list.
 * Pure (no DOM).
 */
import type { MessageOrigin } from "../ui/protocol";

/** Longest sender title shown in a peer message's header before it is cut with "…". */
export const ORIGIN_TITLE_MAX = 48;

/**
 * A well-formed copy of `value`, or undefined when it cannot be one: the
 * `sessionId` must be a non-empty string (clicking the header needs it); a
 * missing handle or title becomes "". Guards the renderer against a snapshot
 * item the reducer never checked.
 */
export function normalizeOrigin(value: unknown): MessageOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.sessionId !== "string" || o.sessionId.length === 0) return undefined;
  return {
    sessionId: o.sessionId,
    handle: typeof o.handle === "string" ? o.handle.trim() : "",
    title: typeof o.title === "string" ? o.title : "",
  };
}

/** Identity of an origin for memo keys and no-op checks; "" when absent or malformed. */
export function originKey(value: unknown): string {
  const origin = normalizeOrigin(value);
  return origin ? [origin.sessionId, origin.handle, origin.title].join("\u0001") : "";
}

/** One line: whitespace runs collapsed, then cut to `max` characters (code points) ending in "…". */
export function truncateTitle(text: string, max = ORIGIN_TITLE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return chars.slice(0, Math.max(1, max - 1)).join("").trimEnd() + "…";
}

export interface OriginLabel {
  /** The sender's handle ("s2"); "" when the host sent none. */
  handle: string;
  /** The sender's title on one line, truncated for display; "" when none. */
  title: string;
  /** Hover text: handle and the full title. */
  tooltip: string;
  /** Accessible name of the header button. */
  ariaLabel: string;
}

/** Texts of the "from s2 · “Fix the login bug”" button on a peer message. */
export function originLabel(origin: MessageOrigin): OriginLabel {
  const handle = origin.handle.trim();
  const full = origin.title.replace(/\s+/g, " ").trim();
  const who = [handle, full].filter((s) => s.length > 0);
  return {
    handle,
    title: truncateTitle(full),
    tooltip: `Sent by another agent session${who.length > 0 ? `: ${who.join(" · ")}` : ""}\nClick to show that session`,
    ariaLabel:
      who.length > 0 ? `Show the session that sent this message (${who.join(" ")})` : "Show the session that sent this message",
  };
}

/** The agent-link handle of a session list entry, trimmed; "" when absent. */
export function sessionHandle(handle: unknown): string {
  return typeof handle === "string" ? handle.trim() : "";
}

/** `"s3 · Fix the login bug"` when the session has a handle, else the title unchanged. */
export function withHandle(handle: unknown, title: string): string {
  const h = sessionHandle(handle);
  return h ? `${h} · ${title}` : title;
}
