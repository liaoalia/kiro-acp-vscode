/**
 * Context-window and token usage of a session, assembled from whichever
 * updates the agent sends (DECISIONS D26):
 *
 * - ACP `usage_update` (`used` / `size` tokens in context, optional `cost`);
 * - Kiro V3 `session_info_update` with `_meta.kiro.kind = "context_usage"`
 *   (`usagePercentage`);
 * - Kiro V3 `session_info_update` with `_meta.kiro.kind = "turn_completion"`
 *   (`promptTurnSummaries`, the turn's metering; token fields are summed);
 * - the reply of `_kiro/session/context` (polled after a turn when the agent
 *   never reported a percentage itself), read defensively: numbers under
 *   the usual keys at any depth, else "NN%" / "A of B tokens" in its text.
 *
 * Only `usagePercentage` is documented by Kiro; the other Kiro fields are read
 * defensively (any numeric `...tokens` field) until a real exchange is
 * recorded. Pure: no vscode, no I/O.
 */
import type { SessionUsage } from "../../ui/protocol.js";

export type { SessionUsage };

export const EMPTY_USAGE: SessionUsage = {
  contextPercent: null,
  contextUsed: null,
  contextSize: null,
  tokensSpent: null,
  cost: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** First finite number found under any of `keys`, in `objects` order. */
function pick(objects: Array<Record<string, unknown> | null>, keys: string[]): number | null {
  for (const obj of objects) {
    if (!obj) continue;
    for (const key of keys) {
      const n = finiteNumber(obj[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

function kiroMeta(update: Record<string, unknown>): Record<string, unknown> | null {
  const meta = update._meta;
  if (!isRecord(meta)) return null;
  return isRecord(meta.kiro) ? meta.kiro : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

const TOTAL_KEY = /^total.?tokens$/i;
const TOKEN_KEY = /tokens?$/i;

/**
 * Tokens reported by one metering object: its `totalTokens` when present,
 * else the sum of every numeric `...tokens` field, nested objects included
 * (`{ usage: { inputTokens, outputTokens } }`), three levels deep.
 */
export function tokenTotal(entry: unknown, depth = 0): number {
  if (!isRecord(entry) || depth > 3) return 0;
  for (const [key, value] of Object.entries(entry)) {
    const n = finiteNumber(value);
    if (n !== null && TOTAL_KEY.test(key)) return n;
  }
  let sum = 0;
  for (const [key, value] of Object.entries(entry)) {
    const n = finiteNumber(value);
    if (n !== null) {
      if (TOKEN_KEY.test(key)) sum += n;
    } else if (isRecord(value)) {
      sum += tokenTotal(value, depth + 1);
    }
  }
  return sum;
}

function sameCost(a: SessionUsage["cost"], b: SessionUsage["cost"]): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.amount === b.amount && a.currency === b.currency;
}

function same(a: SessionUsage, b: SessionUsage): boolean {
  return (
    a.contextPercent === b.contextPercent &&
    a.contextUsed === b.contextUsed &&
    a.contextSize === b.contextSize &&
    a.tokensSpent === b.tokensSpent &&
    sameCost(a.cost, b.cost)
  );
}

/**
 * Fold one `session/update` payload into `usage`. Returns the new usage, or
 * `null` when the update carries nothing about usage (or nothing new).
 */
export function applyUsageUpdate(usage: SessionUsage, update: unknown): SessionUsage | null {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") return null;
  let next: SessionUsage = usage;

  if (update.sessionUpdate === "usage_update") {
    const used = finiteNumber(update.used);
    const size = finiteNumber(update.size);
    next = { ...next };
    if (used !== null) next.contextUsed = used;
    if (size !== null && size > 0) next.contextSize = size;
    if (used !== null && size !== null && size > 0) {
      next.contextPercent = clampPercent(Math.round((used / size) * 100));
    }
    const cost = update.cost;
    if (isRecord(cost)) {
      const amount = finiteNumber(cost.amount);
      if (amount !== null) next.cost = { amount, currency: typeof cost.currency === "string" ? cost.currency : "" };
    }
  } else if (update.sessionUpdate === "session_info_update") {
    const kiro = kiroMeta(update);
    const kind = kiro && typeof kiro.kind === "string" ? kiro.kind : null;
    if (kind === "context_usage") {
      const sources = [kiro, update];
      const percent = pick(sources, ["usagePercentage", "usagePercent", "percentage", "percent"]);
      const used = pick(sources, ["usedTokens", "tokensUsed", "used", "contextTokens", "tokens"]);
      const size = pick(sources, ["contextWindow", "contextWindowSize", "maxTokens", "size", "limit"]);
      next = { ...next };
      if (used !== null) next.contextUsed = used;
      if (size !== null && size > 0) next.contextSize = size;
      if (percent !== null) next.contextPercent = clampPercent(Math.round(percent));
      else if (used !== null && size !== null && size > 0) {
        next.contextPercent = clampPercent(Math.round((used / size) * 100));
      }
    } else if (kind === "turn_completion") {
      const summaries = kiro?.promptTurnSummaries ?? update.promptTurnSummaries;
      const entries = Array.isArray(summaries) ? summaries : isRecord(summaries) ? [summaries] : [];
      let turnTokens = 0;
      for (const entry of entries) turnTokens += tokenTotal(entry);
      if (turnTokens > 0) next = { ...next, tokensSpent: (next.tokensSpent ?? 0) + turnTokens };
    }
  }

  return same(next, usage) ? null : next;
}

const PERCENT_KEYS = ["usagePercentage", "usagePercent", "contextUsagePercent", "percentage", "percent"];
const USED_KEYS = ["usedTokens", "tokensUsed", "contextTokens", "contextUsed", "used", "totalTokens", "tokens"];
const SIZE_KEYS = ["contextWindow", "contextWindowSize", "contextWindowTokens", "maxTokens", "contextSize", "size", "limit"];

/** Breadth-first: the first finite number stored under `key`, four levels deep. */
function deepFind(root: unknown, key: string): number | null {
  let level: unknown[] = [root];
  for (let depth = 0; depth <= 4 && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!isRecord(node)) continue;
      const n = finiteNumber(node[key]);
      if (n !== null) return n;
      for (const value of Object.values(node)) {
        if (isRecord(value)) next.push(value);
        else if (Array.isArray(value)) next.push(...value);
      }
    }
    level = next;
  }
  return null;
}

/** The first of `keys` (in priority order) found anywhere in `root`: a specific key beats a generic one. */
function deepPick(root: unknown, keys: string[]): number | null {
  for (const key of keys) {
    const n = deepFind(root, key);
    if (n !== null) return n;
  }
  return null;
}

/** Every string four levels deep, joined, for the textual fallback. */
function deepText(root: unknown, depth = 0): string {
  if (typeof root === "string") return root;
  if (depth > 4) return "";
  if (Array.isArray(root)) return root.map((v) => deepText(v, depth + 1)).join("\n");
  if (isRecord(root)) return Object.values(root).map((v) => deepText(v, depth + 1)).join("\n");
  return "";
}

/** "12k", "12,345", "1.2M" → a token count. */
function parseCount(text: string): number | null {
  const m = /^([\d.,]+)\s*([kKmM])?$/.exec(text.trim());
  if (!m) return null;
  const base = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  return Math.round(unit === "k" ? base * 1_000 : unit === "m" ? base * 1_000_000 : base);
}

/**
 * Context numbers found in a `_kiro/session/context` reply (or any similar
 * object): structured keys first, then the text ("42% used", "84k of 200k
 * tokens"). Null when it holds nothing usable.
 */
export function contextFromResult(result: unknown): Pick<SessionUsage, "contextPercent" | "contextUsed" | "contextSize"> | null {
  let percent = deepPick(result, PERCENT_KEYS);
  let used = deepPick(result, USED_KEYS);
  let size = deepPick(result, SIZE_KEYS);
  if (percent === null && (used === null || size === null)) {
    const text = deepText(result);
    const pm = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(text);
    if (pm) percent = Number(pm[1]);
    const tm = /([\d.,]+\s*[kKmM]?)\s*(?:of|\/)\s*([\d.,]+\s*[kKmM]?)\s*tokens/.exec(text);
    if (tm) {
      used = used ?? parseCount(tm[1]!);
      size = size ?? parseCount(tm[2]!);
    }
  }
  if (size !== null && size <= 0) size = null;
  if (percent === null && used !== null && size !== null) percent = (used / size) * 100;
  if (percent === null && used === null && size === null) return null;
  return {
    contextPercent: percent === null ? null : clampPercent(Math.round(percent)),
    contextUsed: used,
    contextSize: size,
  };
}

/** Fold a `_kiro/session/context` reply into `usage`; null when nothing changed. */
export function applyContextResult(usage: SessionUsage, result: unknown): SessionUsage | null {
  const found = contextFromResult(result);
  if (!found) return null;
  const next: SessionUsage = { ...usage };
  if (found.contextPercent !== null) next.contextPercent = found.contextPercent;
  if (found.contextUsed !== null) next.contextUsed = found.contextUsed;
  if (found.contextSize !== null) next.contextSize = found.contextSize;
  return same(next, usage) ? null : next;
}
