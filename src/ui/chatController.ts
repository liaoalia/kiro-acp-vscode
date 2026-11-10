/**
 * Orchestrates one chat view: agent lifecycle, the active session, the
 * transcript model, permissions, diffs, plan and context chips.
 *
 * The webview only ever sees `ToWebview` messages produced here; the agent
 * process only ever sees ACP requests issued through the `KiroAgent` facade.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";

import {
  createKiroAgent,
  resolveCliPath,
  type AgentInfo,
  type ClientServices,
  type ConnectionStateChange,
  type KiroAgent,
  type ProtocolLogger,
  type SessionEvent,
  type SessionState,
} from "../acp/index.js";
import {
  applyUpdate,
  createTranscript,
  snapshotToUiState,
  toModelView,
  withSessionSnapshot,
  type TranscriptState,
} from "../features/pure/transcript.js";
import { buildPromptBlocks } from "../features/pure/contentBlocks.js";
import { ContextTracker, searchFiles } from "../features/context.js";
import { DiffManager } from "../features/diff.js";
import { PermissionManager } from "../features/permissions.js";
import { PlanDocument } from "../features/plan.js";
import { TerminalService } from "../features/terminal.js";
import type {
  AuthMethodView,
  ConnectionView,
  ContextChip,
  FromWebview,
  ModelView,
  NoticeView,
  ToWebview,
  ToolCallView,
  ToolDiffContent,
  UiState,
} from "./protocol.js";

export interface ChatControllerDeps {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  services: ClientServices;
  permissions: PermissionManager;
  diff: DiffManager;
  plan: PlanDocument;
  terminal: TerminalService;
  contextTracker: ContextTracker;
}

const TURN_ACTIVE_KEY = "kiroAcp.turnActive";

export class ChatController implements vscode.Disposable {
  private agent: KiroAgent | null = null;
  private agentInfo: AgentInfo | null = null;
  private connection: ConnectionView = { status: "stopped" };
  private session: SessionState | null = null;
  private transcript: TranscriptState = createTranscript();
  private models: ModelView | null = null;
  private turnActive = false;
  private notices: NoticeView[] = [];
  private noticeSeq = 0;
  private userMessageSeq = 0;
  private readonly knownPermissionIds = new Set<string>();
  private readonly openedDiffs = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private poster: ((message: ToWebview) => void) | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly deps: ChatControllerDeps) {
    this.disposables.push(
      deps.permissions.onDidChange(() => this.syncPermissions()),
      deps.contextTracker.onDidChange((chips) => this.post({ type: "chips", chips })),
    );
  }

  // ---------------------------------------------------------------------
  // Webview binding
  // ---------------------------------------------------------------------

  /** Called by the view provider whenever a webview is (re)created. */
  attach(poster: (message: ToWebview) => void): void {
    this.poster = poster;
  }

  detach(): void {
    this.poster = null;
  }

  snapshot(): UiState {
    const state = snapshotToUiState(this.transcript, {
      connection: this.connection,
      sessionId: this.session?.sessionId ?? null,
      turnActive: this.turnActive,
      permissions: this.deps.permissions.pending(),
      models: this.models,
      chips: this.deps.contextTracker.chips(),
      notices: this.notices,
    });
    const toolCalls: Record<string, ToolCallView> = {};
    for (const [id, call] of Object.entries(state.toolCalls)) {
      toolCalls[id] = this.withTerminalOutput(call);
    }
    return { ...state, toolCalls };
  }

  private post(message: ToWebview): void {
    if (message.type === "toolCall") {
      message = { type: "toolCall", call: this.withTerminalOutput(message.call) };
    }
    this.poster?.(message);
  }

  /**
   * The transcript reducer only knows a terminal's id; fill in the retained
   * output and exit code from the terminal service so the card can show them.
   */
  private withTerminalOutput(call: ToolCallView): ToolCallView {
    if (!call.content.some((c) => c.type === "terminal")) return call;
    return {
      ...call,
      content: call.content.map((c) => {
        if (c.type !== "terminal") return c;
        const snap = this.deps.terminal.snapshot(c.terminalId);
        if (!snap) return c;
        return snap.exitCode === undefined
          ? { ...c, output: snap.output }
          : { ...c, output: snap.output, exitCode: snap.exitCode };
      }),
    };
  }

  // ---------------------------------------------------------------------
  // Agent lifecycle
  // ---------------------------------------------------------------------

  private logger(): ProtocolLogger {
    const out = this.deps.output;
    const traceEnabled = () =>
      vscode.workspace.getConfiguration("kiroAcp").get<boolean>("logProtocol", false);
    return {
      info: (m) => out.appendLine(`[info] ${m}`),
      warn: (m) => out.appendLine(`[warn] ${m}`),
      error: (m) => out.appendLine(`[error] ${m}`),
      trace: (direction, payload) => {
        if (direction === "stderr" || traceEnabled()) {
          out.appendLine(`[${direction}] ${payload}`);
        }
      },
    };
  }

  private workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder && folder.uri.scheme === "file") return folder.uri.fsPath;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === "file") return path.dirname(active.fsPath);
    return process.cwd();
  }

  /** Start the agent process (idempotent) and open a session when none exists. */
  async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.agent && this.agent.status !== "stopped" && this.agent.status !== "error") return;
    this.starting = this.startAgent().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startAgent(): Promise<void> {
    const config = vscode.workspace.getConfiguration("kiroAcp");
    const configured = config.get<string>("cliPath", "kiro-cli");
    const extraArgs = config.get<string[]>("cliArgs", []);
    const logger = this.logger();
    const command = await resolveCliPath(configured);
    const args = ["acp", ...extraArgs];
    logger.info(`spawning: ${command} ${args.join(" ")} (cwd ${this.workspaceRoot()})`);

    const version = (this.deps.context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
    const agent = createKiroAgent(
      { command, args, cwd: this.workspaceRoot(), env: process.env, logger, clientVersion: version },
      this.deps.services,
    );
    await this.teardownAgent();
    this.agent = agent;
    this.unsubscribers.push(
      agent.onConnectionChange((change) => this.onConnectionChange(change)),
      agent.onSessionEvent((event) => this.onSessionEvent(event)),
    );
    this.setConnection({ status: "starting", message: `Starting ${path.basename(command)}…` });
    try {
      this.agentInfo = await agent.start();
      this.setConnection(this.connectionFromAgent("ready"));
      await this.openSession();
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`agent start failed: ${message}`);
      this.setConnection({ status: "error", message });
      this.notice("error", `Could not start Kiro CLI: ${message}`);
    }
  }

  private async teardownAgent(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    const old = this.agent;
    this.agent = null;
    if (old) {
      try {
        await old.stop();
      } catch {
        /* ignore */
      }
    }
  }

  async restart(): Promise<void> {
    this.endSession();
    await this.teardownAgent();
    this.setConnection({ status: "stopped" });
    await this.ensureStarted();
  }

  private connectionFromAgent(status: ConnectionView["status"], message?: string): ConnectionView {
    const info = this.agentInfo;
    const view: ConnectionView = { status };
    if (info?.agentInfo) {
      view.agentName = info.agentInfo.title ?? info.agentInfo.name;
      view.agentVersion = info.agentInfo.version;
    }
    if (message) view.message = message;
    if (info && info.authMethods.length > 0) {
      view.authMethods = info.authMethods.map(toAuthMethodView);
    }
    return view;
  }

  private onConnectionChange(change: ConnectionStateChange): void {
    if (change.agent) this.agentInfo = change.agent;
    if (change.status === "stopped" || change.status === "error") {
      this.endSession();
    }
    this.setConnection(this.connectionFromAgent(change.status, change.message));
    if (change.status === "error" && change.message) {
      this.notice("error", change.message);
    }
  }

  private setConnection(view: ConnectionView): void {
    this.connection = view;
    this.post({ type: "connection", connection: view });
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  private async openSession(): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    this.endSession();
    try {
      const session = await agent.newSession(this.workspaceRoot());
      this.session = session;
      this.transcript = withSessionSnapshot(createTranscript(), {
        modes: session.modes,
        configOptions: session.configOptions,
        availableCommands: session.availableCommands,
      });
      this.models = toModelView(session.models);
      this.deps.plan.reset(session.sessionId);
      this.post({ type: "session", sessionId: session.sessionId });
      this.post({ type: "state", state: this.snapshot() });
      this.deps.output.appendLine(`[info] session ${session.sessionId} opened`);
    } catch (error) {
      const message = errorMessage(error);
      if (this.agent?.status === "auth_required") {
        this.setConnection(this.connectionFromAgent("auth_required", "Sign in to Kiro to start a session."));
      } else {
        this.notice("error", `Could not create a session: ${message}`);
      }
    }
  }

  private endSession(): void {
    const sessionId = this.session?.sessionId;
    if (sessionId) {
      this.deps.permissions.cancelAll(sessionId);
      this.deps.permissions.clearPolicies(sessionId);
    }
    this.session = null;
    this.transcript = createTranscript();
    this.models = null;
    this.notices = [];
    this.openedDiffs.clear();
    this.setTurnActive(false);
    this.post({ type: "session", sessionId: null });
  }

  async newSession(): Promise<void> {
    if (!this.agent || this.agent.status !== "ready") {
      await this.ensureStarted();
      return;
    }
    if (this.turnActive && this.session) {
      await this.cancel();
    }
    await this.openSession();
  }

  async cancel(): Promise<void> {
    const sessionId = this.session?.sessionId;
    if (!sessionId || !this.agent) return;
    this.deps.permissions.cancelAll(sessionId);
    try {
      await this.agent.cancel(sessionId);
    } catch (error) {
      this.notice("warning", `Cancel failed: ${errorMessage(error)}`);
    }
  }

  private setTurnActive(active: boolean, stopReason?: string): void {
    this.turnActive = active;
    void vscode.commands.executeCommand("setContext", TURN_ACTIVE_KEY, active);
    this.post(stopReason ? { type: "turn", active, stopReason } : { type: "turn", active });
  }

  // ---------------------------------------------------------------------
  // Prompting
  // ---------------------------------------------------------------------

  async prompt(text: string, chips: ContextChip[]): Promise<void> {
    await this.ensureStarted();
    const agent = this.agent;
    const session = this.session;
    if (!agent || !session) {
      this.notice("warning", "No active session. Sign in or restart the agent, then try again.");
      return;
    }
    if (this.turnActive) {
      this.notice("info", "Wait for the current turn to finish or cancel it first.");
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && chips.length === 0) return;

    const embeddedContext = this.agentInfo?.agentCapabilities.promptCapabilities?.embeddedContext === true;
    const blocks = await buildPromptBlocks(trimmed, chips, readWorkspaceText, { embeddedContext });

    // Show the user's message locally; echoed `user_message_chunk`s are ignored (see DECISIONS D13).
    const messageId = `user-${++this.userMessageSeq}`;
    const echo: acp.SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      messageId,
      content: { type: "text", text: trimmed },
    };
    this.applyLocalUpdate(echo);
    for (const chip of chips) {
      this.applyLocalUpdate({
        sessionUpdate: "user_message_chunk",
        messageId,
        content: { type: "resource_link", uri: vscode.Uri.file(chip.path).toString(), name: chipLabel(chip) },
      });
    }
    this.deps.contextTracker.clearExplicit();

    this.setTurnActive(true);
    try {
      const response = await agent.prompt(session.sessionId, blocks);
      this.handleStopReason(response.stopReason);
    } catch (error) {
      const message = errorMessage(error);
      this.notice("error", `Prompt failed: ${message}`);
      this.setTurnActive(false, "error");
      return;
    }
  }

  private handleStopReason(stopReason: acp.StopReason): void {
    this.setTurnActive(false, stopReason);
    switch (stopReason) {
      case "refusal":
        this.notice("warning", "Kiro declined to continue with this request.");
        break;
      case "max_tokens":
        this.notice("warning", "The response was cut off (token limit reached).");
        break;
      case "max_turn_requests":
        this.notice("warning", "The turn stopped after reaching the request limit.");
        break;
      default:
        break;
    }
    const sessionId = this.session?.sessionId;
    if (sessionId) this.deps.permissions.cancelAll(sessionId);
  }

  private applyLocalUpdate(update: acp.SessionUpdate): void {
    const result = applyUpdate(this.transcript, update);
    this.transcript = result.state;
    for (const emit of result.emits) this.post(emit);
  }

  // ---------------------------------------------------------------------
  // Session events from the agent
  // ---------------------------------------------------------------------

  private onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case "update": {
        if (event.sessionId !== this.session?.sessionId) return;
        if (event.update.sessionUpdate === "user_message_chunk") return;
        const result = applyUpdate(this.transcript, event.update);
        this.transcript = result.state;
        for (const emit of result.emits) {
          this.post(emit);
          if (emit.type === "toolCall") void this.onToolCallChanged(emit.call);
          if (emit.type === "plan") this.deps.plan.update(emit.entries, event.sessionId);
        }
        if (event.update.sessionUpdate === "notice" && typeof event.update.title === "string") {
          const sev = event.update.severity;
          this.notice(sev === "error" || sev === "warning" ? sev : "info", event.update.title);
        }
        return;
      }
      case "state": {
        if (event.session.sessionId !== this.session?.sessionId) return;
        this.session = event.session;
        this.transcript = withSessionSnapshot(this.transcript, {
          modes: event.session.modes,
          configOptions: event.session.configOptions,
          availableCommands: event.session.availableCommands,
        });
        this.models = toModelView(event.session.models);
        this.post({ type: "modes", modes: this.transcript.modes });
        this.post({ type: "configOptions", options: this.transcript.configOptions });
        this.post({ type: "models", models: this.models });
        this.post({ type: "commands", commands: this.transcript.commands });
        return;
      }
      case "turn_started":
      case "turn_finished":
      case "turn_failed":
        // Turn state is driven by prompt() itself so the webview sees it in order.
        return;
      case "extension_notification":
        this.deps.output.appendLine(`[ext] ${event.method} ${safeJson(event.params)}`);
        return;
      default:
        return;
    }
  }

  private async onToolCallChanged(call: ToolCallView): Promise<void> {
    const diffs = call.content.filter((c): c is ToolDiffContent => c.type === "diff");
    if (diffs.length === 0) return;
    if (call.status === "completed" || call.status === "failed" || call.status === "cancelled") {
      await this.deps.diff.reconcileToolCallEnded(call.toolCallId, call.status, diffs);
      return;
    }
    await this.maybeOpenDiffs(call.toolCallId, diffs);
  }

  private async maybeOpenDiffs(toolCallId: string, diffs: ToolDiffContent[]): Promise<void> {
    const auto = vscode.workspace.getConfiguration("kiroAcp").get<boolean>("autoOpenDiffs", true);
    if (!auto) return;
    const status = this.transcript.toolCalls[toolCallId]?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") return;
    for (let index = 0; index < diffs.length; index++) {
      const key = `${toolCallId}#${index}`;
      if (this.openedDiffs.has(key)) continue;
      this.openedDiffs.add(key);
      try {
        await this.deps.diff.openDiff(toolCallId, index, diffs[index], { preview: false });
      } catch (error) {
        this.deps.output.appendLine(`[warn] openDiff failed: ${errorMessage(error)}`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------

  private syncPermissions(): void {
    const pending = this.deps.permissions.pending();
    const current = new Set(pending.map((p) => p.requestId));
    for (const id of this.knownPermissionIds) {
      if (!current.has(id)) {
        this.knownPermissionIds.delete(id);
        this.post({ type: "permissionResolved", requestId: id });
      }
    }
    for (const request of pending) {
      if (this.knownPermissionIds.has(request.requestId)) continue;
      this.knownPermissionIds.add(request.requestId);
      this.post({ type: "permission", request });
      const entry = this.deps.permissions.getEntry(request.requestId);
      if (entry && entry.diffs.length > 0) {
        void this.maybeOpenDiffs(request.toolCallId, entry.diffs);
      }
      if (this.poster === null) {
        void vscode.commands.executeCommand("kiroAcp.focus");
      }
    }
  }

  // ---------------------------------------------------------------------
  // Messages from the webview
  // ---------------------------------------------------------------------

  async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case "ready":
        this.post({ type: "state", state: this.snapshot() });
        void this.ensureStarted();
        return;
      case "prompt":
        await this.prompt(message.text, message.chips);
        return;
      case "cancel":
        await this.cancel();
        return;
      case "newSession":
        await this.newSession();
        return;
      case "restart":
        await this.restart();
        return;
      case "login":
        await this.login(message.methodId);
        return;
      case "permissionResponse":
        try {
          this.deps.permissions.resolve(message.requestId, message.optionId);
        } catch (error) {
          this.notice("warning", errorMessage(error));
        }
        return;
      case "permissionAlways":
        this.deps.permissions.setPolicy(message.requestId, message.decision);
        return;
      case "setMode":
        await this.withSession((agent, sessionId) => agent.setMode(sessionId, message.modeId));
        return;
      case "setConfigOption":
        await this.withSession((agent, sessionId) =>
          agent.setConfigOption(sessionId, message.configId, message.value),
        );
        return;
      case "setModel":
        await this.withSession((agent, sessionId) => agent.setModel(sessionId, message.modelId));
        return;
      case "queryFiles": {
        const items = await searchFiles(message.query);
        this.post({ type: "fileSuggestions", query: message.query, items });
        return;
      }
      case "removeChip":
        this.deps.contextTracker.removeChip(message.id);
        return;
      case "openFile":
        await openFile(message.path, message.line);
        return;
      case "openDiff": {
        const call = this.transcript.toolCalls[message.toolCallId];
        const diff = call?.content[message.index];
        if (diff && diff.type === "diff") {
          await this.deps.diff.openDiff(message.toolCallId, message.index, diff, { preview: false });
        }
        return;
      }
      case "showTerminal":
        if (!this.deps.terminal.showTerminal(message.terminalId)) {
          this.notice("info", "That terminal is no longer available.");
        }
        return;
      case "openPlan":
        await this.deps.plan.open();
        return;
      case "showLog":
        this.deps.output.show(true);
        return;
      default:
        return;
    }
  }

  private async withSession(op: (agent: KiroAgent, sessionId: string) => Promise<unknown>): Promise<void> {
    const agent = this.agent;
    const sessionId = this.session?.sessionId;
    if (!agent || !sessionId) return;
    try {
      await op(agent, sessionId);
    } catch (error) {
      this.notice("warning", errorMessage(error));
    }
  }

  private async login(methodId: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    try {
      await agent.authenticate(methodId);
      await this.restart();
    } catch (error) {
      this.notice("error", `Sign-in failed: ${errorMessage(error)}`);
    }
  }

  // ---------------------------------------------------------------------
  // Selection / file context entry points (commands)
  // ---------------------------------------------------------------------

  addSelectionChip(): boolean {
    const chip = this.deps.contextTracker.addSelectionChip();
    if (!chip) return false;
    this.post({ type: "focusInput" });
    return true;
  }

  // ---------------------------------------------------------------------
  // Notices
  // ---------------------------------------------------------------------

  private notice(severity: NoticeView["severity"], text: string): void {
    const notice: NoticeView = { id: `n-${++this.noticeSeq}`, severity, text };
    this.notices = [...this.notices.slice(-9), notice];
    this.post({ type: "notice", notice });
    if (severity === "error") this.deps.output.appendLine(`[error] ${text}`);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    void this.agent?.stop();
    this.agent = null;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAuthMethodView(method: acp.AuthMethod): AuthMethodView {
  const terminal = "type" in method && method.type === "terminal";
  return { id: method.id, name: method.name, description: method.description ?? null, terminal };
}

function chipLabel(chip: ContextChip): string {
  return chip.kind === "selection" && chip.startLine !== undefined
    ? `${chip.label}:${chip.startLine}-${chip.endLine ?? chip.startLine}`
    : chip.label;
}

async function readWorkspaceText(absPath: string): Promise<string> {
  const uri = vscode.Uri.file(absPath);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder("utf-8").decode(bytes);
}

async function openFile(absPath: string, line?: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line && line > 0) {
      const pos = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch (error) {
    void vscode.window.showWarningMessage(`Cannot open ${absPath}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : safeJson(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
