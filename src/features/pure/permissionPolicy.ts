/**
 * Client-side permission policy (DECISIONS.md D6).
 *
 * "Always allow / always reject for this session" is remembered per
 * `(sessionId, toolKind)` and auto-selects one of the options the agent
 * supplied for later requests. The policy never invents option ids: when the
 * agent offers no matching option the request falls through to the user.
 *
 * vscode-free; unit-tested in `test/features-permissionPolicy.test.ts`.
 */
import type * as acp from "@agentclientprotocol/sdk";

export type PolicyDecision = "allow" | "reject";

/** Minimal shape of a permission option used for selection. */
export interface OptionLike {
  optionId: string;
  kind: acp.PermissionOptionKind;
}

function policyKey(sessionId: string, toolKind: string): string {
  return `${sessionId}\u0000${toolKind}`;
}

/**
 * Pick the option id that implements `decision`:
 * allow → `allow_once` (else `allow_always`); reject → `reject_once` (else
 * `reject_always`). Returns `undefined` when the agent offered no such option.
 */
export function selectOption(
  options: readonly OptionLike[],
  decision: PolicyDecision,
): string | undefined {
  const preferred: acp.PermissionOptionKind[] =
    decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferred) {
    const match = options.find((o) => o.kind === kind);
    if (match) {
      return match.optionId;
    }
  }
  return undefined;
}

/** Remembered decisions keyed by `(sessionId, toolKind)`. */
export class PermissionPolicy {
  private readonly rules = new Map<string, PolicyDecision>();

  /** Record `decision` for every later request of `toolKind` in `sessionId`. */
  set(sessionId: string, toolKind: string, decision: PolicyDecision): void {
    this.rules.set(policyKey(sessionId, toolKind), decision);
  }

  /** The remembered decision, if any. */
  get(sessionId: string, toolKind: string): PolicyDecision | undefined {
    return this.rules.get(policyKey(sessionId, toolKind));
  }

  /** Forget the rules of one session, or of every session when omitted. */
  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.rules.clear();
      return;
    }
    const prefix = `${sessionId}\u0000`;
    for (const key of [...this.rules.keys()]) {
      if (key.startsWith(prefix)) {
        this.rules.delete(key);
      }
    }
  }

  /** Number of remembered rules (for tests/diagnostics). */
  get size(): number {
    return this.rules.size;
  }
}

/**
 * Consult `policy` for a request: returns the option id to auto-select, or
 * `undefined` when the user must be asked (no rule, or no matching option).
 */
export function decide(
  policy: PermissionPolicy,
  sessionId: string,
  toolKind: string,
  options: readonly OptionLike[],
): string | undefined {
  const decision = policy.get(sessionId, toolKind);
  if (!decision) {
    return undefined;
  }
  return selectOption(options, decision);
}

/** Map a chosen option id back to allow/reject (undefined for unknown ids). */
export function decisionOfOption(
  options: readonly OptionLike[],
  optionId: string,
): PolicyDecision | undefined {
  const option = options.find((o) => o.optionId === optionId);
  if (!option) {
    return undefined;
  }
  return option.kind === "allow_once" || option.kind === "allow_always" ? "allow" : "reject";
}
