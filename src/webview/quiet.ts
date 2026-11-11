/**
 * "No reply for N min" for the working strip: how long the displayed session
 * has been silent while its turn runs. Pure (no DOM).
 */
export const QUIET_AFTER_MS = 60_000;

/** Label once the session has been quiet for a minute, else null. */
export function quietLabel(lastActivityAt: number | null | undefined, now: number): string | null {
  if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt)) return null;
  const quiet = now - lastActivityAt;
  if (quiet < QUIET_AFTER_MS) return null;
  const minutes = Math.floor(quiet / 60_000);
  if (minutes < 60) return `no reply for ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `no reply for ${hours} h` : `no reply for ${hours} h ${rest} min`;
}

/** Tooltip for the strip: when the last event arrived and how to stop. */
export function quietTitle(lastActivityAt: number | null | undefined, now: number): string {
  const label = quietLabel(lastActivityAt, now);
  if (!label || typeof lastActivityAt !== "number") return "Esc stops the turn";
  const at = new Date(lastActivityAt);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `Last event from Kiro at ${hh}:${mm}. Esc stops the turn (a running command is killed with it).`;
}
