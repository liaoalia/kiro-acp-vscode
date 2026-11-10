/**
 * Live plan document (`kiro-plan:`) and plan approval commands (D11).
 */
import * as vscode from "vscode";
import type { PlanEntryView } from "../ui/protocol.js";
import type { PermissionManager } from "./permissions.js";
import { renderPlanMarkdown } from "./pure/planMarkdown.js";

export const PLAN_SCHEME = "kiro-plan";
export const APPROVE_PLAN_COMMAND = "kiroAcp.approvePlan";
export const REJECT_PLAN_COMMAND = "kiroAcp.rejectPlan";

export interface PlanDocumentOptions {
  /** Open the plan editor the first time a non-empty plan arrives for a session. Default true. */
  autoOpen?: boolean;
}

export class PlanDocument implements vscode.Disposable, vscode.TextDocumentContentProvider {
  /** The single plan document URI. */
  static readonly uri: vscode.Uri = vscode.Uri.from({ scheme: PLAN_SCHEME, path: "/Kiro Plan.md" });

  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private entries: PlanEntryView[] = [];
  private sessionId: string | undefined;
  private updatedAt: Date | undefined;
  private approvalPending = false;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly autoOpenedSessions = new Set<string>();
  private readonly autoOpen: boolean;

  /** TextDocumentContentProvider change event (debounced 50 ms). */
  readonly onDidChange: vscode.Event<vscode.Uri> = this.changeEmitter.event;

  constructor(
    private readonly permissions: PermissionManager,
    options: PlanDocumentOptions = {},
  ) {
    this.autoOpen = options.autoOpen ?? true;
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PLAN_SCHEME, this),
      vscode.commands.registerCommand(APPROVE_PLAN_COMMAND, () => this.answer("allow")),
      vscode.commands.registerCommand(REJECT_PLAN_COMMAND, () => this.answer("reject")),
      permissions.onDidChange(() =>
        this.setApprovalPending(permissions.findByKind("switch_mode") !== undefined),
      ),
    );
  }

  provideTextDocumentContent(): string {
    return renderPlanMarkdown(this.entries, {
      sessionId: this.sessionId,
      updatedAt: this.updatedAt,
      approvalPending: this.approvalPending,
    });
  }

  /** Current rendered Markdown. */
  get text(): string {
    return this.provideTextDocumentContent();
  }

  /**
   * Replace the plan entries (from a `plan` session update). Opens the
   * document automatically the first time a non-empty plan arrives for the
   * session when `autoOpen` is enabled.
   */
  update(entries: PlanEntryView[], sessionId?: string): void {
    this.entries = entries.map((e) => ({ ...e }));
    if (sessionId !== undefined) {
      this.sessionId = sessionId;
    }
    this.updatedAt = new Date();
    this.scheduleChange();
    const sessionKey = this.sessionId ?? "";
    if (
      this.autoOpen &&
      entries.length > 0 &&
      !this.autoOpenedSessions.has(sessionKey) &&
      !this.isOpen()
    ) {
      this.autoOpenedSessions.add(sessionKey);
      void this.open();
    }
  }

  /** Clear the plan (new session). */
  reset(sessionId?: string): void {
    this.entries = [];
    this.sessionId = sessionId;
    this.updatedAt = undefined;
    this.scheduleChange();
  }

  /** Toggle the approval note; also driven automatically from the permission manager. */
  setApprovalPending(pending: boolean): void {
    if (this.approvalPending === pending) {
      return;
    }
    this.approvalPending = pending;
    this.scheduleChange();
  }

  /** Show the plan beside the current editor without stealing focus. */
  async open(): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(PlanDocument.uri);
    if (doc.languageId !== "markdown") {
      try {
        await vscode.languages.setTextDocumentLanguage(doc, "markdown");
      } catch {
        // language id is cosmetic
      }
    }
    return vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });
  }

  /** `true` when a tab shows the plan document. */
  isOpen(): boolean {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === PLAN_SCHEME) {
          return true;
        }
      }
    }
    return false;
  }

  dispose(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changeEmitter.dispose();
  }

  private scheduleChange(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.changeEmitter.fire(PlanDocument.uri);
    }, 50);
  }

  private answer(decision: "allow" | "reject"): void {
    const pending = this.permissions.findByKind("switch_mode");
    if (!pending) {
      void vscode.window.showInformationMessage(
        "Nothing is awaiting approval: Kiro has not asked to switch out of planning yet.",
      );
      return;
    }
    const chosen = this.permissions.decideRequest(pending.requestId, decision);
    if (chosen === undefined) {
      void vscode.window.showWarningMessage(
        `The agent offered no "${decision}" option for this request; answer it in the chat view.`,
      );
    }
  }
}
