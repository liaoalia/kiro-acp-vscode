/**
 * Sliding-window rate limit per key (agent link, D30: messages per sender).
 * Pure; vscode-free. CONTRACT STUB — implemented in plan Task 10.
 */
export class RateLimiter {
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record one event for `key`; false (and nothing recorded) when `key` already had `limit` events in the window. */
  take(key: string): boolean {
    void key;
    void this.now;
    return true;
  }

  /** Milliseconds until `key` may `take` again (0 when it may now). */
  retryAfterMs(key: string): number {
    void key;
    return 0;
  }

  /** Drop the history of `key` (its session closed). */
  forget(key: string): void {
    void key;
  }
}
