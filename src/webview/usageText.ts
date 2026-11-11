/** Text for the header's usage pill (no DOM, unit-tested). */
import type { SessionUsage } from "../ui/protocol.js";

/** 812 -> "812", 8400 -> "8.4k", 12345 -> "12k", 1234567 -> "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}M`;
}

function withSeparators(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Short label ("42% ctx · 12k tokens") and a tooltip with the full numbers,
 * or `null` when nothing about the session's usage is known yet.
 */
export function usageText(usage: SessionUsage | null | undefined): { label: string; title: string } | null {
  if (!usage) return null;
  const label: string[] = [];
  const title: string[] = [];
  if (usage.contextPercent !== null) {
    label.push(`${usage.contextPercent}% ctx`);
    const detail =
      usage.contextUsed !== null && usage.contextSize !== null
        ? ` (${withSeparators(usage.contextUsed)} of ${withSeparators(usage.contextSize)} tokens)`
        : "";
    title.push(`Context window: ${usage.contextPercent}% used${detail}`);
  } else if (usage.contextUsed !== null) {
    label.push(`${formatTokens(usage.contextUsed)} ctx`);
    title.push(`Context window: ${withSeparators(usage.contextUsed)} tokens in use`);
  }
  if (usage.tokensSpent !== null) {
    label.push(`${formatTokens(usage.tokensSpent)} tokens`);
    title.push(`Tokens spent this session: ${withSeparators(usage.tokensSpent)}`);
  }
  if (usage.cost !== null) {
    const amount = Number.isInteger(usage.cost.amount) ? String(usage.cost.amount) : usage.cost.amount.toFixed(2);
    const unit = usage.cost.currency ? ` ${usage.cost.currency}` : "";
    title.push(`Cost: ${amount}${unit}`);
    if (label.length === 0) label.push(`${amount}${unit}`);
  }
  if (label.length === 0) return null;
  return { label: label.join(" · "), title: title.join("\n") };
}
