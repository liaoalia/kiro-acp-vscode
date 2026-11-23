/**
 * Per-session prompt history (Up / Down in the composer), host side. Pure (no
 * `vscode` import): the controller keeps one list per `ChatSession` and
 * stores them in `workspaceState` by session id, so a session restored later
 * (Past sessions, a sign-in restore) recalls its own prompts again.
 *
 * Only text typed in a composer is recorded (the webview's `prompt`
 * message): prompts an agent session sent (D30), queued API prompts and the
 * history Kiro replays are never offered.
 */

/** Prompts kept per session (the webview's `HISTORY_LIMIT` is the same). */
export const PROMPT_HISTORY_LIMIT = 100;
/** Sessions whose history is stored; those a prompt was recorded in least recently are forgotten first. */
export const PROMPT_HISTORY_SESSIONS = 30;
/** Characters stored per session: the oldest prompts go first (a huge paste must not bloat `workspaceState`). */
export const PROMPT_HISTORY_CHARS = 128 * 1024;

/** One session's stored history: when it was last recorded, and its prompts oldest first. */
export interface StoredPromptHistory {
  at: number;
  entries: string[];
}

/** Session id → its stored history. */
export type PromptHistories = Record<string, StoredPromptHistory>;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((e) => typeof e === "string");
}

/** `entries` plus `text` (not when empty or a repeat of the newest entry), at most {@link PROMPT_HISTORY_LIMIT}. */
export function appendPrompt(entries: readonly string[], text: string): string[] {
  if (text.length === 0 || entries[entries.length - 1] === text) return entries.slice(-PROMPT_HISTORY_LIMIT);
  return [...entries, text].slice(-PROMPT_HISTORY_LIMIT);
}

/** The newest prompts of `entries` that fit {@link PROMPT_HISTORY_CHARS} together (oldest dropped first). */
export function boundedForStorage(entries: readonly string[]): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as string;
    if (chars + entry.length > PROMPT_HISTORY_CHARS) break;
    chars += entry.length;
    kept.push(entry);
  }
  return kept.reverse();
}

/** The stored map, with malformed entries dropped (the value comes from `workspaceState`). */
export function parsePromptHistories(raw: unknown): PromptHistories {
  const out: PromptHistories = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const { at, entries } = value as { at?: unknown; entries?: unknown };
    if (typeof at !== "number" || !isStringArray(entries)) continue;
    out[sessionId] = { at, entries: entries.filter((e) => e.length > 0).slice(-PROMPT_HISTORY_LIMIT) };
  }
  return out;
}

/**
 * `histories` with `sessionId`'s prompts set to `entries` (bounded for
 * storage) as of `now`, keeping the {@link PROMPT_HISTORY_SESSIONS} most
 * recently recorded sessions. An empty list removes the session.
 */
export function withSessionHistory(
  histories: PromptHistories,
  sessionId: string,
  entries: readonly string[],
  now: number,
): PromptHistories {
  const next: PromptHistories = { ...histories };
  delete next[sessionId];
  const stored = boundedForStorage(entries);
  if (stored.length > 0) next[sessionId] = { at: now, entries: stored };
  const ids = Object.keys(next);
  if (ids.length <= PROMPT_HISTORY_SESSIONS) return next;
  ids.sort((a, b) => (next[b] as StoredPromptHistory).at - (next[a] as StoredPromptHistory).at);
  for (const id of ids.slice(PROMPT_HISTORY_SESSIONS)) delete next[id];
  return next;
}
