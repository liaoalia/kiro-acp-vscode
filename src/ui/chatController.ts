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
  AcpError,
  createKiroAgent,
  FALLBACK_LOGIN_METHOD,
  resolveCliPath,
  type AgentInfo,
  type ClientServices,
  type ConnectionStateChange,
  type KiroAgent,
  type ProtocolLogger,
  type SessionEvent,
  type SessionListEntry,
  type SessionState,
} from "../acp/index.js";
import {
  applyUpdate,
  createTranscript,
  setMessageDelivery,
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
  MessageDelivery,
  ModelView,
  NoticeView,
  PermissionView,
  SessionStatus,
  SessionSummary,
  ToWebview,
  ToolCallView,
  ToolDiffContent,
  ToolKind,
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

/** A past session the agent can restore (`session/list` entry, QuickPick-ready; see D21). */
export interface PastSessionEntry {
  sessionId: string;
  /** `title ?? sessionId`. */
  label: string;
  /** Relative time of `updatedAt` ("5m ago", "2h ago", "3d ago", or the date); empty when unknown. */
  description: string;
  /** The session's working directory. */
  detail: string;
  title: string | null;
  cwd: string;
  updatedAt: string | null;
}

/** Diff tabs open automatically: for every edit, only when a permission asks for it, or never. */
export type AutoOpenDiffs = "always" | "whenPermissionRequired" | "never";

/**
 * Session options the user chose last, re-applied to every new session when
 * `kiroAcp.rememberSessionOptions` is on (D24). Stored in `workspaceState`
 * under {@link SESSION_OPTIONS_KEY}.
 */
export interface RememberedSessionOptions {
  /** `session/set_mode` id. */
  modeId?: string;
  /** CLI v2 `session/set_model` id. */
  modelId?: string;
  /** `session/set_config_option` values by config id (V3: `model`, `effortLevel`, ...). */
  configOptions: Record<string, string | boolean>;
}

/** `workspaceState` key of {@link RememberedSessionOptions}. */
export const SESSION_OPTIONS_KEY = "kiroAcp.sessionOptions";

/**
 * Kiro V3 extension method that injects a prompt into the running turn. Its
 * parameter shape (`{ sessionId, prompt }`) mirrors `session/prompt` and is a
 * guess until confirmed against the real CLI (see DECISIONS D22; the
 * `[info] steer` output-channel lines show what was sent and answered).
 */
const STEER_METHOD = "_session/steer";

/** A prompt typed mid-turn and held until the turn ends (steering unavailable, see D22). */
interface QueuedPrompt {
  text: string;
  chips: ContextChip[];
  /** Built when queued, so the dequeue starts the turn without awaiting anything. */
  blocks: acp.ContentBlock[];
  /** View id of the echoed user message (its `queued` badge). */
  messageId: string;
}

const TURN_ACTIVE_KEY = "kiroAcp.turnActive";
/** Upper bound on `session/list` pages followed per listing (guards against an agent that never ends its list). */
const MAX_LIST_PAGES = 50;
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
  /** `session_info_update.title` from the agent (or the `session/list` title of a restored session), when present. */
  agentTitle: string | null = null;
  /** First prompt text sent to the agent (or replayed by `session/load`), truncated: the fallback title. */
  firstPrompt: string | null = null;
  /** True while `session/load` replays the session's history (see D21). */
  loading = false;
  /**
   * Ids of tool calls replayed by `session/load`: their terminal content is
   * history and is never resolved against this run's live terminals (D21).
   */
  readonly replayedToolCalls = new Set<string>();
  /** Prompts typed while a turn ran, sent one per turn end in order (D22). */
  readonly queue: QueuedPrompt[] = [];
  /** View ids of user messages sent through `_session/steer` and not yet injected. */
  readonly steering = new Set<string>();
  /** `_session/steer` failed once (e.g. -32601): later mid-turn prompts queue directly. */
  steerUnsupported = false;
  /**
   * Bumped whenever a turn starts or ends (D22): a steer rejection that
   * arrives after its turn ended compares this to the value it captured and
   * drops the message instead of queueing it into a new turn.
   */
  turnGeneration = 0;
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
  /** Titles seen in the last `session/list`, so a restore started by id can name the session (D21). */
  private readonly pastTitles = new Map<string, string | null>();

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
      toolCalls[callId] = this.withTerminalOutput(call, session);
    }
    const config = vscode.workspace.getConfiguration("kiroAcp");
    const showSettings = config.get<boolean>("showSettingsByDefault", false);
    const sessionPanelCollapsed = config.get<boolean>("sessionPanelCollapsed", false);
    return {
      ...state,
      acceptsPromptsDuringTurn: true,
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
      const session = view.sessionId ? (this.sessions.get(view.sessionId) ?? null) : null;
      message = { type: "toolCall", call: this.withTerminalOutput(message.call, session) };
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
   * Only terminals of `session` qualify, and a tool call replayed by
   * `session/load` keeps whatever the agent sent: its ids come from an
   * earlier run and must never show this run's live output (D9, D21).
   */
  private withTerminalOutput(call: ToolCallView, session: ChatSession | null): ToolCallView {
    if (!session || session.replayedToolCalls.has(call.toolCallId)) return call;
    if (!call.content.some((c) => c.type === "terminal")) return call;
    return {
      ...call,
      content: call.content.map((c) => {
        if (c.type !== "terminal") return c;
        const snap = this.deps.terminal.snapshot(c.terminalId, session.id);
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

  /**
   * Spawn a fresh agent process. With `restoreSessions` the sessions the
   * views were displaying are loaded back (`session/load`) into the same
   * views once the new process is ready, so a sign-in does not lose context.
   */
  async restart(options: { restoreSessions?: boolean } = {}): Promise<void> {
    const restore = options.restoreSessions ? this.displayedSessions() : [];
    this.endAllSessions();
    await this.teardownAgent();
    this.setConnection({ status: "stopped" });
    await this.ensureStarted();
    if (restore.length === 0 || this.agentInfo?.agentCapabilities.loadSession !== true) return;
    for (const { binding, sessionId } of restore) {
      await this.openPastSession(sessionId, binding);
    }
    // A view whose session could not be restored gets a fresh one.
    await this.assignPendingViews();
  }

  /** Views bound to a loaded session, with that session id (for a restore after restart). */
  private displayedSessions(): Array<{ binding: ViewBinding; sessionId: string }> {
    const out: Array<{ binding: ViewBinding; sessionId: string }> = [];
    for (const view of this.views) {
      if (view.follows || !view.displayed) continue;
      const session = this.sessions.get(view.displayed);
      if (!session || session.loading) continue;
      out.push({ binding: view, sessionId: view.displayed });
    }
    return out;
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
    if (info) {
      const caps = info.agentCapabilities;
      view.canBrowseSessions = caps.loadSession === true && !!caps.sessionCapabilities?.list;
    }
    return view;
  }

  private onConnectionChange(change: ConnectionStateChange): void {
    if (change.agent) this.agentInfo = change.agent;
    if (change.status === "stopped" || change.status === "error") {
      // The sessions stay visible (status `error`) until the agent restarts.
      for (const session of this.sessions.values()) {
        this.deps.permissions.cancelAll(session.id);
        if (session.turnActive) this.endTurn(session, "error");
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

  /**
   * Kind of a tool call known to the transcript of `sessionId` (and of that
   * session only — tool call ids repeat across sessions): the
   * `PermissionManager.resolveKind` hook for requests without `kind` (D23).
   */
  toolCallKind(sessionId: string, toolCallId: string): ToolKind | undefined {
    return this.sessions.get(sessionId)?.transcript.toolCalls[toolCallId]?.kind;
  }

  private async createSession(groupId: string): Promise<ChatSession | null> {
    const agent = this.agent;
    if (!agent) return null;
    try {
      const remembered = this.rememberSessionOptionsEnabled() ? this.rememberedSessionOptions() : null;
      const state = await this.newSessionWithHints(agent, remembered);
      const session = new ChatSession(state, ++this.sessionSeq, groupId);
      this.sessions.set(session.id, session);
      this.deps.output.appendLine(`[info] session ${session.id} opened (group ${groupId})`);
      this.scheduleSessions();
      if (remembered) await this.applyRememberedOptions(agent, session, remembered);
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

  // ---------------------------------------------------------------------
  // Remembered session options (D24)
  // ---------------------------------------------------------------------

  /** `kiroAcp.rememberSessionOptions` (default true). */
  private rememberSessionOptionsEnabled(): boolean {
    return vscode.workspace.getConfiguration("kiroAcp").get<boolean>("rememberSessionOptions", true);
  }

  /** The options remembered for new sessions, or null when nothing is remembered. */
  rememberedSessionOptions(): RememberedSessionOptions | null {
    const raw = this.deps.context.workspaceState.get<unknown>(SESSION_OPTIONS_KEY);
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const out: RememberedSessionOptions = { configOptions: {} };
    if (typeof r.modeId === "string" && r.modeId) out.modeId = r.modeId;
    if (typeof r.modelId === "string" && r.modelId) out.modelId = r.modelId;
    if (r.configOptions && typeof r.configOptions === "object") {
      for (const [id, value] of Object.entries(r.configOptions as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "boolean") out.configOptions[id] = value;
      }
    }
    return out.modeId || out.modelId || Object.keys(out.configOptions).length > 0 ? out : null;
  }

  /** Forget the remembered options; the next session starts with the agent's defaults. */
  async forgetSessionOptions(): Promise<void> {
    await this.deps.context.workspaceState.update(SESSION_OPTIONS_KEY, undefined);
    this.deps.output.appendLine("[info] remembered session options forgotten");
  }

  /** Merge a user choice into the remembered options (no-op when the setting is off). */
  private rememberSessionOption(patch: {
    modeId?: string;
    modelId?: string;
    configOption?: { id: string; value: string | boolean };
  }): void {
    if (!this.rememberSessionOptionsEnabled()) return;
    const current = this.rememberedSessionOptions() ?? { configOptions: {} };
    const next: RememberedSessionOptions = { ...current, configOptions: { ...current.configOptions } };
    if (patch.modeId !== undefined) next.modeId = patch.modeId;
    if (patch.modelId !== undefined) next.modelId = patch.modelId;
    if (patch.configOption) next.configOptions[patch.configOption.id] = patch.configOption.value;
    void this.deps.context.workspaceState.update(SESSION_OPTIONS_KEY, next).then(undefined, (error: unknown) => {
      this.deps.output.appendLine(`[warn] could not remember session options: ${errorMessage(error)}`);
    });
  }

  /** One line for `/capabilities`: what the next session gets. */
  private describeRememberedOptions(): string {
    const remembered = this.rememberedSessionOptions();
    const enabled = this.rememberSessionOptionsEnabled();
    if (!remembered) return enabled ? "none" : "none (kiroAcp.rememberSessionOptions is off)";
    const parts: string[] = [];
    if (remembered.modeId) parts.push(`mode \`${remembered.modeId}\``);
    if (remembered.modelId) parts.push(`model \`${remembered.modelId}\``);
    for (const [id, value] of Object.entries(remembered.configOptions)) parts.push(`\`${id}\` = \`${String(value)}\``);
    return parts.join(", ") + (enabled ? "" : " (not applied: kiroAcp.rememberSessionOptions is off)");
  }

  /**
   * `session/new` with `_meta.kiro { modeId, modelId }` hints when remembered
   * (Kiro V3 reads them; other agents ignore `_meta`). Should the agent reject
   * the hinted request, it is retried without hints so a stale id never
   * blocks session creation.
   */
  private async newSessionWithHints(agent: KiroAgent, remembered: RememberedSessionOptions | null): Promise<SessionState> {
    const cwd = this.workspaceRoot();
    const kiro: Record<string, string> = {};
    if (remembered?.modeId) kiro.modeId = remembered.modeId;
    const modelId = remembered?.modelId ?? remembered?.configOptions["model"];
    if (typeof modelId === "string" && modelId) kiro.modelId = modelId;
    if (Object.keys(kiro).length === 0) return agent.newSession(cwd);
    try {
      return await agent.newSession(cwd, { meta: { kiro } });
    } catch (error) {
      this.deps.output.appendLine(
        `[warn] session/new with remembered hints ${safeJson(kiro)} failed (${errorMessage(error)}); retrying without them`,
      );
      return agent.newSession(cwd);
    }
  }

  /**
   * Re-apply the remembered options to a freshly created session, each only
   * when the agent advertises it and its current value differs: config
   * options first (`model`, `effortLevel`, ...), then the mode, then the v2
   * model. Nothing the agent does not advertise is ever sent.
   */
  private async applyRememberedOptions(
    agent: KiroAgent,
    session: ChatSession,
    remembered: RememberedSessionOptions,
  ): Promise<void> {
    const applied: string[] = [];
    const skipped: string[] = [];
    const log = (text: string) => this.deps.output.appendLine(text);
    for (const [id, value] of Object.entries(remembered.configOptions)) {
      const option = (session.state.configOptions ?? []).find((o) => o.id === id);
      if (!option) {
        skipped.push(`${id} (not advertised)`);
        continue;
      }
      const allowed =
        option.type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "string" && flattenValues(option).includes(value);
      if (!allowed) {
        skipped.push(`${id}=${String(value)} (not an advertised value)`);
        continue;
      }
      if (option.currentValue === value) continue;
      try {
        await agent.setConfigOption(session.id, id, value);
        applied.push(`${id}=${String(value)}`);
      } catch (error) {
        log(`[warn] session ${session.id}: could not apply remembered ${id}=${String(value)}: ${errorMessage(error)}`);
      }
    }
    if (remembered.modeId) {
      const modes = session.state.modes;
      if (!modes || !modes.availableModes.some((m) => m.id === remembered.modeId)) {
        skipped.push(`mode ${remembered.modeId} (not advertised)`);
      } else if (modes.currentModeId !== remembered.modeId) {
        try {
          await agent.setMode(session.id, remembered.modeId);
          applied.push(`mode=${remembered.modeId}`);
        } catch (error) {
          log(`[warn] session ${session.id}: could not apply remembered mode ${remembered.modeId}: ${errorMessage(error)}`);
        }
      }
    }
    if (remembered.modelId) {
      const models = session.state.models;
      if (!models || !models.availableModels.some((m) => m.modelId === remembered.modelId)) {
        skipped.push(`model ${remembered.modelId} (not advertised)`);
      } else if (models.currentModelId !== remembered.modelId) {
        try {
          await agent.setModel(session.id, remembered.modelId);
          applied.push(`model=${remembered.modelId}`);
        } catch (error) {
          log(`[warn] session ${session.id}: could not apply remembered model ${remembered.modelId}: ${errorMessage(error)}`);
        }
      }
    }
    if (applied.length > 0 || skipped.length > 0) {
      log(
        `[info] session ${session.id}: remembered options applied: ${applied.join(", ") || "none"}` +
          (skipped.length > 0 ? `; skipped: ${skipped.join(", ")}` : ""),
      );
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

  // ---------------------------------------------------------------------
  // Past sessions (session/list + session/load, see D21)
  // ---------------------------------------------------------------------

  /**
   * The agent's past sessions for this workspace (every past session when
   * none matches the workspace cwd), excluding the sessions live in this
   * process, most recent first. Rejects when the agent is not ready or did
   * not advertise `session/list`.
   */
  async listPastSessions(): Promise<PastSessionEntry[]> {
    await this.ensureStarted();
    const agent = this.agent;
    if (!agent || agent.status !== "ready") throw new Error("The agent is not running.");
    const entries = await this.listPastEntries(agent);
    const now = Date.now();
    return entries
      .filter((e) => !this.sessions.has(e.sessionId))
      .map((e) => ({
        sessionId: e.sessionId,
        label: e.title ?? e.sessionId,
        description: relativeTime(e.updatedAt, now),
        detail: e.cwd,
        title: e.title,
        cwd: e.cwd,
        updatedAt: e.updatedAt,
      }));
  }

  /** `session/list` filtered by the workspace cwd, falling back to the unfiltered list; remembers the titles. */
  private async listPastEntries(agent: KiroAgent): Promise<SessionListEntry[]> {
    let sessions = await this.listAllPages(agent, this.workspaceRoot());
    if (sessions.length === 0) sessions = await this.listAllPages(agent);
    for (const entry of sessions) this.pastTitles.set(entry.sessionId, entry.title);
    return sessions;
  }

  /**
   * Every page of `session/list` (optionally cwd-filtered) concatenated: the
   * agent pages the list through `nextCursor`. Stops at the last page, on a
   * cursor the agent already handed out (a looping agent) or after
   * {@link MAX_LIST_PAGES} pages.
   */
  private async listAllPages(agent: KiroAgent, cwd?: string): Promise<SessionListEntry[]> {
    const sessions: SessionListEntry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const options: { cwd?: string; cursor?: string } = {};
      if (cwd !== undefined) options.cwd = cwd;
      if (cursor !== undefined) options.cursor = cursor;
      const result = await agent.listSessions(options);
      sessions.push(...result.sessions);
      const next = result.nextCursor;
      if (next === null || next.length === 0 || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return sessions;
  }

  /**
   * Let the user pick one of the agent's past sessions and restore it into
   * `view` (or the focused view). Problems are reported as a notice.
   */
  async browsePastSessions(view?: ViewHandle): Promise<void> {
    const binding = asBinding(view) ?? this.focusedView;
    const current = binding?.sessionId ? (this.sessions.get(binding.sessionId) ?? null) : null;
    let entries: PastSessionEntry[];
    try {
      entries = await this.listPastSessions();
    } catch (error) {
      this.notice(current, "warning", `Could not list past sessions: ${errorMessage(error)}`);
      return;
    }
    if (entries.length === 0) {
      this.notice(current, "info", "No past sessions to restore.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({ label: e.label, description: e.description, detail: e.detail, sessionId: e.sessionId })),
      {
        title: "Kiro: past sessions",
        placeHolder: "Select a session to restore",
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!picked) return;
    await this.openPastSession(picked.sessionId, binding ?? undefined);
  }

  /**
   * Restore a past session (`session/load`) into a fresh `ChatSession` of
   * `view`'s group (else the focused view's, else `default`), display and
   * focus it. The replayed history lands in its transcript as it arrives.
   * Returns the session id, or null when the restore failed (the view keeps
   * its previous session and a notice explains).
   */
  async openPastSession(sessionId: string, view?: ViewHandle): Promise<string | null> {
    if (this.sessions.has(sessionId)) {
      this.selectSession(sessionId, view);
      return sessionId;
    }
    await this.ensureStarted();
    const agent = this.agent;
    const binding = asBinding(view) ?? this.focusedView;
    const previous = binding && !binding.follows ? binding.displayed : null;
    const previousSession = previous ? (this.sessions.get(previous) ?? null) : null;
    if (!agent || agent.status !== "ready") {
      this.notice(previousSession, "warning", "Cannot restore a session: the agent is not running.");
      return null;
    }
    const groupId = binding?.groupId ?? this.focusedView?.groupId ?? DEFAULT_GROUP;
    const cwd = this.workspaceRoot();
    const placeholder: SessionState = {
      sessionId,
      cwd,
      modes: null,
      configOptions: null,
      models: null,
      availableCommands: [],
      meta: null,
    };
    const session = new ChatSession(placeholder, ++this.sessionSeq, groupId);
    session.loading = true;
    if (!this.pastTitles.has(sessionId)) {
      try {
        await this.listPastEntries(agent);
      } catch {
        /* the title stays unknown until the agent reports one */
      }
    }
    session.agentTitle = this.pastTitles.get(sessionId) ?? null;
    this.sessions.set(sessionId, session);
    this.deps.output.appendLine(`[info] session ${sessionId} restoring (group ${groupId})`);
    if (binding && !binding.follows) this.setViewSession(binding, sessionId);
    this.focus(sessionId);
    const restoring = this.notice(session, "info", "Restoring session…");
    const wasFocused = () => this.focusedId === sessionId;
    try {
      const state = await agent.loadSession(sessionId, cwd);
      // The client already emitted a `state` event for it; merging again is harmless.
      this.applySessionState(session, state);
    } catch (error) {
      const message = errorMessage(error);
      this.deps.output.appendLine(`[error] session ${sessionId} restore failed: ${message}`);
      this.sessions.delete(sessionId);
      this.deps.permissions.cancelAll(sessionId);
      this.deps.permissions.clearPolicies(sessionId);
      // The view goes back to what it showed before; focus follows.
      for (const v of this.views) {
        if (!v.follows && v.displayed === sessionId) this.setViewSession(v, previous);
      }
      if (wasFocused()) {
        this.focusedId = null;
        const fallback = previous ?? this.sortedSessions()[0]?.id ?? null;
        if (fallback) this.focus(fallback);
        else this.clearFocus();
      }
      this.scheduleSessions();
      const target = this.focusedId ? (this.sessions.get(this.focusedId) ?? null) : null;
      this.notice(target, "warning", `Could not restore session ${sessionId}: ${message}`);
      return null;
    }
    session.loading = false;
    session.touch();
    this.clearNotice(session, restoring.id);
    for (const v of this.views) {
      if (v.sessionId === sessionId) this.postSessionState(v, sessionId);
    }
    this.scheduleSessions();
    this.deps.output.appendLine(`[info] session ${sessionId} restored (${session.transcript.items.length} items)`);
    return sessionId;
  }

  /** Merge a `SessionState` (session/new, session/load, state events) into `session` and tell its views. */
  private applySessionState(session: ChatSession, state: SessionState): void {
    session.state = state;
    session.transcript = withSessionSnapshot(session.transcript, {
      modes: state.modes,
      configOptions: state.configOptions,
      availableCommands: state.availableCommands,
    });
    session.models = toModelView(state.models);
    this.postTo(session.id, { type: "modes", modes: session.transcript.modes });
    this.postTo(session.id, { type: "configOptions", options: session.transcript.configOptions });
    this.postTo(session.id, { type: "models", models: session.models });
    this.postTo(session.id, { type: "commands", commands: this.commandsView(session) });
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
    if (session.loading) {
      // The client still flags the session's updates as replay until `session/load`
      // resolves (D21), so a prompt now would render its live answer as history.
      // Slash commands (`/clear` replacing the view's session, …) wait as well.
      this.notice(session, "info", "Wait for the session to finish restoring.");
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && chips.length === 0) return;

    // Slash commands run at once, turn or no turn: `/cancel` must stop the
    // running turn and `/clear` must be able to leave it (D22).
    const parsed = parseSlash(trimmed);
    if (parsed && (await this.runSlash(session, parsed, chips, binding))) return;

    const embeddedContext = this.agentInfo?.agentCapabilities.promptCapabilities?.embeddedContext === true;
    const blocks = await buildPromptBlocks(trimmed, chips, readWorkspaceText, { embeddedContext });

    if (session.turnActive) {
      // Plain text while the agent works: steer the turn, or hold the message
      // until the turn ends when the agent cannot steer (D22).
      await this.promptDuringTurn(agent, session, trimmed, chips, blocks);
      return;
    }

    if (session.firstPrompt === null && trimmed) {
      session.firstPrompt = truncateTitle(trimmed);
    }
    this.echoUserMessage(session, trimmed, chips);
    this.deps.contextTracker.clearExplicit();
    await this.runTurn(agent, session, blocks);
  }

  /**
   * `session/prompt` for `session`, already echoed: flips the turn state and
   * reports the stop reason (or the failure) when the agent answers.
   */
  private async runTurn(agent: KiroAgent, session: ChatSession, blocks: acp.ContentBlock[]): Promise<void> {
    session.turnGeneration++;
    this.setTurnActive(session, true);
    try {
      const response = await agent.prompt(session.id, blocks);
      this.handleStopReason(session, response.stopReason);
    } catch (error) {
      const message = errorMessage(error);
      if (agent.status === "auth_required") {
        // The sign-in banner (with the login button) already shows the reason.
        this.deps.output.appendLine(`[warn] session ${session.id} prompt rejected, sign-in required: ${message}`);
      } else {
        this.notice(session, "error", `Prompt failed: ${message}`);
      }
      this.endTurn(session, "error");
    }
  }

  /**
   * Show the user's message locally (echoed `user_message_chunk`s are ignored,
   * see DECISIONS D13), optionally badged with its delivery state. Returns the
   * message's view id (the id `chunk` / `messageDelivery` posts carry).
   */
  private echoUserMessage(session: ChatSession, text: string, chips: ContextChip[], delivery?: MessageDelivery): string {
    const messageId = `user-${++session.userMessageSeq}`;
    const emitted = this.applyLocalUpdate(session, {
      sessionUpdate: "user_message_chunk",
      messageId,
      content: { type: "text", text },
    });
    const chunk = emitted.find((e): e is Extract<ToWebview, { type: "chunk" }> => e.type === "chunk");
    const viewId = chunk?.messageId ?? session.transcript.openMessage?.id ?? messageId;
    for (const chip of chips) {
      this.applyLocalUpdate(session, {
        sessionUpdate: "user_message_chunk",
        messageId,
        content: { type: "resource_link", uri: vscode.Uri.file(chip.path).toString(), name: chipLabel(chip) },
      });
    }
    if (delivery) this.setDelivery(session, viewId, delivery);
    return viewId;
  }

  /** Update the delivery badge of a user message in the transcript and in the views (D22). */
  private setDelivery(session: ChatSession, messageId: string, delivery: MessageDelivery | null): void {
    session.transcript = setMessageDelivery(session.transcript, messageId, delivery);
    this.postTo(session.id, { type: "messageDelivery", messageId, delivery });
  }

  /**
   * A plain prompt typed while a turn runs (D22): echo it as `steering` and
   * send it through `_session/steer`; when the agent refuses (method unknown,
   * no turn, …) the message becomes `queued` and goes out as a normal prompt
   * once the turn ends. A session whose steer failed once queues directly.
   * A refusal that lands after the steered turn ended (Stop, `/cancel`,
   * `/clear`, an error, or a normal end) is not queued: queueing then would
   * start a turn the user already stopped, so the message is dropped with a
   * notice instead.
   */
  private async promptDuringTurn(
    agent: KiroAgent,
    session: ChatSession,
    text: string,
    chips: ContextChip[],
    blocks: acp.ContentBlock[],
  ): Promise<void> {
    if (session.steerUnsupported) {
      const messageId = this.echoUserMessage(session, text, chips, "queued");
      this.deps.contextTracker.clearExplicit();
      this.enqueue(session, { text, chips, blocks, messageId });
      return;
    }
    const messageId = this.echoUserMessage(session, text, chips, "steering");
    this.deps.contextTracker.clearExplicit();
    session.steering.add(messageId);
    const generation = session.turnGeneration;
    const params = { sessionId: session.id, prompt: blocks };
    this.deps.output.appendLine(`[info] steer ${session.id}: ${STEER_METHOD} ${safeJson(params)}`);
    try {
      const result = await agent.callExtension(STEER_METHOD, params);
      this.deps.output.appendLine(`[info] steer ${session.id}: accepted ${safeJson(result)}`);
    } catch (error) {
      const code = error instanceof AcpError && error.code !== undefined ? ` (${error.code})` : "";
      this.deps.output.appendLine(
        `[info] steer ${session.id}: failed${code}: ${errorMessage(error)}; queueing mid-turn prompts instead`,
      );
      session.steering.delete(messageId);
      if (!this.sessions.has(session.id)) return;
      if (session.turnGeneration !== generation || !session.turnActive) {
        // The steered turn is over (cancelled, cleared, failed or ended): the
        // refusal says nothing about steering support, and queueing now would
        // start a new turn the user did not ask for.
        this.deps.output.appendLine(`[info] steer ${session.id}: the turn ended before the refusal; message dropped`);
        this.setDelivery(session, messageId, null);
        this.notice(session, "info", "Message not sent: the turn ended before it was delivered.");
        return;
      }
      session.steerUnsupported = true;
      this.setDelivery(session, messageId, "queued");
      this.enqueue(session, { text, chips, blocks, messageId });
    }
  }

  /** Hold `item` until the turn ends; sent right away when the turn ended meanwhile. */
  private enqueue(session: ChatSession, item: QueuedPrompt): void {
    session.queue.push(item);
    if (!session.turnActive) this.drainQueue(session);
  }

  /** Send the next queued prompt of an idle session as a turn of its own. */
  private drainQueue(session: ChatSession): void {
    if (session.turnActive) return;
    const next = session.queue.shift();
    if (!next) return;
    this.setDelivery(session, next.messageId, null);
    const agent = this.agent;
    if (!agent || agent.status !== "ready" || !this.sessions.has(session.id)) {
      this.discardQueue(session, 1 + this.discardRemaining(session));
      return;
    }
    // The echo happened mid-turn, so the previous answer may still be open:
    // close it so the new turn's answer starts a message of its own.
    session.transcript = { ...session.transcript, openMessage: null };
    void this.runTurn(agent, session, next.blocks);
  }

  /** Clear the badges of every queued prompt and forget them. Returns how many were dropped. */
  private discardRemaining(session: ChatSession): number {
    const dropped = session.queue.splice(0);
    for (const item of dropped) this.setDelivery(session, item.messageId, null);
    return dropped.length;
  }

  private discardQueue(session: ChatSession, count: number): void {
    if (count <= 0) return;
    this.notice(session, "info", `${count} queued message${count === 1 ? "" : "s"} discarded.`);
  }

  /** Clear the `steering` badges: the agent injected (or dropped) the steered prompts, or the turn is over. */
  private clearSteering(session: ChatSession): void {
    for (const messageId of session.steering) this.setDelivery(session, messageId, null);
    session.steering.clear();
  }

  /**
   * The turn of `session` is over (`session/prompt` answered, failed, or the
   * agent went away): badges go, and the queue is dropped after a cancel or
   * an error, else its first prompt starts the next turn (D22).
   */
  private endTurn(session: ChatSession, stopReason: acp.StopReason | "error"): void {
    session.turnGeneration++;
    this.setTurnActive(session, false, stopReason);
    this.clearSteering(session);
    if (stopReason === "cancelled" || stopReason === "error") {
      this.discardQueue(session, this.discardRemaining(session));
    }
  }

  private handleStopReason(session: ChatSession, stopReason: acp.StopReason): void {
    this.endTurn(session, stopReason);
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
    this.drainQueue(session);
  }

  /** Test hook: pretend `_session/steer` already failed for `sessionId`, so mid-turn prompts queue (D22). */
  setSteerUnsupportedForTests(sessionId: string, unsupported: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) session.steerUnsupported = unsupported;
  }

  /** Apply a locally generated update and forward its emits; returns them. */
  private applyLocalUpdate(session: ChatSession, update: acp.SessionUpdate): ToWebview[] {
    const result = applyUpdate(session.transcript, update);
    session.transcript = result.state;
    session.touch();
    for (const emit of result.emits) this.postTo(session.id, emit);
    this.scheduleSessions();
    return result.emits;
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
        const replay = event.replay === true;
        if (update.sessionUpdate === "user_message_chunk") {
          // Live user chunks are echoed locally by prompt() (D13); replayed history must be rendered (D21).
          if (!replay) return;
          const content = update.content;
          if (session.firstPrompt === null && content.type === "text" && content.text.trim()) {
            session.firstPrompt = truncateTitle(content.text);
          }
        }
        if (update.sessionUpdate === "session_info_update") {
          if (typeof update.title === "string") session.agentTitle = update.title.trim() || null;
          else if (update.title === null) session.agentTitle = null;
          const kind = kiroKind(update._meta);
          if (kind === "steering_injected" || kind === "steering_cleared") {
            this.deps.output.appendLine(`[info] steer ${session.id}: ${kind}`);
            this.clearSteering(session);
          }
          return;
        }
        const result = applyUpdate(session.transcript, update);
        session.transcript = result.state;
        for (const emit of result.emits) {
          this.postTo(
            session.id,
            emit.type === "commands" ? { type: "commands", commands: this.commandsView(session) } : emit,
          );
          // Replayed tool calls are history: no diff editors to open or reconcile,
          // and no terminal output resolved against live terminals.
          if (emit.type === "toolCall") {
            if (replay) session.replayedToolCalls.add(emit.call.toolCallId);
            else void this.onToolCallChanged(session, emit.call);
          }
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
        this.applySessionState(session, event.session);
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
      case "browseSessions":
        await this.browsePastSessions(binding);
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
        try {
          this.deps.permissions.setPolicy(message.requestId, message.decision, message.scope ?? "kind");
        } catch (error) {
          this.notice(session ?? null, "warning", errorMessage(error));
        }
        return;
      case "setMode":
        await this.withSession(session, async (agent, id) => {
          await agent.setMode(id, message.modeId);
          this.rememberSessionOption({ modeId: message.modeId });
        });
        return;
      case "setConfigOption":
        await this.withSession(session, async (agent, id) => {
          await agent.setConfigOption(id, message.configId, message.value);
          this.rememberSessionOption({ configOption: { id: message.configId, value: message.value } });
        });
        return;
      case "setModel":
        await this.withSession(session, async (agent, id) => {
          await agent.setModel(id, message.modelId);
          this.rememberSessionOption({ modelId: message.modelId });
        });
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
        if (!session || !this.deps.terminal.showTerminal(message.terminalId, session.id)) {
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

  /**
   * Sign in with `methodId` (default: the first method the agent offers, else
   * the terminal fallback that runs `kiro-cli login`), then reconnect and
   * restore the sessions the chat views were showing (D25).
   */
  async login(methodId?: string): Promise<void> {
    await this.ensureStarted();
    const agent = this.agent;
    if (!agent) return;
    const id = methodId ?? this.agentInfo?.authMethods[0]?.id ?? FALLBACK_LOGIN_METHOD.id;
    try {
      await agent.authenticate(id);
      await this.restart({ restoreSessions: true });
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
        // focused view, else any view) when it displays this session. Typed
        // mid-turn it also stops the turn it leaves behind (D22).
        const displays = (v: ViewBinding | null | undefined): ViewBinding | undefined =>
          v && !v.follows && v.displayed === sessionId ? v : undefined;
        const view =
          displays(sender) ?? displays(this.focusedView) ?? [...this.views].find((v) => displays(v) !== undefined);
        if (session.turnActive) await this.cancel(sessionId);
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
      case "login":
        await this.login();
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
          this.rememberSessionOption({ modeId: action.modeId });
          this.localExchange(session, raw, `Mode set to \`${action.modeId}\`.`);
        } catch (error) {
          this.localExchange(session, raw, `Could not set the mode: ${errorMessage(error)}`);
        }
        return true;
      case "set_config":
        if (!agent) return true;
        try {
          await agent.setConfigOption(sessionId, action.configId, action.value);
          this.rememberSessionOption({ configOption: { id: action.configId, value: action.value } });
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
    lines.push("", `Remembered for new sessions: ${this.describeRememberedOptions()}`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------
  // Notices
  // ---------------------------------------------------------------------

  /** A notice for one session (its views) or, with `null`, for every view. Returns it (for {@link clearNotice}). */
  private notice(session: ChatSession | null, severity: NoticeView["severity"], text: string): NoticeView {
    const notice: NoticeView = { id: `n-${++this.noticeSeq}`, severity, text };
    if (session) {
      session.notices = [...session.notices.slice(-9), notice];
      this.postTo(session.id, { type: "notice", notice });
    } else {
      this.globalNotices = [...this.globalNotices.slice(-9), notice];
      this.postAll({ type: "notice", notice });
    }
    if (severity === "error") this.deps.output.appendLine(`[error] ${text}`);
    return notice;
  }

  /** Withdraw a session notice (a progress message that is over). */
  private clearNotice(session: ChatSession, id: string): void {
    if (!session.notices.some((n) => n.id === id)) return;
    session.notices = session.notices.filter((n) => n.id !== id);
    this.postTo(session.id, { type: "clearNotice", id });
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

/** Every selectable value of a select config option (groups flattened). */
function flattenValues(option: acp.SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  const out: string[] = [];
  for (const entry of option.options ?? []) {
    const group = entry as { options?: Array<{ value: string }> };
    if (Array.isArray(group.options)) {
      for (const o of group.options) if (typeof o.value === "string") out.push(o.value);
    } else if (typeof (entry as { value?: unknown }).value === "string") {
      out.push((entry as { value: string }).value);
    }
  }
  return out;
}

function toAuthMethodView(method: acp.AuthMethod): AuthMethodView {
  const terminal = "type" in method && method.type === "terminal";
  return { id: method.id, name: method.name, description: method.description ?? null, terminal };
}

function chipLabel(chip: ContextChip): string {
  return chip.kind === "selection" && chip.startLine !== undefined
    ? `${chip.label}:${chip.startLine}-${chip.endLine ?? chip.startLine}`
    : chip.label;
}

/** "just now", "5m ago", "2h ago", "3d ago", or the date for older sessions; empty when unknown. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
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

/** `_meta.kiro.kind` of a Kiro V3 update, when present. */
function kiroKind(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const kiro = (meta as Record<string, unknown>).kiro;
  if (typeof kiro !== "object" || kiro === null) return undefined;
  const kind = (kiro as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
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
