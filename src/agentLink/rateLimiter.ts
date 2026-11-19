/**
 * Sliding-window rate limit per key (agent link, D30: messages per sender).
 * Pure; vscode-free. The clock is injected for tests.
 */
export class RateLimiter {
  /** Times of the events still in the window, oldest first, per key; never more than `limit` each. */
  private readonly events = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record one event for `key`; false (and nothing recorded) when `key` already had `limit` events in the window. */
  take(key: string): boolean {
    const now = this.now();
    const events = this.recent(key, now);
    if (events.length >= this.limit) return false;
    events.push(now);
    this.events.set(key, events);
    return true;
  }

  /** Milliseconds until `key` may `take` again (0 when it may now). */
  retryAfterMs(key: string): number {
    const now = this.now();
    const events = this.recent(key, now);
    if (events.length < this.limit) return 0;
    // The event whose expiry brings the count below the limit.
    const blocking = events[events.length - this.limit];
    if (blocking === undefined) return this.windowMs;
    return Math.min(this.windowMs, Math.max(0, blocking + this.windowMs - now));
  }

  /** Drop the history of `key` (its session closed). */
  forget(key: string): void {
    this.events.delete(key);
  }

  /** The events of `key` inside the window ending at `now`; expired ones are dropped (and an empty key forgotten). */
  private recent(key: string, now: number): number[] {
    const events = this.events.get(key);
    if (!events) return [];
    const cutoff = now - this.windowMs;
    let expired = 0;
    while (expired < events.length && events[expired]! <= cutoff) expired += 1;
    if (expired > 0) events.splice(0, expired);
    if (events.length === 0) this.events.delete(key);
    return events;
  }
}
