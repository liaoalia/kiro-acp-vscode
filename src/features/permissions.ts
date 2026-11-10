/**
 * Pending `session/request_permission` registry + session policy (D6, D23).
 *
 * The ACP layer calls {@link PermissionManager.request}; the webview, the
 * diff editor title buttons and the plan tab resolve entries through
 * {@link PermissionManager.resolve} / {@link PermissionManager.decideRequest}.
 */
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionScope, PermissionView, ToolDiffContent, ToolKind } from "../ui/protocol.js";
import {
  PermissionPolicy,
  decide,
  decisionOfOption,
  offeredPolicies,
  policyKey,
  selectOption,
  type PolicyDecision,
  type PolicySubject,
} from "./pure/permissionPolicy.js";

export interface PermissionManagerOptions {
  /**
   * Kind of an already-known tool call (from the session transcripts), used
   * when `session/request_permission.toolCall` carries no `kind` — the real
   * Kiro CLI omits it (D23).
   */
  resolveKind?: (toolCallId: string) => ToolKind | undefined;
}

/** Everything the manager knows about a pending request. */
export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolKind: ToolKind;
  title: string;
  options: acp.PermissionOption[];
  hasDiff: boolean;
  consent?: { capability?: string; resource?: string; persistableConsent?: boolean };
  /** Diff contents carried by `toolCall.content` (for the diff feature). */
  diffs: ToolDiffContent[];
  createdAt: number;
}

/** Emitted whenever a pending request stops being pending. */
export interface PermissionResolution {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolKind: ToolKind;
  outcome: PolicyDecision | "cancelled";
  optionId?: string;
}

interface Entry extends PendingPermission {
  resolve: (response: acp.RequestPermissionResponse) => void;
  cleanup: () => void;
}

const TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

export const PLAN_APPROVAL_CONTEXT_KEY = "kiroAcp.planApprovalPending";

function asToolKind(kind: unknown): ToolKind | undefined {
  return typeof kind === "string" && TOOL_KINDS.has(kind) ? (kind as ToolKind) : undefined;
}

function subjectOf(entry: Pick<PendingPermission, "toolKind" | "consent">): PolicySubject {
  return {
    toolKind: entry.toolKind,
    ...(entry.consent?.capability ? { capability: entry.consent.capability } : {}),
    ...(entry.consent?.resource ? { resource: entry.consent.resource } : {}),
  };
}

function readConsent(meta: unknown): PendingPermission["consent"] {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const kiro = (meta as Record<string, unknown>)["kiro"];
  if (!kiro || typeof kiro !== "object") {
    return undefined;
  }
  const consent = (kiro as Record<string, unknown>)["consent"];
  if (!consent || typeof consent !== "object") {
    return undefined;
  }
  const c = consent as Record<string, unknown>;
  const out: NonNullable<PendingPermission["consent"]> = {};
  if (typeof c["capability"] === "string") {
    out.capability = c["capability"];
  }
  if (typeof c["resource"] === "string") {
    out.resource = c["resource"];
  }
  if (typeof c["persistableConsent"] === "boolean") {
    out.persistableConsent = c["persistableConsent"];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractDiffs(content: acp.ToolCallUpdate["content"]): ToolDiffContent[] {
  const diffs: ToolDiffContent[] = [];
  for (const item of content ?? []) {
    if (item && item.type === "diff" && typeof item.path === "string") {
      diffs.push({
        type: "diff",
        path: item.path,
        oldText: item.oldText ?? null,
        newText: item.newText ?? "",
      });
    }
  }
  return diffs;
}

export class PermissionManager implements vscode.Disposable {
  private readonly policy = new PermissionPolicy();
  private readonly entries = new Map<string, Entry>();
  private counter = 0;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly resolveEmitter = new vscode.EventEmitter<PermissionResolution>();
  private disposed = false;

  /** Fires after any change to the pending set. */
  readonly onDidChange: vscode.Event<void> = this.changeEmitter.event;
  /** Fires when a request is answered (selected or cancelled). */
  readonly onDidResolve: vscode.Event<PermissionResolution> = this.resolveEmitter.event;

  constructor(private readonly options: PermissionManagerOptions = {}) {
    void this.updateContextKeys();
  }

  // ---------------------------------------------------------------------
  // ClientServices entry
  // ---------------------------------------------------------------------

  /**
   * Answer a permission request: immediately from the session policy, or by
   * registering a pending entry the UI resolves later. Aborting `signal`
   * (the agent cancelled the turn) answers `cancelled`.
   */
  request(
    req: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const toolCallId = req.toolCall?.toolCallId ?? "";
    // The request's own kind, else the kind of the tool call it refers to
    // (Kiro V3 sends none on the request), else `other`.
    const toolKind: ToolKind =
      asToolKind(req.toolCall?.kind) ?? (toolCallId ? this.options.resolveKind?.(toolCallId) : undefined) ?? "other";
    const options = Array.isArray(req.options) ? req.options : [];
    const consent = readConsent(req._meta);
    const auto = decide(this.policy, req.sessionId, subjectOf({ toolKind, consent }), options);
    if (auto !== undefined) {
      return Promise.resolve({ outcome: { outcome: "selected", optionId: auto } });
    }
    if (signal.aborted) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    const requestId = `perm-${++this.counter}`;
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const onAbort = () => this.finish(requestId, { outcome: { outcome: "cancelled" } }, "cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      const entry: Entry = {
        requestId,
        sessionId: req.sessionId,
        toolCallId,
        toolKind,
        title: req.toolCall?.title ?? req.toolCall?.toolCallId ?? "Permission request",
        options,
        hasDiff: extractDiffs(req.toolCall?.content).length > 0,
        consent,
        diffs: extractDiffs(req.toolCall?.content),
        createdAt: Date.now(),
        resolve,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      this.entries.set(requestId, entry);
      this.changed();
    });
  }

  // ---------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------

  /**
   * Resolve a pending request with one of the option ids the agent supplied.
   * @throws when the request is unknown or the option id is not offered.
   */
  resolve(requestId: string, optionId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry) {
      throw new Error(`Unknown permission request: ${requestId}`);
    }
    if (!entry.options.some((o) => o.optionId === optionId)) {
      throw new Error(`Option "${optionId}" is not offered by request ${requestId}`);
    }
    const outcome = decisionOfOption(entry.options, optionId) ?? "allow";
    this.finish(requestId, { outcome: { outcome: "selected", optionId } }, outcome, optionId);
  }

  /**
   * Resolve a pending request by decision, picking the agent's `allow_once`
   * (else `allow_always`) / `reject_once` (else `reject_always`) option.
   * @returns the chosen option id, or `undefined` when the request is unknown
   *   or offers no matching option (the request stays pending).
   */
  decideRequest(requestId: string, decision: PolicyDecision): string | undefined {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return undefined;
    }
    const optionId = selectOption(entry.options, decision);
    if (optionId === undefined) {
      return undefined;
    }
    this.finish(requestId, { outcome: { outcome: "selected", optionId } }, decision, optionId);
    return optionId;
  }

  /**
   * Remember `decision` for the rest of the session — for the request's tool
   * kind (default), its consent capability or its exact consent resource —
   * and answer the request accordingly.
   * @throws when the request is unknown or has nothing to key `scope` on.
   */
  setPolicy(requestId: string, decision: PolicyDecision, scope: PermissionScope = "kind"): void {
    const entry = this.entries.get(requestId);
    if (!entry) {
      throw new Error(`Unknown permission request: ${requestId}`);
    }
    const key = policyKey(scope, subjectOf(entry));
    if (key === undefined) {
      throw new Error(`Permission request ${requestId} has no ${scope} to remember`);
    }
    this.policy.set(entry.sessionId, key, decision);
    this.decideRequest(requestId, decision);
  }

  /** Forget remembered policies for one session, or all. */
  clearPolicies(sessionId?: string): void {
    this.policy.clear(sessionId);
  }

  /** Answer every pending request of `sessionId` (or all) with `cancelled`. */
  cancelAll(sessionId?: string): void {
    for (const entry of [...this.entries.values()]) {
      if (sessionId === undefined || entry.sessionId === sessionId) {
        this.finish(entry.requestId, { outcome: { outcome: "cancelled" } }, "cancelled");
      }
    }
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  /** Pending requests as webview view models, oldest first. */
  pending(): PermissionView[] {
    return [...this.entries.values()].map(toView);
  }

  get(requestId: string): PermissionView | undefined {
    const entry = this.entries.get(requestId);
    return entry ? toView(entry) : undefined;
  }

  /** Full pending record including session id and diff contents. */
  getEntry(requestId: string): PendingPermission | undefined {
    const entry = this.entries.get(requestId);
    return entry ? toRecord(entry) : undefined;
  }

  pendingForToolCall(toolCallId: string): PermissionView | undefined {
    for (const entry of this.entries.values()) {
      if (entry.toolCallId === toolCallId) {
        return toView(entry);
      }
    }
    return undefined;
  }

  /** First pending request whose tool kind is `kind` (e.g. `switch_mode`). */
  findByKind(kind: ToolKind): PermissionView | undefined {
    for (const entry of this.entries.values()) {
      if (entry.toolKind === kind) {
        return toView(entry);
      }
    }
    return undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelAll();
    this.changeEmitter.dispose();
    this.resolveEmitter.dispose();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private finish(
    requestId: string,
    response: acp.RequestPermissionResponse,
    outcome: PolicyDecision | "cancelled",
    optionId?: string,
  ): void {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return;
    }
    this.entries.delete(requestId);
    entry.cleanup();
    entry.resolve(response);
    if (!this.disposed) {
      this.resolveEmitter.fire({
        requestId,
        sessionId: entry.sessionId,
        toolCallId: entry.toolCallId,
        toolKind: entry.toolKind,
        outcome,
        ...(optionId !== undefined ? { optionId } : {}),
      });
    }
    this.changed();
  }

  private changed(): void {
    if (this.disposed) {
      return;
    }
    this.changeEmitter.fire();
    void this.updateContextKeys();
  }

  private async updateContextKeys(): Promise<void> {
    const planPending = this.findByKind("switch_mode") !== undefined;
    try {
      await vscode.commands.executeCommand("setContext", PLAN_APPROVAL_CONTEXT_KEY, planPending);
    } catch {
      // Context keys are best-effort.
    }
  }
}

function toView(entry: Entry): PermissionView {
  return {
    requestId: entry.requestId,
    toolCallId: entry.toolCallId,
    title: entry.title,
    kind: entry.toolKind,
    options: entry.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    hasDiff: entry.hasDiff,
    ...(entry.consent ? { consent: { ...entry.consent } } : {}),
    policies: offeredPolicies(subjectOf(entry)),
  };
}

function toRecord(entry: Entry): PendingPermission {
  return {
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    toolCallId: entry.toolCallId,
    toolKind: entry.toolKind,
    title: entry.title,
    options: [...entry.options],
    hasDiff: entry.hasDiff,
    ...(entry.consent ? { consent: { ...entry.consent } } : {}),
    diffs: entry.diffs.map((d) => ({ ...d })),
    createdAt: entry.createdAt,
  };
}
