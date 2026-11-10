/**
 * Client-side permission policy (DECISIONS.md D6, D23).
 *
 * "Always allow / always reject for this session" is remembered per session
 * under one of three scopes — the tool kind (`kind:<kind>`), the Kiro consent
 * capability (`cap:<capability>`) or the exact consent resource qualified by
 * its capability (`res:<capability>\u0000<resource>`, so a rule for writing a
 * file never answers a request to run or read it) — and auto-selects one of
 * the options the agent supplied for later requests. The most specific rule
 * wins (resource, then capability, then kind). The policy never invents
 * option ids: when the agent offers no matching option the request falls
 * through to the user.
 *
 * vscode-free; unit-tested in `test/features-permissionPolicy.test.ts`.
 */
import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionScope, PermissionView, ToolKind } from "../../ui/protocol.js";
import { isAbsolutePath, normalizeFsPath } from "./textRange.js";

export type PolicyDecision = "allow" | "reject";

/** Minimal shape of a permission option used for selection. */
export interface OptionLike {
  optionId: string;
  kind: acp.PermissionOptionKind;
}

/** What a permission request is about: the inputs of every policy scope. */
export interface PolicySubject {
  toolKind: string;
  /** `_meta.kiro.consent.capability` (e.g. `fs_write`, `shell`). */
  capability?: string;
  /** `_meta.kiro.consent.resource` verbatim (a file path, a shell command, …). */
  resource?: string;
}

export type OfferedPolicy = NonNullable<PermissionView["policies"]>[number];

/** Scopes from the most to the least specific; `decide` consults them in this order. */
export const SCOPE_PRECEDENCE: readonly PermissionScope[] = ["resource", "capability", "kind"];

/** Plural nouns for the tool-kind labels ("Allow all edits this session"). */
const KIND_NOUNS: Record<ToolKind, string> = {
  edit: "edits",
  read: "reads",
  execute: "commands",
  delete: "deletions",
  move: "moves",
  search: "searches",
  fetch: "fetches",
  switch_mode: "mode switches",
  think: "thoughts",
  other: "actions of this kind",
};

function kindNoun(toolKind: string): string {
  return (KIND_NOUNS as Record<string, string>)[toolKind] ?? KIND_NOUNS.other;
}

/** True when a consent resource names a file: an absolute path without line breaks. */
export function looksLikePath(resource: string, platform?: NodeJS.Platform): boolean {
  if (/[\r\n]/.test(resource)) return false;
  return isAbsolutePath(resource, platform);
}

/** Consent capabilities whose resource is a file-system path. */
const FS_CAPABILITIES: ReadonlySet<string> = new Set(["fs_read", "fs_write"]);
/** Tool kinds whose resource is a file-system path (when the capability does not say). */
const FS_TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind>(["read", "edit", "delete", "move"]);

/**
 * True when the consent resource of `subject` names a file-system entry: the
 * capability is `fs_read`/`fs_write`, or (without a capability) the tool kind
 * is a file operation. Only such resources are path-normalised; a shell
 * command stays verbatim however path-like it looks (D23).
 */
export function isFsResource(subject: Pick<PolicySubject, "toolKind" | "capability">): boolean {
  const capability = subject.capability?.trim();
  if (capability) return FS_CAPABILITIES.has(capability);
  return FS_TOOL_KINDS.has(subject.toolKind);
}

/**
 * Canonical form of a resource for the `res:` scope: an absolute path of a
 * file-system subject is normalised with `normalizeFsPath`; everything else
 * (a shell command, a relative path, any non-fs resource) is kept verbatim.
 */
export function normalizeResource(resource: string, fsResource: boolean, platform?: NodeJS.Platform): string {
  return fsResource && looksLikePath(resource, platform) ? normalizeFsPath(resource, platform) : resource;
}

/**
 * The rule key of `scope` for `subject` (`kind:edit`, `cap:fs_write`,
 * `res:fs_write\u0000/abs/path`), or `undefined` when the subject lacks that
 * field. The resource key carries the capability (empty when absent) so a
 * rule remembered for one capability never matches another on the same path.
 */
export function policyKey(scope: PermissionScope, subject: PolicySubject, platform?: NodeJS.Platform): string | undefined {
  switch (scope) {
    case "kind":
      return `kind:${subject.toolKind}`;
    case "capability":
      return subject.capability ? `cap:${subject.capability}` : undefined;
    case "resource": {
      if (!subject.resource) return undefined;
      const resource = normalizeResource(subject.resource, isFsResource(subject), platform);
      return `res:${subject.capability ?? ""}\u0000${resource}`;
    }
    default:
      return undefined;
  }
}

function ruleKey(sessionId: string, key: string): string {
  return `${sessionId}\u0000${key}`;
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

/** Remembered decisions keyed by `(sessionId, scope key)`; see {@link policyKey}. */
export class PermissionPolicy {
  private readonly rules = new Map<string, PolicyDecision>();

  /** Record `decision` for every later request of `sessionId` matching `key`. */
  set(sessionId: string, key: string, decision: PolicyDecision): void {
    this.rules.set(ruleKey(sessionId, key), decision);
  }

  /** The remembered decision for one key, if any. */
  get(sessionId: string, key: string): PolicyDecision | undefined {
    return this.rules.get(ruleKey(sessionId, key));
  }

  /**
   * The remembered decision for `subject`, consulting the resource, then the
   * capability, then the kind rule.
   */
  lookup(sessionId: string, subject: PolicySubject, platform?: NodeJS.Platform): PolicyDecision | undefined {
    for (const scope of SCOPE_PRECEDENCE) {
      const key = policyKey(scope, subject, platform);
      if (key === undefined) continue;
      const decision = this.get(sessionId, key);
      if (decision) return decision;
    }
    return undefined;
  }

  /** Forget the rules (of every scope) of one session, or of every session when omitted. */
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
 * A bare string subject is a tool kind.
 */
export function decide(
  policy: PermissionPolicy,
  sessionId: string,
  subject: PolicySubject | string,
  options: readonly OptionLike[],
  platform?: NodeJS.Platform,
): string | undefined {
  const resolved: PolicySubject = typeof subject === "string" ? { toolKind: subject } : subject;
  const decision = policy.lookup(sessionId, resolved, platform);
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

/**
 * The session-wide policies worth offering for a request, with labels, most
 * general first: always the tool kind; the consent capability when it says
 * something the kind does not; the consent resource when present, worded by
 * the capability (else the kind): "Allow all changes to <basename>" for
 * `fs_write`/`edit`, "Allow reading <basename>" for `fs_read`/`read`,
 * `Allow "<command>" every time` for `shell`/`execute`, and
 * "Allow <capability> on <basename|resource>" for anything else.
 */
export function offeredPolicies(subject: PolicySubject, platform?: NodeJS.Platform): OfferedPolicy[] {
  const out: OfferedPolicy[] = [];
  const noun = kindNoun(subject.toolKind);
  out.push({
    scope: "kind",
    label: `Allow all ${noun} this session`,
    rejectLabel: `Reject all ${noun} this session`,
  });
  const capability = subject.capability?.trim();
  if (capability && capability !== subject.toolKind) {
    out.push({
      scope: "capability",
      label: `Allow all ${capability} this session`,
      rejectLabel: `Reject all ${capability} this session`,
    });
  }
  const resource = subject.resource;
  if (resource && resource.trim().length > 0) {
    const [label, rejectLabel] = resourceLabels(subject, resource, platform);
    out.push({ scope: "resource", label: `${label} this session`, rejectLabel: `${rejectLabel} this session` });
  }
  return out;
}

/** Allow / reject labels (without the "this session" suffix) of the resource policy, worded by capability. */
function resourceLabels(subject: PolicySubject, resource: string, platform?: NodeJS.Platform): [string, string] {
  const what = subject.capability?.trim() || subject.toolKind;
  const name = isFsResource(subject) && looksLikePath(resource, platform) ? basenameOf(resource, platform) : resource;
  switch (what) {
    case "fs_write":
    case "edit":
      return [`Allow all changes to ${name}`, `Reject all changes to ${name}`];
    case "fs_read":
    case "read":
      return [`Allow reading ${name}`, `Reject reading ${name}`];
    case "shell":
    case "execute": {
      const quoted = JSON.stringify(resource);
      return [`Allow ${quoted} every time`, `Reject ${quoted} every time`];
    }
    default:
      return [`Allow ${what} on ${name}`, `Reject ${what} on ${name}`];
  }
}

function basenameOf(p: string, platform?: NodeJS.Platform): string {
  const plat = platform ?? process.platform;
  const base = plat === "win32" ? path.win32.basename(p) : path.posix.basename(p);
  return base.length > 0 ? base : p;
}
