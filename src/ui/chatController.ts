/**
 * Orchestrates the chat: agent lifecycle, every live session (transcript,
 * permissions, diffs, plan, notices) and the views that display them.
 *
 * One `KiroAgent` process hosts many sessions. Each attached view (sidebar,
 * editor tab, test recorder) displays exactly one session at a time; the
 * controller also tracks a *focused* session — the one most recently used
 * through its API or from a view — which the plan document, the status bar
 * commands and plain `attach()` views follow.
 *
 * Sessions are grouped: every chat tab is a group of its own, the sidebar is
 * the `sidebar` group and sessions created without a view live in `default`.
 * A grouped view lists and switches between the sessions of its group only;
 * closing a tab closes the sessions of its group (see DECISIONS D20).
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
import {
  describeOptions,
  formatExtensionResult,
  mergeCommands,
  parseSlash,
  routeSlash,
  type ParsedSlash,
  type SlashContext,
} from "../features/pure/slashCommands.js";
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
  PermissionView,
  SessionStatus,
  SessionSummary,
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

/**
 * A webview attached through {@link ChatController.attachView}: it displays
 * one session (or none yet) and can be re-pointed at another.
 */
export interface ViewHandle {
  /** The session this view displays, or null when it has none yet. */
  readonly sessionId: string | null;
  /** The group whose sessions this view lists, or null for a view that sees every session. */
  readonly groupId: string | null;
  /**
   * Display `sessionId` (must be a live session) or nothing; posts `session` +
   * `state`. A grouped view adopts the session into its group.
   */
  setSession(sessionId: string | null): void;
  /** Make this view the focused one (its session becomes the focused session). */
  focus(): void;
  /** `UiState` for the displayed session. */
  snapshot(): UiState;
  /** Detach the view. */
  dispose(): void;
}

export interface AttachViewOptions {
  /**
   * Which session the view gets when it has none and the agent becomes ready:
   * `fresh` (a new, unused session — editor tabs) or `focused` (the focused
   * session — the sidebar). Default `focused`.
   */
  prefer?: "fresh" | "focused";
  /**
   * The session group of the view (a chat tab, the sidebar). Omitted: the
   * view lists every session and `newSession()` through it uses the focused
   * view's group.
   */
  groupId?: string;
}

/** Group of sessions created without any view (API, tests, the first auto-created session). */
export const DEFAULT_GROUP = "default";

/** Diff tabs open automatically: for every edit, only when a permission asks for it, or never. */
export type AutoOpenDiffs = "always" | "whenPermissionRequired" | "never";

const TURN_ACTIVE_KEY = "kiroAcp.turnActive";
const TITLE_MAX = 40;
const SESSIONS_DEBOUNCE_MS = 50;
/** Webview messages that act on the view's session and may therefore need one assigned first. */
const NEEDS_SESSION = new Set<FromWebview["type"]>([
  "prompt",
  "setMode",
  "setConfigOption",
  "setModel",
  "cancel",
  "newSession",
  "selectSession",
]);

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

class ChatSession {
  transcript: TranscriptState;
  models: ModelView | null;
  turnActive = false;
  notices: NoticeView[] = [];
  userMessageSeq = 0;
  readonly knownPermissionIds = new Set<string>();
  readonly openedDiffs = new Set<string>();
  /** `session_info_update.title` from the agent, when present. */
  agentTitle: string | null = null;
  /** First prompt text sent to the agent (truncated), the fallback title. */
  firstPrompt: string | null = null;
  updatedAt = Date.now();

  constructor(
    public state: SessionState,
    /** Creation order, breaks `updatedAt` ties. */
    readonly seq: number,
    /** The tab / sidebar group the session belongs to (see D20). */
    public groupId: string,
  ) {
    this.transcript = withSessionSnapshot(createTranscript(), {
      modes: state.modes,
      configOptions: state.configOptions,
      availableCommands: state.availableCommands,
    });
    this.models = toModelView(state.models);
  }

  get id(): string {
    return this.state.sessionId;
  }

  touch(): void {
    this.updatedAt = Date.now();
  }

  title(): string {
    return this.agentTitle ?? this.firstPrompt ?? "New session";
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface ViewOps {
  focusedId(): string | null;
  setSession(view: ViewBinding, sessionId: string | null): void;
  focus(view: ViewBinding): void;
  snapshot(view: ViewBinding): UiState;
  detach(view: ViewBinding): void;
}

class ViewBinding implements ViewHandle {
  /** Displayed session of a non-following view. */
  displayed: string | null = null;
  /** In-flight initial assignment (one per view, see {@link ChatController.assignSession}). */
  assigning: Promise<void> | null = null;
  /** Dedupe key of the last `sessions` list posted to this view. */
  lastSessionsKey = "";

  constructor(
    readonly poster: (message: ToWebview) => void,
    /** Plain `attach()` views follow the focused session. */
    readonly follows: boolean,
    /** Pending initial assignment; cleared once a session is displayed. */
    public prefer: "fresh" | "focused" | null,
    /** Session group (tab / sidebar); null lists every session. */
    readonly groupId: string | null,
    private readonly ops: ViewOps,
  ) {}

  get sessionId(): string | null {
    return this.follows ? this.ops.focusedId() : this.displayed;
  }

  setSession(sessionId: string | null): void {
    this.ops.setSession(this, sessionId);
  }

  focus(): void {
    this.ops.focus(this);
  }

  snapshot(): UiState {
    return this.ops.snapshot(this);
  }

  dispose(): void {
    this.ops.detach(this);
  }
}

function asBinding(view: ViewHandle | undefined): ViewBinding | undefined {
  return view instanceof ViewBinding ? view : undefined;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class ChatController implements vscode.Disposable {
  private agent: KiroAgent | null = null;
  private agentInfo: AgentInfo | null = null;
  private connection: ConnectionView = { status: "stopped" };
  private readonly sessions = new Map<string, ChatSession>();
  private focusedId: string | null = null;
  /** The view most recently used by the user; `newSession()`/`selectSession()` without a view act on it. */
  private focusedView: ViewBinding | null = null;
  private sessionSeq = 0;
  private noticeSeq = 0;
  /** Notices not tied to a session (agent start failures); shown in every view. */
  private globalNotices: NoticeView[] = [];
  private readonly views = new Set<ViewBinding>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private starting: Promise<void> | null = null;
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Called when a session waits for the user (permission request) while no
   * view is attached at all; the host opens a view on that session.
   */
  onNeedsView: ((sessionId: string) => void) | null = null;

  private readonly viewOps: ViewOps = {
    focusedId: () => this.focusedId,
    setSession: (view, sessionId) => this.setViewSession(view, sessionId),
    focus: (view) => this.focusView(view),
    snapshot: (view) => this.snapshotFor(view),
    detach: (view) => this.detachView(view),
  };

  constructor(private readonly deps: ChatControllerDeps) {
    this.disposables.push(
      deps.permissions.onDidChange(() => this.syncPermissions()),
      deps.contextTracker.onDidChange((chips) => this.postAll({ type: "chips", chips })),
    );
  }

  // ---------------------------------------------------------------------
  // Webview binding
  // ---------------------------------------------------------------------

  /**
   * Register a webview that follows the focused session (tests, simple
   * consumers). Attaching the same poster twice is a no-op. Returns the
   * unsubscribe function.
   */
  attach(poster: (message: ToWebview) => void): () => void {
    let view = [...this.views].find((v) => v.follows && v.poster === poster);
    if (!view) {
      view = new ViewBinding(poster, true, null, null, this.viewOps);
      this.views.add(view);
    }
    const bound = view;
    return () => this.detachView(bound);
  }

  /**
   * Register a webview with its own displayed session (sidebar, editor tab).
   * The session is assigned by `setSession()` or, once the agent is ready, by
   * {@link ensureViewSession} / the webview's `ready` message.
   */
  attachView(poster: (message: ToWebview) => void, options: AttachViewOptions = {}): ViewHandle {
    const view = new ViewBinding(poster, false, options.prefer ?? "focused", options.groupId ?? null, this.viewOps);
    this.views.add(view);
    return view;
  }

  /** Remove the views using `poster`, or all of them when called without arguments. */
  detach(poster?: (message: ToWebview) => void): void {
    for (const view of [...this.views]) {
      if (!poster || view.poster === poster) this.detachView(view);
    }
  }

  private detachView(view: ViewBinding): void {
    this.views.delete(view);
    if (this.focusedView === view) this.focusedView = null;
  }

  /** True when at least one webview is attached. */
  get hasView(): boolean {
    return this.views.size > 0;
  }

  /** The focused session (most recently used through the API or a view). */
  get focusedSessionId(): string | null {
    return this.focusedId;
  }

  /** Ids of every live session, most recent first. */
  sessionIds(): string[] {
    return this.sortedSessions().map((s) => s.id);
  }

  /** The group of a live session, or null when unknown. */
  sessionGroup(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.groupId ?? null;
  }

  /**
   * Full `UiState` for `sessionId` listing every session; `undefined` means
   * the focused session, `null` an empty view with no session.
   */
  snapshot(sessionId?: string | null): UiState {
    return this.buildSnapshot(sessionId === undefined ? this.focusedId : sessionId, null);
  }

  /** `UiState` as `view` sees it: its session and the sessions of its group. */
  private snapshotFor(view: ViewBinding): UiState {
    return this.buildSnapshot(view.sessionId, view.groupId);
  }

  private buildSnapshot(id: string | null, groupId: string | null): UiState {
    const session = id ? (this.sessions.get(id) ?? null) : null;
    const transcript = session?.transcript ?? createTranscript();
    const state = snapshotToUiState(transcript, {
      connection: this.connection,
      sessionId: session?.id ?? null,
      sessions: this.sessionSummaries(groupId),
      turnActive: session?.turnActive ?? false,
      permissions: session ? this.pendingFor(session.id) : [],
      models: session?.models ?? null,
      chips: this.deps.contextTracker.chips(),
      notices: [...this.globalNotices, ...(session?.notices ?? [])],
    });
    const toolCalls: Record<string, ToolCallView> = {};
    for (const [callId, call] of Object.entries(state.toolCalls)) {
      toolCalls[callId] = this.withTerminalOutput(call);
    }
    const config = vscode.workspace.getConfiguration("kiroAcp");
    const showSettings = config.get<boolean>("showSettingsByDefault", false);
    const sessionPanelCollapsed = config.get<boolean>("sessionPanelCollapsed", false);
    return {
      ...state,
      toolCalls,
      commands: mergeCommands(transcript.commands, this.slashContext(transcript)),
      prefs: { showSettings, sessionPanelCollapsed },
    };
  }

  /** Post to every attached view (connection, sessions, chips, ...). */
  private postAll(message: ToWebview): void {
    for (const view of this.views) this.postView(view, message);
  }

  /** Post to the views displaying `sessionId` (incremental session messages). */
  private postTo(sessionId: string, message: ToWebview): void {
    for (const view of this.views) {
      if (view.sessionId === sessionId) this.postView(view, message);
    }
  }

  private postView(view: ViewBinding, message: ToWebview): void {
    if (message.type === "toolCall") {
      message = { type: "toolCall", call: this.withTerminalOutput(message.call) };
    }
    view.poster(message);
  }

  /** Post `session` + a full `state` snapshot (as the view sees it) to `view`. */
  private postSessionState(view: ViewBinding, sessionId: string | null): void {
    this.postView(view, { type: "session", sessionId });
    this.postView(view, { type: "state", state: this.snapshotFor(view) });
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
  // View ↔ session assignment
  // ---------------------------------------------------------------------

  private setViewSession(view: ViewBinding, sessionId: string | null): void {
    if (view.follows) return;
    const session = sessionId !== null ? this.sessions.get(sessionId) : undefined;
    const id = session?.id ?? null;
    if (session) {
      view.prefer = null;
      // A displayed session belongs to the view's group (adopts `default` / API-assigned sessions).
      if (view.groupId !== null && session.groupId !== view.groupId) {
        session.groupId = view.groupId;
        this.scheduleSessions();
      }
    }
    view.displayed = id;
    this.postSessionState(view, id);
  }

  private focusView(view: ViewBinding): void {
    if (!view.follows) this.focusedView = view;
    const id = view.sessionId;
    if (id) this.focus(id);
  }

  /**
   * Start the agent if needed and give `view` a session when it has none:
   * a fresh one for `prefer: "fresh"` views, else the focused session.
   */
  async ensureViewSession(view?: ViewHandle): Promise<void> {
    await this.ensureStarted();
    const binding = asBinding(view);
    if (binding) await this.assignSession(binding);
  }

  /**
   * Give `view` its first session. One assignment per view is in flight at a
   * time: `adopt()` and the webview's `ready` both call this while
   * `session/new` is pending and must not open two sessions.
   */
  private assignSession(view: ViewBinding): Promise<void> {
    if (view.follows || view.displayed !== null || !this.views.has(view)) return Promise.resolve();
    if (!this.agent || this.agent.status !== "ready") return Promise.resolve();
    if (view.assigning) return view.assigning;
    view.assigning = this.doAssignSession(view).finally(() => {
      view.assigning = null;
    });
    return view.assigning;
  }

  private async doAssignSession(view: ViewBinding): Promise<void> {
    const groupId = view.groupId ?? this.focusedView?.groupId ?? DEFAULT_GROUP;
    if (view.prefer === "fresh") {
      const spare = this.spareSession(groupId) ?? this.spareSession(DEFAULT_GROUP);
      const created = spare ? null : await this.createSession(groupId);
      const id = spare?.id ?? created?.id ?? null;
      // Only the create path awaits here: adopting a spare stays synchronous,
      // so two tabs opened together cannot both pick the same spare.
      if (created && (await this.dropIfOrphaned(created, view))) return;
      if (id && view.displayed === null && this.views.has(view)) {
        this.setViewSession(view, id);
        this.focusView(view);
      }
      return;
    }
    // `focused`: the focused session when the view may list it, else a session of its own.
    const focused = this.focusedId ? this.sessions.get(this.focusedId) : undefined;
    const usable =
      focused && (view.groupId === null || focused.groupId === view.groupId || focused.groupId === DEFAULT_GROUP);
    const spare = usable ? undefined : (this.spareSession(groupId) ?? this.spareSession(DEFAULT_GROUP));
    const existing = usable ? focused.id : spare?.id;
    const created = existing ? null : await this.createSession(groupId);
    const id = existing ?? created?.id ?? null;
    if (created && (await this.dropIfOrphaned(created, view))) return;
    if (id && view.displayed === null && this.views.has(view)) {
      this.setViewSession(view, id);
      if (!this.focusedId) this.focus(id);
    }
  }

  /**
   * A session created for `view` arrived after the view went away (its tab
   * was closed while `session/new` was in flight): close it unless another
   * attached view lists its group, so no session lingers in a group nothing
   * shows or closes (D20). `default` sessions stay: any view can adopt them.
   * Returns true when the session was dropped.
   */
  private async dropIfOrphaned(session: ChatSession, view: ViewBinding): Promise<boolean> {
    if (this.views.has(view) || !this.sessions.has(session.id)) return false;
    if (session.groupId === DEFAULT_GROUP) return false;
    if ([...this.views].some((v) => v.groupId === session.groupId)) return false;
    this.deps.output.appendLine(`[info] session ${session.id} orphaned (its view closed while it was opening)`);
    await this.closeSession(session.id);
    return true;
  }

  private async assignPendingViews(): Promise<void> {
    for (const view of [...this.views]) {
      if (!view.follows && view.displayed === null) await this.assignSession(view);
    }
  }

  /** An idle, empty session of `groupId` that no view displays (the auto-created first session, typically). */
  private spareSession(groupId: string): ChatSession | undefined {
    const displayed = new Set<string>();
    for (const view of this.views) {
      if (!view.follows && view.displayed) displayed.add(view.displayed);
    }
    return this.sortedSessions().find(
      (s) => s.groupId === groupId && !displayed.has(s.id) && !s.turnActive && s.transcript.items.length === 0,
    );
  }

  // ---------------------------------------------------------------------
  // Focus
  // ---------------------------------------------------------------------

  /** Make `sessionId` the focused session: plan document, context keys and following views switch. */
  private focus(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || this.focusedId === sessionId) return;
    this.focusedId = sessionId;
    if (session.transcript.plan.length > 0) this.deps.plan.update(session.transcript.plan, sessionId);
    else this.deps.plan.reset(sessionId);
    void vscode.commands.executeCommand("setContext", TURN_ACTIVE_KEY, session.turnActive);
    for (const view of this.views) {
      if (view.follows) this.postSessionState(view, sessionId);
    }
  }

  private clearFocus(): void {
    const hadFocus = this.focusedId !== null;
    this.focusedId = null;
    this.deps.plan.reset();
    void vscode.commands.executeCommand("setContext", TURN_ACTIVE_KEY, false);
    if (!hadFocus) return;
    for (const view of this.views) {
      if (view.follows) this.postSessionState(view, null);
    }
  }

  // ---------------------------------------------------------------------
  // Session summaries
  // ---------------------------------------------------------------------

  private agentDown(): boolean {
    return !this.agent || this.agent.status === "stopped" || this.agent.status === "error";
  }

  private statusOf(session: ChatSession): SessionStatus {
    if (this.agentDown()) return "error";
    // A permission request only exists mid-turn; waiting for the user wins over "running".
    if (this.pendingFor(session.id).length > 0) return "needs_input";
    if (session.turnActive) return "running";
    return "idle";
  }

  private sortedSessions(): ChatSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.seq - a.seq);
  }

  /** Summaries of the sessions of `groupId` (every session when null), most recent first. */
  private sessionSummaries(groupId: string | null): SessionSummary[] {
    return this.sortedSessions()
      .filter((s) => groupId === null || s.groupId === groupId)
      .map((s) => ({
        id: s.id,
        title: s.title(),
        status: this.statusOf(s),
        updatedAt: s.updatedAt,
      }));
  }

  /**
   * Post `sessions` to every view, debounced and only when that view's list
   * changed. `updatedAt` ticks on every streamed chunk, so the dedupe key
   * rounds it to the minute: the webview must not rebuild its session panel
   * (and lose clicks) every 50 ms during a turn.
   */
  private scheduleSessions(): void {
    if (this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = undefined;
      const cache = new Map<string | null, { sessions: SessionSummary[]; key: string }>();
      for (const view of this.views) {
        let entry = cache.get(view.groupId);
        if (!entry) {
          const sessions = this.sessionSummaries(view.groupId);
          const key = JSON.stringify(
            sessions.map((s) => [s.id, s.title, s.status, Math.floor(s.updatedAt / 60_000)]),
          );
          entry = { sessions, key };
          cache.set(view.groupId, entry);
        }
        if (entry.key === view.lastSessionsKey) continue;
        view.lastSessionsKey = entry.key;
        this.postView(view, { type: "sessions", sessions: entry.sessions });
      }
    }, SESSIONS_DEBOUNCE_MS);
  }

  private pendingFor(sessionId: string): PermissionView[] {
    return this.deps.permissions
      .pending()
      .filter((p) => this.deps.permissions.getEntry(p.requestId)?.sessionId === sessionId);
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

  /** Start the agent process (idempotent) and open a first session when none exists. */
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
    // Sessions belong to the process; a new process starts without any.
    this.endAllSessions();
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
      if (this.sessions.size === 0) {
        const first = await this.createSession(this.focusedView?.groupId ?? DEFAULT_GROUP);
        if (first) this.focus(first.id);
      }
      await this.assignPendingViews();
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`agent start failed: ${message}`);
      this.setConnection({ status: "error", message });
      this.notice(null, "error", `Could not start Kiro CLI: ${message}`);
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
    this.endAllSessions();
    await this.teardownAgent();
    this.setConnection({ status: "stopped" });
    await this.ensureStarted();
  }

  /**
   * Stop the agent process without forgetting the sessions: they stay listed
   * with status `error` until {@link restart}, exactly as after a crash.
   * (Used by the integration tests to simulate an agent exit.)
   */
  async shutdownAgent(): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    try {
      await agent.stop();
    } catch (error) {
      this.deps.output.appendLine(`[warn] agent stop failed: ${errorMessage(error)}`);
    }
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
      // The sessions stay visible (status `error`) until the agent restarts.
      for (const session of this.sessions.values()) {
        this.deps.permissions.cancelAll(session.id);
        if (session.turnActive) this.setTurnActive(session, false, "error");
      }
    }
    this.setConnection(this.connectionFromAgent(change.status, change.message));
    if (change.status === "error" && change.message) {
      this.notice(null, "error", change.message);
    }
    this.scheduleSessions();
  }

  private setConnection(view: ConnectionView): void {
    this.connection = view;
    this.postAll({ type: "connection", connection: view });
    this.scheduleSessions();
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  private async createSession(groupId: string): Promise<ChatSession | null> {
    const agent = this.agent;
    if (!agent) return null;
    try {
      const state = await agent.newSession(this.workspaceRoot());
      const session = new ChatSession(state, ++this.sessionSeq, groupId);
      this.sessions.set(session.id, session);
      this.deps.output.appendLine(`[info] session ${session.id} opened (group ${groupId})`);
      this.scheduleSessions();
      return session;
    } catch (error) {
      const message = errorMessage(error);
      if (this.agent?.status === "auth_required") {
        this.setConnection(this.connectionFromAgent("auth_required", "Sign in to Kiro to start a session."));
      } else {
        this.notice(null, "error", `Could not create a session: ${message}`);
      }
      return null;
    }
  }

  /** Forget every session (agent restart). */
  private endAllSessions(): void {
    for (const session of this.sessions.values()) {
      this.deps.permissions.cancelAll(session.id);
      this.deps.permissions.clearPolicies(session.id);
    }
    this.sessions.clear();
    for (const view of this.views) {
      if (view.follows || view.displayed === null) continue;
      view.displayed = null;
      this.postSessionState(view, null);
    }
    this.clearFocus();
    this.scheduleSessions();
  }

  /**
   * Create a session (keeping the others), focus it and display it in
   * `view` (or the focused view). Returns the new session id, or null when
   * no session could be created.
   */
  async newSession(view?: ViewHandle): Promise<string | null> {
    const binding = asBinding(view) ?? this.focusedView;
    const groupId = binding?.groupId ?? this.focusedView?.groupId ?? DEFAULT_GROUP;
    if (!this.agent || this.agent.status !== "ready") {
      // Starting the agent opens a first session; a view with none gets one assigned.
      await this.ensureStarted();
      if (binding && !binding.follows) {
        await this.assignSession(binding);
        return binding.displayed ?? this.focusedId;
      }
      return this.focusedId;
    }
    const session = await this.createSession(groupId);
    if (!session) return null;
    if (binding && !binding.follows) {
      if (await this.dropIfOrphaned(session, binding)) return null;
      this.setViewSession(binding, session.id);
    }
    this.focus(session.id);
    return session.id;
  }

  /**
   * Display an existing session in `view` (or the focused view) and focus it.
   * A grouped view only switches within its group (plus `default`, which it
   * adopts); a session of another tab is ignored.
   */
  selectSession(sessionId: string, view?: ViewHandle): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const binding = asBinding(view) ?? this.focusedView;
    if (binding && !binding.follows) {
      if (binding.groupId !== null && session.groupId !== binding.groupId && session.groupId !== DEFAULT_GROUP) {
        return;
      }
      this.setViewSession(binding, sessionId);
    }
    this.focus(sessionId);
  }

  /** Close every session of `groupId` (a chat tab was closed, see D20). */
  async closeGroup(groupId: string): Promise<void> {
    for (const session of this.sortedSessions()) {
      if (session.groupId === groupId) await this.closeSession(session.id);
    }
  }

  /**
   * Cancel, forget and drop a session. Views displaying it switch to the
   * most recent remaining session of their group (a new one is created when
   * none is left); when the closed session was focused, focus follows the
   * replacement of the view that showed it (the focused view's first).
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.turnActive && this.agent) {
      try {
        await this.agent.cancel(sessionId);
      } catch (error) {
        this.deps.output.appendLine(`[warn] cancel before close failed: ${errorMessage(error)}`);
      }
    }
    this.deps.permissions.cancelAll(sessionId);
    this.deps.permissions.clearPolicies(sessionId);
    this.sessions.delete(sessionId);
    this.deps.output.appendLine(`[info] session ${sessionId} closed`);

    const wasFocused = this.focusedId === sessionId;
    const displaying = [...this.views].filter((v) => !v.follows && v.displayed === sessionId);
    const ready = this.agent?.status === "ready";
    // Each displaying view falls back to the most recent session of its group (a new one when none is left).
    let replacement: string | null = null;
    for (const view of displaying) {
      const groupId = view.groupId ?? this.focusedView?.groupId ?? DEFAULT_GROUP;
      let fallback: string | null =
        this.sortedSessions().find((s) => view.groupId === null || s.groupId === groupId)?.id ?? null;
      let created: ChatSession | null = null;
      if (!fallback && ready) {
        created = await this.createSession(groupId);
        fallback = created?.id ?? null;
      }
      if (created && (await this.dropIfOrphaned(created, view))) continue;
      if (!this.views.has(view)) continue;
      this.setViewSession(view, fallback);
      if (fallback && (replacement === null || view === this.focusedView)) replacement = fallback;
    }
    if (wasFocused) {
      this.focusedId = null;
      // Focus what the user now sees in place of the closed session, not the globally newest one.
      let fallback: string | null = replacement ?? this.sortedSessions()[0]?.id ?? null;
      if (!fallback && ready) {
        fallback = (await this.createSession(this.focusedView?.groupId ?? DEFAULT_GROUP))?.id ?? null;
      }
      if (fallback) this.focus(fallback);
      else this.clearFocus();
    }
    this.scheduleSessions();
  }

  /** Cancel the running turn of `sessionId` (default: the focused session). */
  async cancel(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.focusedId;
    if (!id || !this.agent || !this.sessions.has(id)) return;
    this.deps.permissions.cancelAll(id);
    try {
      await this.agent.cancel(id);
    } catch (error) {
      this.notice(this.sessions.get(id) ?? null, "warning", `Cancel failed: ${errorMessage(error)}`);
    }
  }

  private setTurnActive(session: ChatSession, active: boolean, stopReason?: string): void {
    session.turnActive = active;
    session.touch();
    if (this.focusedId === session.id) {
      void vscode.commands.executeCommand("setContext", TURN_ACTIVE_KEY, active);
    }
    this.postTo(session.id, stopReason ? { type: "turn", active, stopReason } : { type: "turn", active });
    this.scheduleSessions();
  }

  // ---------------------------------------------------------------------
  // Prompting
  // ---------------------------------------------------------------------

  /**
   * Send a prompt to `sessionId` (default: the session of `view`, else the
   * focused session) and wait for the turn to end. `view` is the webview the
   * prompt came from, so `/clear` can replace the session in that very view.
   */
  async prompt(text: string, chips: ContextChip[], sessionId?: string, view?: ViewHandle): Promise<void> {
    await this.ensureStarted();
    const agent = this.agent;
    const binding = asBinding(view);
    if (binding && !binding.follows && binding.displayed === null) await this.assignSession(binding);
    const viewSessionId = binding?.sessionId ?? null;
    const session =
      (sessionId ? this.sessions.get(sessionId) : undefined) ??
      (viewSessionId ? this.sessions.get(viewSessionId) : undefined) ??
      (this.focusedId ? this.sessions.get(this.focusedId) : undefined);
    if (!agent || !session || agent.status !== "ready") {
      this.notice(null, "warning", "No active session. Sign in or restart the agent, then try again.");
      return;
    }
    this.focus(session.id);
    if (session.turnActive) {
      this.notice(session, "info", "Wait for the current turn to finish or cancel it first.");
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && chips.length === 0) return;

    const parsed = parseSlash(trimmed);
    if (parsed && (await this.runSlash(session, parsed, chips, binding))) return;

    const embeddedContext = this.agentInfo?.agentCapabilities.promptCapabilities?.embeddedContext === true;
    const blocks = await buildPromptBlocks(trimmed, chips, readWorkspaceText, { embeddedContext });

    if (session.firstPrompt === null && trimmed) {
      session.firstPrompt = truncateTitle(trimmed);
    }
    // Show the user's message locally; echoed `user_message_chunk`s are ignored (see DECISIONS D13).
    const messageId = `user-${++session.userMessageSeq}`;
    const echo: acp.SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      messageId,
      content: { type: "text", text: trimmed },
    };
    this.applyLocalUpdate(session, echo);
    for (const chip of chips) {
      this.applyLocalUpdate(session, {
        sessionUpdate: "user_message_chunk",
        messageId,
        content: { type: "resource_link", uri: vscode.Uri.file(chip.path).toString(), name: chipLabel(chip) },
      });
    }
    this.deps.contextTracker.clearExplicit();

    this.setTurnActive(session, true);
    try {
      const response = await agent.prompt(session.id, blocks);
      this.handleStopReason(session, response.stopReason);
    } catch (error) {
      const message = errorMessage(error);
      this.notice(session, "error", `Prompt failed: ${message}`);
      this.setTurnActive(session, false, "error");
      return;
    }
  }

  private handleStopReason(session: ChatSession, stopReason: acp.StopReason): void {
    this.setTurnActive(session, false, stopReason);
    switch (stopReason) {
      case "refusal":
        this.notice(session, "warning", "Kiro declined to continue with this request.");
        break;
      case "max_tokens":
        this.notice(session, "warning", "The response was cut off (token limit reached).");
        break;
      case "max_turn_requests":
        this.notice(session, "warning", "The turn stopped after reaching the request limit.");
        break;
      default:
        break;
    }
    this.deps.permissions.cancelAll(session.id);
  }

  private applyLocalUpdate(session: ChatSession, update: acp.SessionUpdate): void {
    const result = applyUpdate(session.transcript, update);
    session.transcript = result.state;
    session.touch();
    for (const emit of result.emits) this.postTo(session.id, emit);
    this.scheduleSessions();
  }

  // ---------------------------------------------------------------------
  // Session events from the agent
  // ---------------------------------------------------------------------

  private onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case "update": {
        const session = this.sessions.get(event.sessionId);
        if (!session) return;
        session.touch();
        this.scheduleSessions();
        const update = event.update;
        if (update.sessionUpdate === "user_message_chunk") return;
        if (update.sessionUpdate === "session_info_update") {
          if (typeof update.title === "string") session.agentTitle = update.title.trim() || null;
          else if (update.title === null) session.agentTitle = null;
          return;
        }
        const result = applyUpdate(session.transcript, update);
        session.transcript = result.state;
        for (const emit of result.emits) {
          this.postTo(
            session.id,
            emit.type === "commands" ? { type: "commands", commands: this.commandsView(session) } : emit,
          );
          if (emit.type === "toolCall") void this.onToolCallChanged(session, emit.call);
          if (emit.type === "plan" && this.focusedId === session.id) {
            this.deps.plan.update(emit.entries, session.id);
          }
        }
        if (update.sessionUpdate === "notice" && typeof update.title === "string") {
          const sev = update.severity;
          this.notice(session, sev === "error" || sev === "warning" ? sev : "info", update.title);
        }
        return;
      }
      case "state": {
        const session = this.sessions.get(event.session.sessionId);
        if (!session) return;
        session.state = event.session;
        session.transcript = withSessionSnapshot(session.transcript, {
          modes: event.session.modes,
          configOptions: event.session.configOptions,
          availableCommands: event.session.availableCommands,
        });
        session.models = toModelView(event.session.models);
        this.postTo(session.id, { type: "modes", modes: session.transcript.modes });
        this.postTo(session.id, { type: "configOptions", options: session.transcript.configOptions });
        this.postTo(session.id, { type: "models", models: session.models });
        this.postTo(session.id, { type: "commands", commands: this.commandsView(session) });
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

  private async onToolCallChanged(session: ChatSession, call: ToolCallView): Promise<void> {
    const diffs = call.content.filter((c): c is ToolDiffContent => c.type === "diff");
    if (diffs.length === 0) return;
    if (call.status === "completed" || call.status === "failed" || call.status === "cancelled") {
      // Forget the "already opened" marks so a later tool call re-using the id opens again.
      for (const key of session.openedDiffs) {
        if (key.startsWith(`${call.toolCallId}#`)) session.openedDiffs.delete(key);
      }
      await this.deps.diff.reconcileToolCallEnded(call.toolCallId, call.status, diffs);
      return;
    }
    // Without a permission request the edit goes through anyway; only `always` opens a tab for it.
    if (this.autoOpenDiffs() === "always") await this.maybeOpenDiffs(session, call.toolCallId, diffs);
  }

  /** `kiroAcp.autoOpenDiffs`; the legacy booleans map to `always` / `never`. */
  private autoOpenDiffs(): AutoOpenDiffs {
    const value = vscode.workspace.getConfiguration("kiroAcp").get<unknown>("autoOpenDiffs", "whenPermissionRequired");
    if (value === true || value === "always") return "always";
    if (value === false || value === "never") return "never";
    return "whenPermissionRequired";
  }

  private async maybeOpenDiffs(session: ChatSession, toolCallId: string, diffs: ToolDiffContent[]): Promise<void> {
    const status = session.transcript.toolCalls[toolCallId]?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") return;
    for (let index = 0; index < diffs.length; index++) {
      const key = `${toolCallId}#${index}`;
      if (session.openedDiffs.has(key)) continue;
      session.openedDiffs.add(key);
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
    const bySession = new Map<string, PermissionView[]>();
    for (const request of this.deps.permissions.pending()) {
      const entry = this.deps.permissions.getEntry(request.requestId);
      if (!entry) continue;
      const list = bySession.get(entry.sessionId) ?? [];
      list.push(request);
      bySession.set(entry.sessionId, list);
    }
    for (const session of this.sessions.values()) {
      const pending = bySession.get(session.id) ?? [];
      const current = new Set(pending.map((p) => p.requestId));
      for (const id of session.knownPermissionIds) {
        if (!current.has(id)) {
          session.knownPermissionIds.delete(id);
          this.postTo(session.id, { type: "permissionResolved", requestId: id });
        }
      }
      for (const request of pending) {
        if (session.knownPermissionIds.has(request.requestId)) continue;
        session.knownPermissionIds.add(request.requestId);
        session.touch();
        this.postTo(session.id, { type: "permission", request });
        const entry = this.deps.permissions.getEntry(request.requestId);
        if (entry && entry.diffs.length > 0 && this.autoOpenDiffs() !== "never") {
          void this.maybeOpenDiffs(session, request.toolCallId, entry.diffs);
        }
        // Nobody can answer: open a view on *this* session (not a fresh tab hiding it).
        if (this.views.size === 0) this.onNeedsView?.(session.id);
      }
    }
    this.scheduleSessions();
  }

  // ---------------------------------------------------------------------
  // Messages from the webview
  // ---------------------------------------------------------------------

  /**
   * Handle a webview message on behalf of `view` (its displayed session) or,
   * without a view, the focused session. A message from a view focuses its
   * session.
   */
  async handle(message: FromWebview, view?: ViewHandle): Promise<void> {
    const binding = asBinding(view);
    if (message.type === "ready") {
      if (binding) this.postView(binding, { type: "state", state: binding.snapshot() });
      else for (const v of this.views) this.postView(v, { type: "state", state: v.snapshot() });
      void this.ensureViewSession(binding);
      return;
    }
    if (binding) {
      // Only messages that act on a session may assign one, and never while
      // the agent is down: `restart` / `ready` own the process lifecycle, and
      // "Show log" after a failed start must not spawn the CLI again.
      if (NEEDS_SESSION.has(message.type) && !binding.follows && binding.displayed === null && !this.agentDown()) {
        await this.assignSession(binding);
      }
      this.focusView(binding);
    }
    const sessionId = binding ? binding.sessionId : this.focusedId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    switch (message.type) {
      case "prompt":
        await this.prompt(message.text, message.chips, sessionId ?? undefined, binding);
        return;
      case "cancel":
        await this.cancel(sessionId ?? undefined);
        return;
      case "newSession":
        await this.newSession(binding);
        return;
      case "selectSession":
        this.selectSession(message.sessionId, binding);
        return;
      case "closeSession":
        await this.closeSession(message.sessionId);
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
          this.notice(session ?? null, "warning", errorMessage(error));
        }
        return;
      case "permissionAlways":
        this.deps.permissions.setPolicy(message.requestId, message.decision);
        return;
      case "setMode":
        await this.withSession(session, (agent, id) => agent.setMode(id, message.modeId));
        return;
      case "setConfigOption":
        await this.withSession(session, (agent, id) => agent.setConfigOption(id, message.configId, message.value));
        return;
      case "setModel":
        await this.withSession(session, (agent, id) => agent.setModel(id, message.modelId));
        return;
      case "queryFiles": {
        const items = await searchFiles(message.query);
        this.postAll({ type: "fileSuggestions", query: message.query, items });
        return;
      }
      case "removeChip":
        this.deps.contextTracker.removeChip(message.id);
        return;
      case "openFile":
        await openFile(message.path, message.line);
        return;
      case "openDiff": {
        const call = session?.transcript.toolCalls[message.toolCallId];
        const diff = call?.content[message.index];
        if (diff && diff.type === "diff") {
          await this.deps.diff.openDiff(message.toolCallId, message.index, diff, { preview: false });
        }
        return;
      }
      case "showTerminal":
        if (!this.deps.terminal.showTerminal(message.terminalId)) {
          this.notice(session ?? null, "info", "That terminal is no longer available.");
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

  private async withSession(
    session: ChatSession | undefined,
    op: (agent: KiroAgent, sessionId: string) => Promise<unknown>,
  ): Promise<void> {
    const agent = this.agent;
    if (!agent || !session) return;
    try {
      await op(agent, session.id);
    } catch (error) {
      this.notice(session, "warning", errorMessage(error));
    }
  }

  private async login(methodId: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    try {
      await agent.authenticate(methodId);
      await this.restart();
    } catch (error) {
      this.notice(null, "error", `Sign-in failed: ${errorMessage(error)}`);
    }
  }

  // ---------------------------------------------------------------------
  // Selection / file context entry points (commands)
  // ---------------------------------------------------------------------

  addSelectionChip(): boolean {
    const chip = this.deps.contextTracker.addSelectionChip();
    if (!chip) return false;
    this.postAll({ type: "focusInput" });
    return true;
  }

  // ---------------------------------------------------------------------
  // Slash commands (client-side routing, see DECISIONS D18)
  // ---------------------------------------------------------------------

  private slashContext(transcript: TranscriptState): SlashContext {
    return {
      extensionMethods: this.agentInfo?.kiroExtensionMethods ?? [],
      modes: transcript.modes,
      configOptions: transcript.configOptions,
      agentCommands: transcript.commands,
    };
  }

  /** Agent-advertised commands plus the client built-ins (for the `/` popup). */
  private commandsView(session: ChatSession) {
    return mergeCommands(session.transcript.commands, this.slashContext(session.transcript));
  }

  /** Show the user's command and a local reply in the transcript. */
  private localExchange(session: ChatSession, userText: string, replyText: string): void {
    this.applyLocalUpdate(session, {
      sessionUpdate: "user_message_chunk",
      messageId: `user-${++session.userMessageSeq}`,
      content: { type: "text", text: userText },
    });
    this.applyLocalUpdate(session, {
      sessionUpdate: "agent_message_chunk",
      messageId: `local-${session.userMessageSeq}`,
      content: { type: "text", text: replyText },
    });
    // Close the local message so the agent's next chunk starts a new one.
    session.transcript = { ...session.transcript, openMessage: null };
  }

  /**
   * Returns true when the command was handled locally. `forward` commands
   * (advertised by the agent) return false so the text goes out as a prompt.
   */
  private async runSlash(
    session: ChatSession,
    parsed: ParsedSlash,
    chips: ContextChip[],
    sender?: ViewBinding,
  ): Promise<boolean> {
    const raw = `/${parsed.name}${parsed.args ? ` ${parsed.args}` : ""}`;
    const context = this.slashContext(session.transcript);
    const action = routeSlash(parsed, context);
    const agent = this.agent;
    const sessionId = session.id;
    switch (action.kind) {
      case "forward":
        return false;
      case "new_session": {
        // `/clear`: a new session in the view the command came from (else the
        // focused view, else any view) when it displays this session.
        const displays = (v: ViewBinding | null | undefined): ViewBinding | undefined =>
          v && !v.follows && v.displayed === sessionId ? v : undefined;
        const view =
          displays(sender) ?? displays(this.focusedView) ?? [...this.views].find((v) => displays(v) !== undefined);
        await this.newSession(view);
        return true;
      }
      case "capabilities":
        this.localExchange(session, raw, this.describeCapabilities(session));
        return true;
      case "cancel":
        await this.cancel(sessionId);
        return true;
      case "restart":
        await this.restart();
        return true;
      case "help":
        this.localExchange(
          session,
          raw,
          "Available commands:\n" +
            action.commands.map((c) => `- \`/${c.name}\`${c.hint ? ` *${c.hint}*` : ""} — ${c.description}`).join("\n") +
            (action.unavailable.length > 0
              ? "\n\nNot available with this agent:\n" +
                action.unavailable.map((u) => `- \`/${u.name}\` — ${u.reason}`).join("\n")
              : ""),
        );
        return true;
      case "show_options":
        this.localExchange(session, raw, describeOptions(context, action.configId));
        return true;
      case "unavailable":
        this.localExchange(session, raw, `\`/${action.name}\` is not available: ${action.reason}.`);
        return true;
      case "set_mode":
        if (!agent) return true;
        try {
          await agent.setMode(sessionId, action.modeId);
          this.localExchange(session, raw, `Mode set to \`${action.modeId}\`.`);
        } catch (error) {
          this.localExchange(session, raw, `Could not set the mode: ${errorMessage(error)}`);
        }
        return true;
      case "set_config":
        if (!agent) return true;
        try {
          await agent.setConfigOption(sessionId, action.configId, action.value);
          this.localExchange(session, raw, `\`${action.configId}\` set to \`${action.value}\`.`);
        } catch (error) {
          this.localExchange(session, raw, `Could not change \`${action.configId}\`: ${errorMessage(error)}`);
        }
        return true;
      case "extension": {
        if (!agent) return true;
        try {
          const result = await agent.callExtension(action.method, { sessionId });
          this.localExchange(session, raw, formatExtensionResult(result));
        } catch (error) {
          this.localExchange(session, raw, `\`/${action.label}\` failed: ${errorMessage(error)}`);
        }
        return true;
      }
      case "plan": {
        if (!agent) return true;
        if (action.modeId === null) {
          this.localExchange(
            session,
            raw,
            "The agent did not advertise a planner mode. Ask it to plan in plain words instead.",
          );
          return true;
        }
        if (session.transcript.modes?.currentModeId !== action.modeId) {
          try {
            await agent.setMode(sessionId, action.modeId);
          } catch (error) {
            this.localExchange(session, raw, `Could not switch to planner mode: ${errorMessage(error)}`);
            return true;
          }
        }
        if (action.text) {
          await this.prompt(action.text, chips, sessionId);
        } else {
          this.localExchange(session, raw, `Planner mode \`${action.modeId}\` is active. Describe what to plan.`);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** `/capabilities`: everything the agent advertised, raw enough to paste into a bug report. */
  private describeCapabilities(session: ChatSession): string {
    const info = this.agentInfo;
    const lines: string[] = [];
    if (!info) {
      lines.push("The agent is not connected; nothing has been advertised yet.");
    } else {
      const name = info.agentInfo
        ? `${info.agentInfo.title ?? info.agentInfo.name} ${info.agentInfo.version ?? ""}`.trim()
        : "unknown agent";
      lines.push(`**Agent:** ${name} (protocol ${info.protocolVersion})`);
      const caps = info.agentCapabilities as Record<string, unknown>;
      const prompt = caps.promptCapabilities as Record<string, unknown> | null | undefined;
      const keysOf = (value: unknown): string =>
        value && typeof value === "object" ? Object.keys(value as object).join(", ") || "(empty)" : "none";
      const promptSummary = prompt
        ? Object.entries(prompt)
            .map(([k, v]) => `${k}=${safeJson(v)}`)
            .join(", ") || "(empty)"
        : "none";
      lines.push(
        "",
        "**Agent capabilities:**",
        `- loadSession: ${String(caps.loadSession ?? false)}`,
        `- promptCapabilities: ${promptSummary}`,
        `- sessionCapabilities: ${keysOf(caps.sessionCapabilities)}`,
        `- mcpCapabilities: ${keysOf(caps.mcpCapabilities)}`,
        `- authMethods: ${info.authMethods.length > 0 ? info.authMethods.map((m) => m.id).join(", ") : "none"}`,
        "",
        `**Extension methods (${info.kiroExtensionMethods.length}):**`,
        "```json",
        JSON.stringify(info.kiroExtensionMethods, null, 2),
        "```",
      );
    }
    const modes = session.transcript.modes;
    lines.push(
      "",
      modes
        ? `**Modes** (current: \`${modes.currentModeId}\`): ` +
            modes.availableModes.map((m) => `\`${m.id}\`${m.name !== m.id ? ` (${m.name})` : ""}`).join(", ")
        : "**Modes:** none advertised",
    );
    const options = session.transcript.configOptions;
    lines.push("", options.length > 0 ? "**Config options:**" : "**Config options:** none advertised");
    for (const opt of options) {
      const allowed =
        opt.type === "boolean"
          ? "true, false"
          : (opt.options ?? []).map((v) => `\`${v.value}\``).join(", ") || "(none)";
      lines.push(
        `- \`${opt.id}\`${opt.category ? ` [${opt.category}]` : ""}: current \`${String(opt.currentValue)}\` — allowed: ${allowed}`,
      );
    }
    const commands = session.transcript.commands;
    if (commands.length > 0) {
      lines.push("", `**Agent commands:** ${commands.map((c) => `\`/${c.name}\``).join(", ")}`);
    }
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------
  // Notices
  // ---------------------------------------------------------------------

  /** A notice for one session (its views) or, with `null`, for every view. */
  private notice(session: ChatSession | null, severity: NoticeView["severity"], text: string): void {
    const notice: NoticeView = { id: `n-${++this.noticeSeq}`, severity, text };
    if (session) {
      session.notices = [...session.notices.slice(-9), notice];
      this.postTo(session.id, { type: "notice", notice });
    } else {
      this.globalNotices = [...this.globalNotices.slice(-9), notice];
      this.postAll({ type: "notice", notice });
    }
    if (severity === "error") this.deps.output.appendLine(`[error] ${text}`);
  }

  dispose(): void {
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    void this.agent?.stop();
    this.agent = null;
    this.views.clear();
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

/** First line of the prompt, whitespace collapsed, cut to ~40 characters. */
function truncateTitle(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (line.length <= TITLE_MAX) return line;
  return `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
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
    // Beside the chat tab, without stealing its focus: the chat stays visible.
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });
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
