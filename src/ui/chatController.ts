/**
 * Orchestrates the chat: agent lifecycle, every live session (transcript,
 * permissions, diffs, plan, notices) and the views that display them.
 *
 * One `KiroAgent` (an `AgentPool`: one `kiro-cli` process per session, D31)
 * hosts many sessions. Each attached view (sidebar,
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
import { EMPTY_USAGE, applyContextResult, applyUsageUpdate } from "../features/pure/usage.js";
import type { SessionUsage } from "./protocol.js";
import * as path from "node:path";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";

import {
  AcpError,
  createAgentPool,
  FALLBACK_LOGIN_METHOD,
  resolveCliPath,
  type AgentInfo,
  type AgentPool,
  type ClientServices,
  type ConnectionStateChange,
  type KiroAgent,
  type PoolProcessInfo,
  type ProtocolLogger,
  type SessionEvent,
  type SessionListEntry,
  type SessionState,
} from "../acp/index.js";
import {
  applyUpdate,
  createTranscript,
  setMessageDelivery,
  setMessageOrigin,
  snapshotToUiState,
  toModelView,
  withSessionSnapshot,
  type TranscriptState,
} from "../features/pure/transcript.js";
import { lastAgentAnswer, transcriptText } from "../features/pure/transcriptText.js";
import { buildPromptBlocks } from "../features/pure/contentBlocks.js";
import {
  checkImageAttachment,
  echoImageContent,
  imageAttachmentFromBytes,
  type ImageRead,
} from "../features/pure/images.js";
import {
  IMAGE_TYPE_BY_EXTENSION,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PROMPT,
  base64Size,
  formatBytes,
  imageRejection,
  imageTypeForName,
} from "./images.js";
import {
  describeOptions,
  findExtension,
  formatExtensionResult,
  mergeCommands,
  parseSlash,
  routeSlash,
  type ParsedSlash,
  type SlashAction,
  type SlashContext,
} from "../features/pure/slashCommands.js";
import { AgentLinkServer } from "../agentLink/server.js";
import { AGENT_LINK_INSTRUCTIONS, createAgentLinkTools } from "../agentLink/tools.js";
import { fitsPeerMessage, framePeerMessage } from "../agentLink/peerMessage.js";
import { RateLimiter } from "../agentLink/rateLimiter.js";
import { matchAgentLinkPermission } from "../agentLink/permissionMatch.js";
import {
  AGENT_LINK_SERVER_NAME,
  AgentLinkError,
  DEFAULT_MAX_CHAIN,
  LAST_ANSWER_MAX_CHARS,
  PEER_MESSAGE_MAX_BYTES,
  PEER_RATE_LIMIT,
  READ_SESSION_DEFAULT_ITEMS,
  READ_SESSION_MAX_CHARS,
  READ_SESSION_MAX_ITEMS,
} from "../agentLink/types.js";
import type {
  AgentLinkGrant,
  AgentLinkHost,
  AgentLinkServerApi,
  LinkedSessionInfo,
  LinkedSessionStatus,
  PeerDelivery,
  SendMessageResult,
  SessionReadResult,
  StartSessionResult,
  StartWhere,
  WaitOutcome,
  WaitResult,
} from "../agentLink/types.js";
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
  ImageAttachment,
  MessageDelivery,
  MessageOrigin,
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

/** How the host opens a chat tab for a session ({@link ChatController.openTab}). */
export interface OpenTabOptions {
  /**
   * Do not take the user away from what they are looking at: the tab opens
   * without focus, and the chat tab of `besideGroup` stays in front when it
   * was visible (an agent started the session, not the user; D30).
   */
  preserveFocus?: boolean;
  /** Open the tab in the editor column of this group's chat tab (else the active column). */
  besideGroup?: string;
}

/** `kiroAcp.agentLink.confirm`: when a peer message / new session needs the user's OK (D30). */
export type AgentLinkConfirmMode = "firstPerPair" | "always" | "never";

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
/** Stop: how long the agent gets to end the turn after `session/cancel` before it is ended locally (D27). */
const CANCEL_GRACE_MS = 5_000;
/** One notice per distinct kiro-cli stderr error per this interval. */
const STDERR_NOTICE_INTERVAL_MS = 60_000;
/** `kiroAcp.agentProcesses.max`: default and bounds (package.json, D31). */
const DEFAULT_MAX_PROCESSES = 8;
const MAX_PROCESSES_LIMIT = 32;
/**
 * Sessions a sign-in restore loads at the same time (D25, D31): each load
 * starts a process of its own, so a few at once bring a full window back
 * faster without spawning every process in the same instant.
 */
const RESTORE_CONCURRENCY = 4;
/**
 * A turn that failed this shortly before its process's exit was reported
 * failed by that exit (the connection closed first): the exit notice
 * replaces its "Prompt failed" (D31).
 */
const EXIT_FAILURE_WINDOW_MS = 5_000;

/** A prompt typed mid-turn and held until the turn ends (steering unavailable, see D22). */
interface QueuedPrompt {
  text: string;
  chips: ContextChip[];
  /** Built when queued, so the dequeue starts the turn without awaiting anything. */
  blocks: acp.ContentBlock[];
  /** View id of the echoed user message (its `queued` badge). */
  messageId: string;
  /**
   * Chain depth of the turn this prompt starts (D30): 0 for what the user
   * typed, the sender's turn depth + 1 for a peer message.
   */
  depth: number;
  /** Set on a peer message (agent link, D30): the sending session. Pausing agent messages drops these. */
  fromSessionId?: string;
}

/**
 * A live session that a sign-in restart loads back (`session/load`) into the
 * new agent process: into its group, shown again by the views that showed it,
 * at its old place in the session list (D25).
 */
interface RestoreEntry {
  sessionId: string;
  /** Its agent-link handle (`s3`): the agents keep addressing it by the same name (D30). */
  handle: string;
  groupId: string;
  agentTitle: string | null;
  /** Its title before the restart, for a failure notice. */
  title: string;
  /** Kept across the restore, so the session list keeps its order. */
  updatedAt: number;
  /** The views that displayed it. */
  views: ViewBinding[];
  /** It was the focused session. */
  focused: boolean;
}

const TURN_ACTIVE_KEY = "kiroAcp.turnActive";
/** Upper bound on `session/list` pages followed per listing (guards against an agent that never ends its list). */
const MAX_LIST_PAGES = 50;
const TITLE_MAX = 40;
const SESSIONS_DEBOUNCE_MS = 50;
/** Context key of `Kiro: Pause / Resume Agent Messages` (D30). */
const AGENT_MESSAGES_PAUSED_KEY = "kiroAcp.agentMessagesPaused";
/** `kiroAcp.agentLink.maxChain` bounds (package.json). */
const MAX_CHAIN_LIMIT = 50;
/** Option ids of the agent-link confirmation card (D30). */
const CONFIRM_ALLOW = "send";
const CONFIRM_REJECT = "dont-send";
/**
 * Consent capabilities of that card (`_meta.kiro.consent`, D23): they label
 * it, nothing more. The card is a `local` request, so no session policy
 * answers it or is offered on it (a "kind other" rule for Kiro's own tool
 * calls must never send a message, nor a click on the card approve Kiro's
 * calls); `firstPerPair` is its only memory (D30).
 */
const CONFIRM_CAPABILITY = "agent_link_message";
const CONFIRM_START_CAPABILITY = "agent_link_start_session";
/** How much of a peer message / start prompt the confirmation card quotes. */
const CONFIRM_SNIPPET_MAX = 80;
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
   * The session is being closed or replaced (`/clear`, closeSession): its
   * queue was discarded and nothing may start another turn on it, not even a
   * late `_session/steer` refusal (revmux round 14).
   */
  closing = false;
  /**
   * While `/clear` replaces the session: resolves with the replacement's id
   * once it displays (null when the replacement failed). A prompt typed in
   * that window waits for it and goes to the new session (revmux round 15).
   */
  replacement: Promise<string | null> | null = null;
  /**
   * Bumped whenever a turn starts or ends (D22): a steer rejection that
   * arrives after its turn ended compares this to the value it captured and
   * drops the message instead of queueing it into a new turn.
   */
  turnGeneration = 0;
  /** Context / token usage reported by the agent so far (D26). */
  usage: SessionUsage = EMPTY_USAGE;
  /** `_meta.kiro.kind`s of `session_info_update` already logged for this session (one example each). */
  readonly loggedInfoKinds = new Set<string>();
  /** The first `_kiro/session/context` reply is logged once, to record its real shape. */
  contextReplyLogged = false;
  /**
   * Chain depth of the current (or last) turn (D30): 0 when the user started
   * it, the sender's depth + 1 when a peer message did, and 0 again once the
   * user steers text into it. A peer message from a turn already at
   * `kiroAcp.agentLink.maxChain` is refused.
   */
  turnDepth = 0;
  /** `turnGeneration` of the turn whose chain-limit refusal the chats were told about (once per turn, D30). */
  chainStopNoted = -1;
  /** Agent-link handle (`s3`, D30): `s<seq>` at creation, kept by a sign-in restore. */
  readonly handle: string;
  /** Armed by Stop: ends the turn locally when the agent never answers `session/cancel` (D27). */
  cancelTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The Stop watchdog ended a turn whose `session/prompt` has not settled
   * yet (D27): until it does, streamed updates that arrive while no turn
   * runs belong to that abandoned turn and are dropped.
   */
  abandonedTurn = false;
  /** The drop above is logged once per session. */
  abandonedDropLogged = false;
  /**
   * The kiro-cli process hosting this session exited (D31): its exit
   * message, until a process hosts the session again. The next turn (or
   * option change) first loads it into a new process ({@link ChatController.reloadSession}).
   */
  processLost: string | null = null;
  /** That `session/load` while in flight; its replayed history is dropped (the transcript has it). */
  reload: Promise<string | null> | null = null;
  /**
   * The "Prompt failed" notice of the last turn and the `turnGeneration` its
   * end left: a process exit that arrives after the failure it caused
   * replaces the notice instead of adding a second one (D31).
   */
  lastFailure: { noticeId: string; generation: number; at: number } | null = null;
  updatedAt = Date.now();

  constructor(
    public state: SessionState,
    /** Creation order, breaks `updatedAt` ties. */
    readonly seq: number,
    /** The tab / sidebar group the session belongs to (see D20). */
    public groupId: string,
    /** The handle of the session this one restores after a sign-in (D25, D30); default `s<seq>`. */
    handle?: string,
  ) {
    this.handle = handle ?? `s${seq}`;
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

/** A pending `wait_for_session` (D30). */
interface LinkWaiter {
  /** Settle the wait when its target reached an outcome (idle, needs input, gone). */
  check(): void;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class ChatController implements vscode.Disposable, AgentLinkHost {
  /** One `kiro-cli` process per session behind the `KiroAgent` facade (D31). */
  private agent: AgentPool | null = null;
  private agentInfo: AgentInfo | null = null;
  /** `_kiro/session/context` rejected the after-turn poll (D26): not asked again until a restart. */
  private contextPollUnsupported = false;
  /** Last time a given kiro-cli stderr error was turned into a notice (throttling). */
  private readonly stderrNoticedAt = new Map<string, number>();
  private connection: ConnectionView = { status: "stopped" };
  private readonly sessions = new Map<string, ChatSession>();
  private focusedId: string | null = null;
  /** The view most recently used by the user; `newSession()`/`selectSession()` without a view act on it. */
  private focusedView: ViewBinding | null = null;
  private sessionSeq = 0;
  private noticeSeq = 0;
  /** Mints the ids of images the host reads for `pickImages` / `dropFiles` (`host-img-N`). */
  private imageSeq = 0;
  /** Notices not tied to a session (agent start failures); shown in every view. */
  private globalNotices: NoticeView[] = [];
  private readonly views = new Set<ViewBinding>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly unsubscribers: Array<() => void> = [];
  private starting: Promise<void> | null = null;
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Titles seen in the last `session/list`, so a restore started by id can name the session (D21). */
  private readonly pastTitles = new Map<string, string | null>();
  /** Groups whose tab was closed: a sign-in restart restores nothing into them (D20, D25). */
  private readonly closedGroups = new Set<string>();
  /** The agent-link MCP server (D30), started for the first session that gets it. */
  private agentLink: AgentLinkServerApi | null = null;
  private agentLinkStarting: Promise<AgentLinkServerApi | null> | null = null;
  /**
   * The agent failed `session/new` with the agent-link server and succeeded
   * without it: the server is not offered again until the agent restarts.
   */
  private agentLinkRefused = false;
  /** Agent-link grants (bearer tokens) by session id. */
  private readonly linkGrants = new Map<string, AgentLinkGrant>();
  /** `send_message` + `start_session` per sending session (D30). */
  private readonly peerRate = new RateLimiter(PEER_RATE_LIMIT.messages, PEER_RATE_LIMIT.windowMs);
  /**
   * `kiroAcp.agentLink.confirm: firstPerPair`: the targets each sender may
   * message without asking again (the user allowed it once), until either
   * session goes away.
   */
  private readonly peerConsents = new Map<string, Set<string>>();
  /** `Kiro: Pause Agent Messages` (not persisted): send / start refuse with `paused`. */
  private peerMessagesPaused = false;
  /** Pending `wait_for_session` calls, checked whenever a session's turn, queue or permissions change. */
  private readonly linkWaiters = new Set<LinkWaiter>();
  private linkWaitersCheckQueued = false;
  /** Mints the tool call ids of the agent-link confirmation cards. */
  private linkConfirmSeq = 0;
  /** Mints the placeholder groups `start_session { where: "newTab" }` creates its session in. */
  private linkStartSeq = 0;

  /** Human name of a session group for the agent link (`tab-3` → "Kiro Chat 3"); set by the host. */
  groupLabel: ((groupId: string) => string | null) | null = null;

  /**
   * Open a new chat tab displaying `sessionId` (the session moves into the
   * tab's group): `start_session { where: "newTab" }` and revealing a session
   * whose group has no open view (D30). Set by the host.
   */
  openTab: ((sessionId: string, options?: OpenTabOptions) => void) | null = null;

  /** Bring the chat tab / sidebar of `view` to the front; false when the host does not know it. Set by the host. */
  revealView: ((view: ViewHandle) => boolean) | null = null;

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
      // Turning the agent link off takes it away from the live sessions too
      // (their tokens stop working); turning it on applies to new sessions.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("kiroAcp.agentLink.enabled") && !this.agentLinkSetting()) {
          void this.stopAgentLink("kiroAcp.agentLink.enabled was turned off");
        }
      }),
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
      usage: session && session.usage !== EMPTY_USAGE ? session.usage : null,
      lastActivityAt: session ? session.updatedAt : null,
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

  /**
   * An idle, empty session of `groupId` that no view displays (the
   * auto-created first session, typically). Not one whose process exited
   * (D31): an empty session may never have been saved, so it might not load
   * again, and a fresh one costs the same.
   */
  private spareSession(groupId: string): ChatSession | undefined {
    const displayed = new Set<string>();
    for (const view of this.views) {
      if (!view.follows && view.displayed) displayed.add(view.displayed);
    }
    return this.sortedSessions().find(
      (s) =>
        s.groupId === groupId &&
        !displayed.has(s.id) &&
        !s.turnActive &&
        s.transcript.items.length === 0 &&
        !this.unhosted(s),
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
        handle: s.handle,
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
        if (direction === "stderr") this.noteAgentStderr(payload);
      },
    };
  }

  /**
   * kiro-cli logs its backend failures only to stderr (`[ERROR] [KRS] HTTP 407
   * …`), while the turn may stay open: the error is shown in every session
   * whose turn is running, so the user knows why nothing arrives (D27).
   */
  private noteAgentStderr(line: string): void {
    const m = /\[ERROR\]\s*(?:\[[^\]]*\]\s*)?(.*)/.exec(line);
    if (!m) return;
    let detail = m[1]!.trim();
    const http = /HTTP\s+(\d{3})(?:.*?<TITLE>([^<]*)<\/TITLE>)?/i.exec(detail);
    if (http) detail = `HTTP ${http[1]}${http[2] ? ` (${http[2]!.trim()})` : ""}`;
    else detail = detail.replace(/\s*body=.*$/s, "").slice(0, 160);
    if (!detail) return;
    const now = Date.now();
    const last = this.stderrNoticedAt.get(detail);
    if (last !== undefined && now - last < STDERR_NOTICE_INTERVAL_MS) return;
    this.stderrNoticedAt.set(detail, now);
    for (const session of this.sessions.values()) {
      if (!session.turnActive) continue;
      this.notice(
        session,
        "warning",
        `kiro-cli reported ${detail} while talking to its backend. If the turn does not finish, press Esc and send the message again.`,
      );
    }
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
    return this.startOnce(true);
  }

  /**
   * {@link ensureStarted}. With `openSessions: false` the new process opens
   * no first session and gives the views none: a sign-in restart hands them
   * their own sessions back instead. A start already in flight is joined as is.
   */
  private startOnce(openSessions: boolean): Promise<void> {
    if (this.starting) return this.starting;
    if (this.agent && this.agent.status !== "stopped" && this.agent.status !== "error") return Promise.resolve();
    this.starting = this.startAgent(openSessions).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** A first session when none exists, and a session for every view still without one. */
  private async openFirstSessions(): Promise<void> {
    if (this.sessions.size === 0) {
      const first = await this.createSession(this.focusedView?.groupId ?? DEFAULT_GROUP);
      if (first) this.focus(first.id);
    }
    await this.assignPendingViews();
  }

  private async startAgent(openSessions: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("kiroAcp");
    const configured = config.get<string>("cliPath", "kiro-cli");
    const extraArgs = config.get<string[]>("cliArgs", []);
    const logger = this.logger();
    const command = await resolveCliPath(configured);
    const args = ["acp", ...extraArgs];
    const maxProcesses = this.agentProcessesMax();
    logger.info(
      `spawning: ${command} ${args.join(" ")} (cwd ${this.workspaceRoot()}; one process per session, at most ${maxProcesses})`,
    );

    const version = (this.deps.context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
    // One process per session (D31): a kiro-cli process runs one turn at a
    // time, so sessions sharing one wait for each other. Read at every start
    // (`Kiro: Restart` applies a changed limit).
    const agent = createAgentPool(
      { command, args, cwd: this.workspaceRoot(), env: process.env, logger, clientVersion: version },
      this.deps.services,
      { maxProcesses },
    );
    // Sessions belong to the processes; a new pool starts without any, and
    // the old capabilities / auth methods must not leak into its `starting` view.
    this.endAllSessions();
    await this.teardownAgent();
    this.agentInfo = null;
    this.agentLinkRefused = false;
    this.agent = agent;
    this.unsubscribers.push(
      agent.onConnectionChange((change) => this.onConnectionChange(change)),
      agent.onSessionEvent((event) => this.onSessionEvent(event)),
    );
    this.setConnection({ status: "starting", message: `Starting ${path.basename(command)}…` });
    try {
      this.agentInfo = await agent.start();
      this.setConnection(this.connectionFromAgent("ready"));
      if (openSessions) await this.openFirstSessions();
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

  /** `kiroAcp.agentProcesses.max`: 1–32, default {@link DEFAULT_MAX_PROCESSES} (D31). */
  private agentProcessesMax(): number {
    const value = vscode.workspace
      .getConfiguration("kiroAcp")
      .get<unknown>("agentProcesses.max", DEFAULT_MAX_PROCESSES);
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_PROCESSES;
    return Math.min(MAX_PROCESSES_LIMIT, Math.max(1, Math.floor(value)));
  }

  /**
   * The running agent's kiro-cli processes (D31), spawn order: one per
   * session (more sessions share one past the limit) plus the idle spare.
   * Empty while no agent runs. Read-only; for `/capabilities` and the tests.
   */
  agentProcesses(): PoolProcessInfo[] {
    return this.agent?.processes() ?? [];
  }

  /** The process limit of the running agent (`kiroAcp.agentProcesses.max` when it started); null while none runs. */
  agentProcessLimit(): number | null {
    return this.agent?.maxProcesses ?? null;
  }

  /**
   * Spawn a fresh agent process. With `restoreSessions` (a sign-in) every
   * session with a conversation is loaded back (`session/load`) once the new
   * process is ready: into its group, shown again by the views that showed
   * it, so a sign-in loses neither a tab's open conversation nor the others in
   * its session list (D25). Views left without a session get a fresh one.
   */
  async restart(options: { restoreSessions?: boolean } = {}): Promise<void> {
    const plan = options.restoreSessions ? this.restorePlan() : [];
    this.endAllSessions();
    await this.teardownAgent();
    this.contextPollUnsupported = false;
    this.setConnection({ status: "stopped" });
    // With sessions to bring back, the new process opens no session of its
    // own first: it would linger as an empty "New session" in the focused tab.
    await this.startOnce(plan.length === 0);
    const agent = this.agent;
    if (plan.length === 0 || !agent || !this.agentInfo) return;
    let failed: Array<{ entry: RestoreEntry; message: string }> = [];
    if (this.agentInfo.agentCapabilities.loadSession === true) {
      failed = await this.restoreSessions(agent, plan);
    } else {
      this.deps.output.appendLine(`[warn] the agent cannot load sessions: ${plan.length} session(s) not restored`);
    }
    if (this.agent !== agent) return;
    await this.openFirstSessions();
    const shown = this.focusedView?.sessionId ?? null;
    if (shown) this.focus(shown);
    else if (!this.focusedId) {
      const newest = this.sortedSessions()[0];
      if (newest) this.focus(newest.id);
    }
    for (const { entry, message } of failed) {
      // Told in the tab the session belonged to, which shows a fresh session
      // by now; a group no view lists has the output-channel line only.
      const view = [...this.views].find((v) => !v.follows && v.groupId === entry.groupId && v.displayed !== null);
      const target = view?.displayed ? (this.sessions.get(view.displayed) ?? null) : null;
      if (target) this.notice(target, "warning", `Could not restore session "${entry.title}" (${entry.sessionId}): ${message}`);
    }
  }

  /**
   * What a sign-in restart brings back: every live session with a
   * conversation (an empty one is not worth a `session/load`), the focused
   * one first, then the displayed ones, then the rest, most recent first.
   * Sessions still restoring or closing are left out: their own pending
   * request ends with the old process and cleans up after itself.
   */
  private restorePlan(): RestoreEntry[] {
    const entries: RestoreEntry[] = [];
    for (const session of this.sortedSessions()) {
      if (session.loading || session.closing || session.transcript.items.length === 0) continue;
      entries.push({
        sessionId: session.id,
        handle: session.handle,
        groupId: session.groupId,
        agentTitle: session.agentTitle,
        title: session.title(),
        updatedAt: session.updatedAt,
        views: [...this.views].filter((v) => !v.follows && v.displayed === session.id),
        focused: session.id === this.focusedId,
      });
    }
    const rank = (e: RestoreEntry): number => (e.focused ? 0 : e.views.length > 0 ? 1 : 2);
    return entries.sort((a, b) => rank(a) - rank(b));
  }

  /**
   * Load the {@link restorePlan} back into the new agent, up to
   * {@link RESTORE_CONCURRENCY} sessions at a time, each into a process of
   * its own (D31). They start in plan order, so the focused and the
   * displayed ones come first, and each `ChatSession` is created (and the
   * focused one focused) synchronously when its load starts; every session
   * keeps its old `updatedAt`, so the list order does not depend on which
   * load finishes first. A view shows its session again unless it shows
   * another one by now. Returns the sessions the agent could not load, in
   * plan order; a session whose tab was closed meanwhile, or that something
   * else restored already, is skipped, and once the agent is no longer ready
   * (it exited, or wants a sign-in again) the rest are left for Past sessions.
   */
  private async restoreSessions(
    agent: AgentPool,
    plan: readonly RestoreEntry[],
  ): Promise<Array<{ entry: RestoreEntry; message: string }>> {
    const failed: Array<{ entry: RestoreEntry; message: string } | undefined> = [];
    let next = 0;
    let halted = false;
    const worker = async (): Promise<void> => {
      while (!halted && next < plan.length) {
        const index = next++;
        const entry = plan[index]!;
        if (this.agent !== agent || agent.status !== "ready") {
          halted = true;
          this.deps.output.appendLine(`[warn] ${plan.length - index} session(s) not restored: the agent is ${agent.status}`);
          return;
        }
        if (this.closedGroups.has(entry.groupId) || this.sessions.has(entry.sessionId)) continue;
        const result = await this.loadInto(agent, entry.sessionId, {
          handle: entry.handle,
          groupId: entry.groupId,
          views: entry.views.filter((v) => this.views.has(v) && v.displayed === null),
          focus: entry.focused,
          agentTitle: entry.agentTitle,
          updatedAt: entry.updatedAt,
          fallback: null,
        });
        if (typeof result !== "string") continue;
        failed[index] = { entry, message: result };
        if (this.focusedId === entry.sessionId) this.clearFocus();
      }
    };
    const workers = Math.min(RESTORE_CONCURRENCY, plan.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return failed.filter((f): f is { entry: RestoreEntry; message: string } => f !== undefined);
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
      view.acceptsImages = caps.promptCapabilities?.image === true;
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
      // A `wait_for_session` on any of them ends `closed`: no turn can run until a restart (D30).
      this.notifyLinkWaiters();
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

  /**
   * Kiro asks its own permission before it runs an MCP tool. For the agent
   * link's tools (D30) the extension answers it itself while
   * `kiroAcp.agentLink.autoApprove` is on: sending and starting are guarded
   * by the extension's own confirmation (`kiroAcp.agentLink.confirm`), the
   * other tools only read, and a card per message was reported as noise.
   */
  autoAllowsPermission(req: acp.RequestPermissionRequest): boolean {
    const toolCallId = req.toolCall?.toolCallId;
    const referenced = toolCallId ? this.sessions.get(req.sessionId)?.transcript.toolCalls[toolCallId]?.title : undefined;
    const match = matchAgentLinkPermission(req, referenced);
    if (match.kind === "none") return false;
    if (match.kind === "near") {
      // The tool is named without the server: not answered, but logged so the
      // real request shape can be recorded (protocol-notes, Agent link).
      this.deps.output.appendLine(
        `[info] agent-link: a permission request names an agent-link tool but not ${AGENT_LINK_SERVER_NAME}; asking the user: ${JSON.stringify(match.text).slice(0, 300)}`,
      );
      return false;
    }
    if (!this.agentLinkAutoApprove()) return false;
    this.deps.output.appendLine(
      `[info] agent-link: answered Kiro's permission request for ${JSON.stringify(match.text).slice(0, 200)} (kiroAcp.agentLink.autoApprove)`,
    );
    return true;
  }

  /** `kiroAcp.agentLink.autoApprove` (default true). */
  private agentLinkAutoApprove(): boolean {
    return vscode.workspace.getConfiguration("kiroAcp").get<boolean>("agentLink.autoApprove", true) !== false;
  }

  private async createSession(groupId: string): Promise<ChatSession | null> {
    const agent = this.agent;
    if (!agent) return null;
    let grant: AgentLinkGrant | null = null;
    try {
      const remembered = this.rememberSessionOptionsEnabled() ? this.rememberedSessionOptions() : null;
      // The session id is not known before `session/new` answers: the grant is
      // issued unbound and bound right after (D30).
      grant = await this.issueLinkGrant();
      const { state, linked } = await this.newSessionWithHints(agent, remembered, grant ? [grant.mcpServer()] : []);
      if (grant && linked) this.keepLinkGrant(state.sessionId, grant);
      else grant?.revoke();
      const session = new ChatSession(state, ++this.sessionSeq, groupId);
      this.sessions.set(session.id, session);
      this.deps.output.appendLine(
        `[info] session ${session.id} opened (group ${groupId}${linked ? ", agent link" : ""})`,
      );
      this.scheduleSessions();
      if (remembered) await this.applyRememberedOptions(agent, session, remembered);
      return session;
    } catch (error) {
      grant?.revoke();
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
  // Agent link (D30): an MCP server every session can call
  // ---------------------------------------------------------------------

  /** `kiroAcp.agentLink.enabled` (default false while the real CLI is unverified). */
  private agentLinkSetting(): boolean {
    return vscode.workspace.getConfiguration("kiroAcp").get<boolean>("agentLink.enabled", false);
  }

  /** Why new sessions get no agent-link server, or null when they do. */
  private agentLinkUnavailable(): string | null {
    if (!this.agentLinkSetting()) return "kiroAcp.agentLink.enabled is off";
    if (this.agentInfo?.agentCapabilities.mcpCapabilities?.http !== true) {
      return "the agent does not advertise mcpCapabilities.http";
    }
    if (this.agentLinkRefused) return "the agent rejected it on session/new";
    return null;
  }

  /** The running server, started on first use; null when it cannot listen (logged). */
  private ensureAgentLink(): Promise<AgentLinkServerApi | null> {
    if (this.agentLink) return Promise.resolve(this.agentLink);
    if (this.agentLinkStarting) return this.agentLinkStarting;
    const server = new AgentLinkServer({
      tools: createAgentLinkTools(this),
      logger: {
        info: (message) => this.deps.output.appendLine(`[info] ${message}`),
        warn: (message) => this.deps.output.appendLine(`[warn] ${message}`),
      },
      version: this.extensionVersion(),
      instructions: AGENT_LINK_INSTRUCTIONS,
    });
    const starting = server.start().then(
      () => {
        this.agentLink = server;
        this.deps.output.appendLine(`[info] agent-link listening on ${server.url ?? "?"}`);
        return server;
      },
      (error: unknown) => {
        this.deps.output.appendLine(`[warn] agent-link could not start: ${errorMessage(error)}`);
        return null;
      },
    );
    // Cleared once settled, so a later start after stopAgentLink() builds a
    // new server instead of handing out the stopped one.
    const tracked: Promise<AgentLinkServerApi | null> = starting.finally(() => {
      if (this.agentLinkStarting === tracked) this.agentLinkStarting = null;
    });
    this.agentLinkStarting = tracked;
    return tracked;
  }

  /**
   * A grant for a session about to be created (unbound) or loaded (bound to
   * `sessionId`), or null when sessions get no agent link right now.
   */
  private async issueLinkGrant(sessionId?: string): Promise<AgentLinkGrant | null> {
    if (this.agentLinkUnavailable() !== null) return null;
    const server = await this.ensureAgentLink();
    if (!server) return null;
    try {
      return server.issue(sessionId);
    } catch (error) {
      this.deps.output.appendLine(`[warn] agent-link grant failed: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Bind `grant` to `sessionId` and keep it until the session goes away. */
  private keepLinkGrant(sessionId: string, grant: AgentLinkGrant): void {
    grant.bind(sessionId);
    const previous = this.linkGrants.get(sessionId);
    if (previous && previous !== grant) previous.revoke();
    this.linkGrants.set(sessionId, grant);
  }

  /** The session is gone: its token stops working. */
  private revokeLink(sessionId: string): void {
    const grant = this.linkGrants.get(sessionId);
    if (!grant) return;
    grant.revoke();
    this.linkGrants.delete(sessionId);
  }

  private async stopAgentLink(reason: string): Promise<void> {
    const server = this.agentLink ?? (this.agentLinkStarting ? await this.agentLinkStarting : null);
    this.agentLink = null;
    this.agentLinkStarting = null;
    this.linkGrants.clear();
    if (!server) return;
    try {
      await server.stop();
    } catch (error) {
      this.deps.output.appendLine(`[warn] agent-link stop failed: ${errorMessage(error)}`);
    }
    this.deps.output.appendLine(`[info] agent-link stopped (${reason})`);
  }

  /**
   * `/capabilities`: the server on its first line (`on — 127.0.0.1:<port>, …`
   * / `off (<why>)`), then, while sessions get it, the tools, the chain limit
   * and the confirmation mode, and whether agent messages are paused.
   */
  private describeAgentLink(): string {
    const server = this.agentLink;
    let line: string;
    let offered: boolean;
    if (server?.port) {
      const sessions = this.linkGrants.size;
      line = `on — 127.0.0.1:${server.port}, ${sessions} session${sessions === 1 ? "" : "s"} linked`;
      offered = true;
    } else {
      const reason = this.agentLinkUnavailable();
      line = reason ? `off (${reason})` : "on (starts with the next session)";
      offered = reason === null;
    }
    const details: string[] = [];
    if (offered) {
      const tools = createAgentLinkTools(this).map((tool) => `\`${tool.definition.name}\``);
      details.push(
        `- tools: ${tools.join(", ") || "none"}`,
        `- chain limit: ${this.agentLinkMaxChain()} agent-started turns in a row (\`kiroAcp.agentLink.maxChain\`)`,
        `- confirmation: \`${this.agentLinkConfirmMode()}\` (\`kiroAcp.agentLink.confirm\`)`,
      );
    }
    if (this.peerMessagesPaused) details.push("- agent messages paused (`Kiro: Resume Agent Messages` resumes them)");
    return [line, ...details].join("\n");
  }

  /** `kiroAcp.agentLink.maxChain`: 1–50, default {@link DEFAULT_MAX_CHAIN}. */
  private agentLinkMaxChain(): number {
    const value = vscode.workspace.getConfiguration("kiroAcp").get<unknown>("agentLink.maxChain", DEFAULT_MAX_CHAIN);
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_CHAIN;
    return Math.min(MAX_CHAIN_LIMIT, Math.max(1, Math.floor(value)));
  }

  /** `kiroAcp.agentLink.confirm`, default `firstPerPair`. */
  private agentLinkConfirmMode(): AgentLinkConfirmMode {
    const value = vscode.workspace.getConfiguration("kiroAcp").get<unknown>("agentLink.confirm", "firstPerPair");
    return value === "always" || value === "never" ? value : "firstPerPair";
  }

  /** `kiroAcp.agentLink.startIn`: where `start_session` opens the new session (default the caller's tab). */
  private agentLinkStartIn(): "callerTab" | "newTab" | "asRequested" {
    const value = vscode.workspace.getConfiguration("kiroAcp").get<unknown>("agentLink.startIn", "callerTab");
    return value === "newTab" || value === "asRequested" ? value : "callerTab";
  }

  /** {@link AgentLinkHost}: every live session as the agent link shows it, most recent first. */
  listSessions(callerSessionId: string): LinkedSessionInfo[] {
    return this.sortedSessions()
      .filter((s) => !s.closing)
      .map((s) => this.linkedInfo(s, callerSessionId));
  }

  private linkedInfo(session: ChatSession, callerSessionId: string): LinkedSessionInfo {
    return {
      handle: session.handle,
      sessionId: session.id,
      title: session.title(),
      tab: this.tabLabel(session.groupId),
      status: this.linkStatusOf(session),
      self: session.id === callerSessionId,
    };
  }

  /** The calling session: a tool call only speaks for a live one. */
  private linkCaller(callerSessionId: string): ChatSession {
    const caller = this.sessions.get(callerSessionId);
    if (!caller) throw new AgentLinkError("closed", "Your own session is closed; nothing was done.");
    return this.liveLinkCaller(caller);
  }

  /** `caller` if it is still live (checked again after every await). */
  private liveLinkCaller(caller: ChatSession): ChatSession {
    if (this.sessions.get(caller.id) !== caller || caller.closing) {
      throw new AgentLinkError("closed", "Your own session is closing; nothing was done.");
    }
    return caller;
  }

  /**
   * The live session `target` names (D30): a handle (`s3`, any case) or a
   * session id. Refuses a session that is closing (`closed`) or still being
   * restored (`restoring`).
   */
  private linkTarget(target: string): ChatSession {
    const wanted = typeof target === "string" ? target.trim() : "";
    const lower = wanted.toLowerCase();
    const session = [...this.sessions.values()].find((s) => s.handle.toLowerCase() === lower || s.id === wanted);
    if (!wanted || !session) {
      throw new AgentLinkError(
        "unknown_session",
        `No live session ${JSON.stringify(wanted)}. Call list_sessions for the sessions and their handles.`,
      );
    }
    return this.liveLinkTarget(session);
  }

  /** `session` if it is still live and restored (checked again after every await). */
  private liveLinkTarget(session: ChatSession): ChatSession {
    if (this.sessions.get(session.id) !== session || session.closing) {
      throw new AgentLinkError("closed", `Session ${session.handle} is closed.`);
    }
    if (session.loading) {
      throw new AgentLinkError("restoring", `Session ${session.handle} is still being restored; try again in a moment.`);
    }
    return session;
  }

  private pausedError(): AgentLinkError {
    return new AgentLinkError(
      "paused",
      "The user paused agent messages (Kiro: Pause Agent Messages); nothing was sent. Tell the user what you wanted to send instead.",
    );
  }

  /**
   * The checks a peer message or a new session's prompt passes before the
   * user is asked (D30), in order: paused, empty, too long, chain limit, rate
   * limit. Only an attempt that passed the others counts against the rate (a
   * declined one too: the cards are not free either). Returns the text to
   * send (trimmed) and the chain depth of the turn it will start. `target` is
   * null for `start_session`.
   */
  private gatePeerMessage(caller: ChatSession, text: string, target: ChatSession | null): { text: string; depth: number } {
    if (this.peerMessagesPaused) throw this.pausedError();
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) throw new AgentLinkError("empty_text", "The message is empty; nothing was sent.");
    if (!fitsPeerMessage(trimmed)) {
      throw new AgentLinkError(
        "too_long",
        `The message is over ${PEER_MESSAGE_MAX_BYTES / 1024} KiB; nothing was sent. Shorten it, or send the details in several messages.`,
      );
    }
    const depth = caller.turnDepth + 1;
    const max = this.agentLinkMaxChain();
    if (depth > max) {
      this.noteChainStopped(caller, target, max);
      throw new AgentLinkError(
        "chain_limit",
        `Agent message chain stopped: your turn was started by ${caller.turnDepth} agent messages in a row ` +
          `(limit ${max}, kiroAcp.agentLink.maxChain). Do not send more; finish your answer for the user, who can continue the conversation.`,
      );
    }
    if (!this.peerRate.take(caller.id)) {
      const seconds = Math.max(1, Math.ceil(this.peerRate.retryAfterMs(caller.id) / 1000));
      throw new AgentLinkError(
        "rate_limited",
        `Too many messages: a session may send ${PEER_RATE_LIMIT.messages} per ${PEER_RATE_LIMIT.windowMs / 1000} s. ` +
          `Nothing was sent; try again in ${seconds} s.`,
      );
    }
    return { text: trimmed, depth };
  }

  /**
   * The chain limit stopped `caller`'s message: say so in both chats, the
   * agents will not (D30). Once per turn: an agent that tries again in the
   * same turn gets the refusal, the chats no second notice.
   */
  private noteChainStopped(caller: ChatSession, target: ChatSession | null, max: number): void {
    this.deps.output.appendLine(
      `[info] agent-link ${caller.handle} -> ${target?.handle ?? "new session"} refused: chain limit (depth ${caller.turnDepth}, max ${max})`,
    );
    if (caller.chainStopNoted === caller.turnGeneration) return;
    caller.chainStopNoted = caller.turnGeneration;
    const turns = `${caller.turnDepth} agent-started turn${caller.turnDepth === 1 ? "" : "s"} in a row`;
    const limit = `kiroAcp.agentLink.maxChain = ${max}`;
    this.notice(
      caller,
      "info",
      `Agent message chain stopped: this session tried to message ${target ? target.handle : "a new session"} after ${turns} (${limit}). Send a message yourself to go on.`,
    );
    if (target) {
      this.notice(
        target,
        "info",
        `Agent message chain stopped: ${caller.handle} ${JSON.stringify(caller.title())} tried to message this session after ${turns} (${limit}).`,
      );
    }
  }

  /** Whether `kiroAcp.agentLink.confirm` wants the user asked before `callerId` messages `targetId` (null: a new session). */
  private needsPeerConfirmation(callerId: string, targetId: string | null): boolean {
    const mode = this.agentLinkConfirmMode();
    if (mode === "never") return false;
    if (mode === "always" || targetId === null) return true;
    return !(this.peerConsents.get(callerId)?.has(targetId) ?? false);
  }

  private rememberPeerConsent(callerId: string, targetId: string): void {
    let targets = this.peerConsents.get(callerId);
    if (!targets) {
      targets = new Set<string>();
      this.peerConsents.set(callerId, targets);
    }
    targets.add(targetId);
  }

  /**
   * A session went away (closed, `/clear`, failed restore, restart): its pair
   * consents and rate history go too, and the waits on it end `closed` (D30).
   */
  private forgetLinkSession(sessionId: string): void {
    this.peerConsents.delete(sessionId);
    for (const targets of this.peerConsents.values()) targets.delete(sessionId);
    this.peerRate.forget(sessionId);
    this.notifyLinkWaiters();
  }

  /**
   * Ask the user in `caller`'s chat (D30): a permission card synthesized
   * through the PermissionManager, so it renders, resolves and makes the
   * caller `needs_input` like any other request. It is a `local` request:
   * session policies neither answer it nor are offered on it, in either
   * direction (see {@link CONFIRM_CAPABILITY}). The card is also a tool call
   * in the caller's transcript: a `state` snapshot (tab switch, reload) only
   * renders permissions of tool calls it knows, and the call keeps the
   * decision on record. True for "Send" only; "Don't send", a cancel (the
   * turn ended, the session closed) and an aborted `signal` are a no.
   */
  private async confirmPeerAction(
    caller: ChatSession,
    title: string,
    consent: { capability: string },
    declinedText: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const toolCallId = `agent-link-confirm-${++this.linkConfirmSeq}`;
    this.applyLocalUpdate(caller, { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "pending" });
    let allowed = false;
    try {
      const response = await this.deps.permissions.request(
        {
          sessionId: caller.id,
          toolCall: { toolCallId, title, kind: "other", status: "pending" },
          options: [
            { optionId: CONFIRM_ALLOW, name: "Send", kind: "allow_once" },
            { optionId: CONFIRM_REJECT, name: "Don't send", kind: "reject_once" },
          ],
          _meta: { kiro: { consent } },
        },
        signal,
        { local: true },
      );
      allowed = !signal.aborted && response.outcome.outcome === "selected" && response.outcome.optionId === CONFIRM_ALLOW;
    } finally {
      // Only this very session: it may have closed (or been restored anew) meanwhile.
      if (this.sessions.get(caller.id) === caller) {
        this.applyLocalUpdate(
          caller,
          allowed
            ? { sessionUpdate: "tool_call_update", toolCallId, status: "completed" }
            : {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "failed",
                content: [{ type: "content", content: { type: "text", text: declinedText } }],
              },
        );
      }
    }
    this.deps.output.appendLine(`[info] agent-link ${caller.handle} confirmation: ${allowed ? "allowed" : "declined"}`);
    return allowed;
  }

  /**
   * Deliver a peer message (D30): echoed in `target` as a user message with
   * its origin (the raw text, no frame), sent to the agent framed by
   * `framePeerMessage`. An idle target starts a turn now (not awaited); a
   * busy one (turn running or prompts queued) holds it in its D22 queue,
   * badged `queued`. Never `_session/steer`. The caller has checked that both
   * sessions are live.
   */
  private deliverPeerMessage(sender: ChatSession, target: ChatSession, text: string, depth: number): PeerDelivery {
    const agent = this.agent;
    if (!agent || agent.status !== "ready") {
      throw new AgentLinkError("not_ready", "Kiro is not running (or needs a sign-in); nothing was sent.");
    }
    const senderTitle = sender.title();
    const framed = framePeerMessage(
      { handle: sender.handle, title: senderTitle, tab: this.tabLabel(sender.groupId) },
      text,
      depth,
    );
    const blocks: acp.ContentBlock[] = [{ type: "text", text: framed }];
    const busy = target.turnActive || target.queue.length > 0;
    if (target.firstPrompt === null) target.firstPrompt = truncateTitle(text);
    const messageId = this.echoUserMessage(target, text, [], busy ? "queued" : undefined);
    const origin: MessageOrigin = { sessionId: sender.id, handle: sender.handle, title: senderTitle };
    target.transcript = setMessageOrigin(target.transcript, messageId, origin);
    this.postTo(target.id, { type: "messageOrigin", messageId, origin });
    const delivery: PeerDelivery = busy ? "queued" : "started";
    this.deps.output.appendLine(`[info] agent-link ${sender.handle} -> ${target.handle} message (${delivery}, depth ${depth})`);
    if (busy) this.enqueue(target, { text, chips: [], blocks, messageId, depth, fromSessionId: sender.id });
    else void this.runTurn(agent, target, blocks, depth);
    return delivery;
  }

  /** {@link AgentLinkHost.readSession}: the last `last` items of `target` as text; the caller may read itself. */
  readSession(callerSessionId: string, target: string, last: number): SessionReadResult {
    this.linkCaller(callerSessionId);
    const session = this.linkTarget(target);
    const items = Number.isFinite(last)
      ? Math.min(READ_SESSION_MAX_ITEMS, Math.max(1, Math.floor(last)))
      : READ_SESSION_DEFAULT_ITEMS;
    const rendered = transcriptText(session.transcript, { last: items, maxChars: READ_SESSION_MAX_CHARS });
    return {
      session: this.linkedInfo(session, callerSessionId),
      text: rendered.text,
      items: rendered.items,
      truncated: rendered.truncated,
    };
  }

  /**
   * {@link AgentLinkHost.sendMessage} (D30): checks (self, paused, empty, too
   * long, chain, rate), the user's confirmation when `kiroAcp.agentLink.confirm`
   * wants one, then {@link deliverPeerMessage}.
   */
  async sendMessage(callerSessionId: string, target: string, text: string, signal: AbortSignal): Promise<SendMessageResult> {
    const caller = this.linkCaller(callerSessionId);
    const session = this.linkTarget(target);
    if (session === caller) {
      throw new AgentLinkError("self", "That is your own session; a session cannot message itself.");
    }
    const gated = this.gatePeerMessage(caller, text, session);
    if (this.needsPeerConfirmation(caller.id, session.id)) {
      const title = `Send to ${session.handle} ${JSON.stringify(session.title())}: ${confirmSnippet(gated.text)}`;
      const allowed = await this.confirmPeerAction(
        caller,
        title,
        { capability: CONFIRM_CAPABILITY },
        "Not sent.",
        signal,
      );
      if (!allowed) {
        throw new AgentLinkError("declined", `The user declined; the message was not sent to ${session.handle}.`);
      }
      // Either session may have closed, or agent messages been paused, while the card waited.
      this.liveLinkCaller(caller);
      this.liveLinkTarget(session);
      if (this.peerMessagesPaused) throw this.pausedError();
      this.rememberPeerConsent(caller.id, session.id);
    }
    const delivery = this.deliverPeerMessage(caller, session, gated.text, gated.depth);
    return { to: this.linkedInfo(session, caller.id), delivery };
  }

  /**
   * {@link AgentLinkHost.waitForSession} (D30): resolves at once when `target`
   * is idle (no turn, nothing queued) or waits for the user; otherwise when it
   * gets there, closes, the agent goes away, or after `timeoutMs`. Aborting
   * `signal` (the caller's tool call went away) rejects. Every path removes
   * the waiter, its timer and its abort listener.
   */
  waitForSession(callerSessionId: string, target: string, timeoutMs: number, signal: AbortSignal): Promise<WaitResult> {
    let caller: ChatSession;
    let session: ChatSession;
    try {
      caller = this.linkCaller(callerSessionId);
      session = this.linkTarget(target);
    } catch (error) {
      return Promise.reject(error);
    }
    if (session === caller) {
      return Promise.reject(new AgentLinkError("self", "That is your own session; a session cannot wait for itself."));
    }
    if (signal.aborted) return Promise.reject(abortReason(signal));
    const result = (outcome: WaitOutcome): WaitResult => {
      const live = outcome !== "closed" && this.sessions.get(session.id) === session;
      return {
        session: live ? this.linkedInfo(session, caller.id) : null,
        outcome,
        // A closed session's last answer is still worth having.
        lastAnswer: lastAgentAnswer(session.transcript, LAST_ANSWER_MAX_CHARS),
      };
    };
    const now = this.waitOutcome(session);
    if (now) return Promise.resolve(result(now));
    const seconds = Math.round(Math.max(0, timeoutMs) / 1000);
    this.deps.output.appendLine(`[info] agent-link ${caller.handle} waits for ${session.handle} (up to ${seconds} s)`);
    return new Promise<WaitResult>((resolve, reject) => {
      const finish = (settle: () => void, what: string): void => {
        if (!this.linkWaiters.delete(waiter)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.deps.output.appendLine(`[info] agent-link ${caller.handle} wait for ${session.handle}: ${what}`);
        settle();
      };
      const waiter: LinkWaiter = {
        check: () => {
          // The waiting session went away: nobody needs the answer any more.
          if (this.sessions.get(caller.id) !== caller) {
            finish(() => reject(new AgentLinkError("closed", "Your own session closed while waiting.")), "caller closed");
            return;
          }
          const outcome = this.waitOutcome(session);
          if (outcome) finish(() => resolve(result(outcome)), outcome);
        },
      };
      const onAbort = (): void => finish(() => reject(abortReason(signal)), "aborted");
      const timer = setTimeout(() => finish(() => resolve(result("timeout")), "timeout"), Math.max(0, timeoutMs));
      this.linkWaiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Where a waited-for session stands (D30); null while it still works. */
  private waitOutcome(session: ChatSession): WaitOutcome | null {
    if (this.sessions.get(session.id) !== session || this.agentDown()) return "closed";
    // Closing (`/clear`, its tab closed): `closed` once it is gone; a `/clear`
    // whose replacement failed leaves it usable, so it is not reported yet.
    if (session.closing) return null;
    if (this.pendingFor(session.id).length > 0) return "needs_input";
    if (!session.turnActive && session.queue.length === 0 && !session.loading) return "idle";
    return null;
  }

  /**
   * Re-check the pending waits once the current synchronous work is done:
   * a turn that ends may start the next queued one at once (`endTurn` →
   * `handleStopReason` → `drainQueue`), and only the settled state says
   * whether the session is really idle (D30).
   */
  private notifyLinkWaiters(): void {
    if (this.linkWaiters.size === 0 || this.linkWaitersCheckQueued) return;
    this.linkWaitersCheckQueued = true;
    queueMicrotask(() => {
      this.linkWaitersCheckQueued = false;
      for (const waiter of [...this.linkWaiters]) waiter.check();
    });
  }

  /**
   * {@link AgentLinkHost.startSession} (D30): the gates of `send_message`
   * (paused, empty, too long, chain, rate), the user's confirmation unless
   * `kiroAcp.agentLink.confirm` is `never`, then a new session (`sameTab`: in
   * the caller's group, its view keeps showing the caller; `newTab`: in a new
   * chat tab that does not take the focus) that gets `prompt` as a peer
   * message from the caller.
   */
  async startSession(callerSessionId: string, prompt: string, where: StartWhere, signal: AbortSignal): Promise<StartSessionResult> {
    const caller = this.linkCaller(callerSessionId);
    const gated = this.gatePeerMessage(caller, prompt, null);
    if (this.agentLinkConfirmMode() !== "never") {
      const allowed = await this.confirmPeerAction(
        caller,
        `Start a new session: ${confirmSnippet(gated.text)}`,
        { capability: CONFIRM_START_CAPABILITY },
        "Not started.",
        signal,
      );
      if (!allowed) throw new AgentLinkError("declined", "The user declined; no session was started.");
      this.liveLinkCaller(caller);
      if (this.peerMessagesPaused) throw this.pausedError();
    }
    if (!this.agent || this.agent.status !== "ready") {
      throw new AgentLinkError("not_ready", "Kiro is not running (or needs a sign-in); no session was started.");
    }
    // Where it opens is the user's call (`kiroAcp.agentLink.startIn`): by
    // default in the caller's own tab, so it shows in the session list the
    // user works from — sessions opened in new tabs were reported as
    // invisible ("they work, but I don't see them").
    const startIn = this.agentLinkStartIn();
    const wanted: StartWhere = startIn === "asRequested" ? where : startIn === "newTab" ? "newTab" : "sameTab";
    // `newTab`: created in a group no view lists, so no other view adopts it
    // as a spare while `session/new` runs; the new tab then takes it over.
    const newTab = wanted === "newTab" && this.openTab !== null;
    const groupId = newTab ? `agent-link-start-${++this.linkStartSeq}` : caller.groupId;
    const created = await this.createSession(groupId);
    if (!created) {
      throw new AgentLinkError("not_ready", "The new session could not be created; see the Kiro ACP output for why.");
    }
    if (this.sessions.get(caller.id) !== caller || caller.closing || this.closedGroups.has(groupId)) {
      // The caller (or its tab) went away during `session/new`: nobody wants the session any more.
      await this.closeSession(created.id);
      throw new AgentLinkError("closed", "Your own session closed before the new one started; it was closed again.");
    }
    if (this.sessions.get(created.id) !== created || created.closing) {
      throw new AgentLinkError("closed", "The new session was closed before it got the prompt.");
    }
    if (signal.aborted || this.peerMessagesPaused) {
      // Stop in the caller (its tool call is gone, so it would never learn the
      // new handle) or the user paused agent messages meanwhile.
      await this.closeSession(created.id);
      throw signal.aborted ? abortReason(signal) : this.pausedError();
    }
    if (newTab) {
      try {
        this.openTab?.(created.id, { preserveFocus: true, besideGroup: caller.groupId });
      } catch (error) {
        this.deps.output.appendLine(`[warn] agent-link: could not open a tab for ${created.handle}: ${errorMessage(error)}`);
      }
      if (created.groupId === groupId) {
        // The host showed it nowhere: keep it where the caller's user can find it.
        created.groupId = caller.groupId;
        this.scheduleSessions();
      }
    }
    this.deps.output.appendLine(
      `[info] agent-link ${caller.handle} started ${created.handle} (${newTab ? "newTab" : "sameTab"}; asked ${where}, kiroAcp.agentLink.startIn ${startIn})`,
    );
    const delivery = this.deliverPeerMessage(caller, created, gated.text, gated.depth);
    return { session: this.linkedInfo(created, caller.id), delivery };
  }

  // ---------------------------------------------------------------------
  // Pause (Kiro: Pause / Resume Agent Messages, D30)
  // ---------------------------------------------------------------------

  /** True while agent messages are paused. */
  get agentMessagesPaused(): boolean {
    return this.peerMessagesPaused;
  }

  /**
   * `Kiro: Pause Agent Messages`: drop the queued peer messages of every
   * session (the usual "discarded" notice) and refuse `send_message` /
   * `start_session` with `paused` until resumed. Turns already running go
   * on. Not persisted. Returns how many queued messages were dropped.
   */
  pauseAgentMessages(): number {
    this.peerMessagesPaused = true;
    void vscode.commands.executeCommand("setContext", AGENT_MESSAGES_PAUSED_KEY, true);
    let dropped = 0;
    for (const session of this.sessions.values()) dropped += this.discardPeerMessages(session);
    this.deps.output.appendLine(`[info] agent-link messages paused (${dropped} queued message(s) discarded)`);
    return dropped;
  }

  /** `Kiro: Resume Agent Messages`. */
  resumeAgentMessages(): void {
    this.peerMessagesPaused = false;
    void vscode.commands.executeCommand("setContext", AGENT_MESSAGES_PAUSED_KEY, false);
    this.deps.output.appendLine("[info] agent-link messages resumed");
  }

  /** Drop the queued peer messages of `session`, keeping what the user queued. Returns how many. */
  private discardPeerMessages(session: ChatSession): number {
    const kept: QueuedPrompt[] = [];
    let dropped = 0;
    for (const item of session.queue.splice(0)) {
      if (item.fromSessionId === undefined) {
        kept.push(item);
        continue;
      }
      this.setDelivery(session, item.messageId, null);
      dropped++;
    }
    session.queue.push(...kept);
    this.discardQueue(session, dropped);
    if (dropped > 0) this.notifyLinkWaiters();
    return dropped;
  }

  // ---------------------------------------------------------------------
  // Reveal (clicking "from <title>" on a peer message, D30)
  // ---------------------------------------------------------------------

  /**
   * Show `sessionId` wherever it lives: the tab / sidebar displaying it is
   * revealed; else a view of its group displays it; else (its group has no
   * open view, e.g. `default`) a new tab opens on it. A session that is gone
   * gets an info notice in the requesting view.
   */
  private revealSession(sessionId: string, requester: ViewBinding | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) {
      const text = "That session is closed.";
      const shownId = requester ? requester.sessionId : this.focusedId;
      const shown = shownId ? this.sessions.get(shownId) : undefined;
      if (shown) this.notice(shown, "info", text);
      else if (requester) this.postView(requester, { type: "notice", notice: { id: `n-${++this.noticeSeq}`, severity: "info", text } });
      else this.notice(null, "info", text);
      return;
    }
    const views = [...this.views].filter((v) => !v.follows);
    const showing = views.find((v) => v.displayed === sessionId);
    if (showing) {
      this.revealBinding(showing);
      return;
    }
    const groupView = views.find((v) => v.groupId !== null && v.groupId === session.groupId);
    if (groupView) {
      this.setViewSession(groupView, sessionId);
      this.revealBinding(groupView);
      return;
    }
    if (this.openTab) {
      this.openTab(sessionId);
      return;
    }
    // No host (tests): the views that follow the focus show it.
    this.focus(sessionId);
  }

  private revealBinding(view: ViewBinding): void {
    this.revealView?.(view);
    this.focusView(view);
  }

  private linkStatusOf(session: ChatSession): LinkedSessionStatus {
    if (session.loading) return "restoring";
    const status = this.statusOf(session);
    if (status === "running") return "working";
    if (status === "needs_input") return "needs_input";
    return "idle";
  }

  private tabLabel(groupId: string): string {
    const label = this.groupLabel?.(groupId);
    if (label) return label;
    return groupId === DEFAULT_GROUP ? "no tab" : groupId;
  }

  private extensionVersion(): string {
    return (this.deps.context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
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
   * (Kiro V3 reads them; other agents ignore `_meta`) and with `mcpServers`
   * (the agent link, D30). Should the agent reject the request, it is retried
   * first without the servers, then without the hints too, so neither a stale
   * id nor an agent that refuses our server ever blocks session creation.
   * `linked` says whether the session got the servers. An agent that refused
   * the servers and then accepted the session without them is not offered
   * them again until it restarts.
   */
  private async newSessionWithHints(
    agent: KiroAgent,
    remembered: RememberedSessionOptions | null,
    mcpServers: acp.McpServer[] = [],
  ): Promise<{ state: SessionState; linked: boolean }> {
    const cwd = this.workspaceRoot();
    const kiro: Record<string, string> = {};
    if (remembered?.modeId) kiro.modeId = remembered.modeId;
    const modelId = remembered?.modelId ?? remembered?.configOptions["model"];
    if (typeof modelId === "string" && modelId) kiro.modelId = modelId;
    const hinted = Object.keys(kiro).length > 0;
    const linked = mcpServers.length > 0;
    const attempts: Array<{ hints: boolean; servers: boolean }> = [{ hints: hinted, servers: linked }];
    if (linked) attempts.push({ hints: hinted, servers: false });
    if (hinted) attempts.push({ hints: false, servers: false });
    for (const [index, attempt] of attempts.entries()) {
      const options: { meta?: Record<string, unknown>; mcpServers?: acp.McpServer[] } = {};
      if (attempt.hints) options.meta = { kiro };
      if (attempt.servers) options.mcpServers = mcpServers;
      try {
        const state = await agent.newSession(cwd, Object.keys(options).length > 0 ? options : undefined);
        if (linked && !attempt.servers) {
          this.agentLinkRefused = true;
          this.deps.output.appendLine("[warn] agent-link: the agent rejected session/new with the agent-link server; not offered again until it restarts");
        }
        return { state, linked: attempt.servers };
      } catch (error) {
        const next = attempts[index + 1];
        // Signed out (or gone): retrying cannot help, and the caller shows the sign-in banner.
        if (!next || agent.status !== "ready") throw error;
        const dropped = [
          attempt.servers && !next.servers ? "the agent-link server" : null,
          attempt.hints && !next.hints ? `remembered hints ${safeJson(kiro)}` : null,
        ].filter((part): part is string => part !== null);
        this.deps.output.appendLine(
          `[warn] session/new with ${dropped.join(" and ")} failed (${errorMessage(error)}); retrying without ${dropped.length > 1 ? "them" : "it"}`,
        );
      }
    }
    // Unreachable: the last attempt either returns or throws.
    throw new Error("session/new failed");
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
    const ids = [...this.sessions.keys()];
    for (const session of this.sessions.values()) {
      this.deps.permissions.cancelAll(session.id);
      this.deps.permissions.clearPolicies(session.id);
      this.revokeLink(session.id);
    }
    // The processes that started their commands are going away, and the
    // commands are ours (children of the extension host), so they stop too —
    // as on close (revmux round 23).
    void Promise.all(ids.map((id) => this.deps.terminal.killSession(id))).then(
      (killed) => {
        const all = killed.flat();
        if (all.length > 0) this.deps.output.appendLine(`[info] killed running terminal(s) ${all.join(", ")} (sessions ended)`);
      },
      (error: unknown) => this.deps.output.appendLine(`[warn] killing the sessions' terminals failed: ${errorMessage(error)}`),
    );
    this.sessions.clear();
    // Waits on them end `closed`; a restored session starts with no consents or rate history (D30).
    for (const id of ids) this.forgetLinkSession(id);
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
    if (!this.pastTitles.has(sessionId)) {
      try {
        await this.listPastEntries(agent);
      } catch {
        /* the title stays unknown until the agent reports one */
      }
    }
    const loaded = await this.loadInto(agent, sessionId, {
      groupId,
      views: binding && !binding.follows ? [binding] : [],
      focus: true,
      agentTitle: this.pastTitles.get(sessionId) ?? null,
      // The view goes back to what it showed before; focus follows below.
      fallback: previous,
    });
    if (typeof loaded !== "string") return sessionId;
    if (this.focusedId === sessionId) {
      this.focusedId = null;
      const fallback = previous ?? this.sortedSessions()[0]?.id ?? null;
      if (fallback) this.focus(fallback);
      else this.clearFocus();
    }
    const target = this.focusedId ? (this.sessions.get(this.focusedId) ?? null) : null;
    this.notice(target, "warning", `Could not restore session ${sessionId}: ${loaded}`);
    return null;
  }

  /**
   * `session/load` `sessionId` into a fresh `ChatSession` of `target.groupId`,
   * displayed by `target.views` (and focused with `target.focus`) while the
   * agent replays its history. Returns the session once loaded, its
   * `updatedAt` set to `target.updatedAt` (default: now). On failure it is
   * forgotten again, the views that displayed it show `target.fallback`, and
   * the error message is returned; focus is the caller's to fix.
   */
  private async loadInto(
    agent: AgentPool,
    sessionId: string,
    target: {
      /** A sign-in restore keeps the session's agent-link handle (D30); a past session gets a new one. */
      handle?: string;
      groupId: string;
      views: readonly ViewBinding[];
      focus: boolean;
      agentTitle: string | null;
      updatedAt?: number;
      fallback: string | null;
    },
  ): Promise<ChatSession | string> {
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
    const session = new ChatSession(placeholder, ++this.sessionSeq, target.groupId, target.handle);
    session.loading = true;
    session.agentTitle = target.agentTitle;
    this.sessions.set(sessionId, session);
    this.deps.output.appendLine(`[info] session ${sessionId} restoring (group ${target.groupId})`);
    for (const view of target.views) this.setViewSession(view, sessionId);
    if (target.focus) this.focus(sessionId);
    const restoring = this.notice(session, "info", "Restoring session…");
    // The id is known up front, so the grant is issued bound (D30). A load is
    // not retried without it: a failed load may already have replayed history.
    let grant: AgentLinkGrant | null = null;
    try {
      grant = await this.issueLinkGrant(sessionId);
      const state = await agent.loadSession(sessionId, cwd, grant ? { mcpServers: [grant.mcpServer()] } : undefined);
      if (grant) {
        if (this.sessions.get(sessionId) === session) this.keepLinkGrant(sessionId, grant);
        else grant.revoke();
      }
      // Closed while loading: its release came before the pool bound it, so
      // the process it got is let go now, unless the id lives on (restored again).
      if (!this.sessions.has(sessionId)) agent.releaseSession(sessionId);
      // The client already emitted a `state` event for it; merging again is harmless.
      this.applySessionState(session, state);
    } catch (error) {
      grant?.revoke();
      const message = errorMessage(error);
      this.deps.output.appendLine(`[error] session ${sessionId} restore failed: ${message}`);
      // Only this very object: the id may have been closed and restored again meanwhile.
      if (this.sessions.get(sessionId) === session) {
        this.sessions.delete(sessionId);
        this.revokeLink(sessionId);
        this.forgetLinkSession(sessionId);
        this.deps.permissions.cancelAll(sessionId);
        this.deps.permissions.clearPolicies(sessionId);
        // No process keeps it (D31); a no-op when the pool never bound it.
        agent.releaseSession(sessionId);
        for (const v of this.views) {
          if (!v.follows && v.displayed === sessionId) this.setViewSession(v, target.fallback);
        }
      }
      this.scheduleSessions();
      return message;
    }
    session.loading = false;
    this.notifyLinkWaiters();
    // The replay touched it; a session coming back keeps its place in the list.
    if (target.updatedAt === undefined) session.touch();
    else session.updatedAt = target.updatedAt;
    this.clearNotice(session, restoring.id);
    for (const v of this.views) {
      if (v.sessionId === sessionId) this.postSessionState(v, sessionId);
    }
    this.scheduleSessions();
    this.deps.output.appendLine(`[info] session ${sessionId} restored (${session.transcript.items.length} items)`);
    return session;
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

  // ---------------------------------------------------------------------
  // Process exits (D31: one kiro-cli process per session)
  // ---------------------------------------------------------------------

  /** No process hosts `session` right now: its process exited, and it is not loaded into a new one yet (D31). */
  private unhosted(session: ChatSession): boolean {
    return session.processLost !== null;
  }

  /**
   * The process hosting `sessionIds` exited on its own (D31). Only these
   * sessions are affected; the connection, and every other session, go on.
   * Each one's turn ends (error) and its queue is dropped with the usual
   * notice, its permission requests are cancelled, the commands it still
   * runs are killed (no agent is left to release them) and its agent-link
   * token is revoked (the dead process held the only connection that used
   * it). The session keeps its transcript, handle and place in the list; one
   * notice says what happened, and its next turn loads it into a new process
   * first ({@link reloadSession}). When the turn's "Prompt failed" arrived
   * before this event, this notice replaces it. A `wait_for_session` on it
   * ends `idle`, as after any failed turn (D30): the session can be messaged
   * again.
   */
  private onProcessExited(sessionIds: readonly string[], message: string): void {
    for (const id of sessionIds) {
      const session = this.sessions.get(id);
      // A closing session is going away anyway; one still restoring learns of
      // the exit from its own `session/load` failing.
      if (!session || session.closing || session.loading) continue;
      this.deps.output.appendLine(
        `[warn] session ${id} (${session.handle}): its kiro-cli process exited (${message}); the next turn loads it into a new process`,
      );
      session.processLost = message;
      const wasRunning = session.turnActive;
      this.deps.permissions.cancelAll(id);
      this.revokeLink(id);
      if (wasRunning) this.endTurn(session, "error");
      else this.discardQueue(session, this.discardRemaining(session));
      // The failure of the turn this exit cut short: no turn since, and only just now.
      const last = session.lastFailure;
      const earlier =
        last && last.generation === session.turnGeneration && Date.now() - last.at < EXIT_FAILURE_WINDOW_MS ? last : null;
      if (earlier) this.clearNotice(session, earlier.noticeId);
      session.lastFailure = null;
      void this.deps.terminal.killSession(id).then((killed) => {
        if (killed.length > 0) {
          this.deps.output.appendLine(`[info] session ${id}: killed its running terminal(s) ${killed.join(", ")} (its process exited)`);
        }
      });
      this.notice(
        session,
        wasRunning || earlier ? "error" : "warning",
        `Kiro's process for this session exited (${message})${wasRunning || earlier ? " and the turn ended" : ""}. ` +
          "Your next message loads the session again in a new process.",
      );
    }
    this.scheduleSessions();
    this.notifyLinkWaiters();
  }

  /**
   * Load a session whose process exited into a new process (D31) and keep
   * its `ChatSession` (transcript, handle, notices, queue): the history the
   * agent replays is dropped in {@link onSessionEvent}, the transcript shows
   * it already. The agent-link token is issued anew. One load per session at
   * a time: a second caller joins the one in flight. Resolves with null once
   * a process hosts it again, else with the error message; the session then
   * stays marked and the next turn tries again.
   */
  private reloadSession(session: ChatSession): Promise<string | null> {
    if (session.reload) return session.reload;
    const reload = this.doReloadSession(session).finally(() => {
      if (session.reload === reload) session.reload = null;
    });
    session.reload = reload;
    return reload;
  }

  private async doReloadSession(session: ChatSession): Promise<string | null> {
    const agent = this.agent;
    const id = session.id;
    if (!agent || agent.status !== "ready") return "Kiro is not running";
    if (agent.agent?.agentCapabilities.loadSession !== true) return "the agent cannot load sessions (no `loadSession` capability)";
    this.deps.output.appendLine(`[info] session ${id}: loading it into a new kiro-cli process`);
    let grant: AgentLinkGrant | null = null;
    try {
      grant = await this.issueLinkGrant(id);
      const state = await agent.loadSession(id, session.state.cwd, grant ? { mcpServers: [grant.mcpServer()] } : undefined);
      if (this.agent !== agent || this.sessions.get(id) !== session || session.closing) {
        grant?.revoke();
        // Closed while loading: its release came before the pool bound it.
        if (this.agent === agent && !this.sessions.has(id)) agent.releaseSession(id);
        return "the session was closed";
      }
      if (grant) this.keepLinkGrant(id, grant);
      session.processLost = null;
      this.applySessionState(session, state);
      const host = agent.processes().find((p) => p.sessionIds.includes(id));
      this.deps.output.appendLine(
        `[info] session ${id}: loaded again${host ? ` in process ${host.id} (pid ${host.pid ?? "unknown"})` : ""}`,
      );
      this.scheduleSessions();
      return null;
    } catch (error) {
      grant?.revoke();
      const message = errorMessage(error);
      this.deps.output.appendLine(`[warn] session ${id}: could not load it into a new process: ${message}`);
      return message;
    }
  }

  /** Close every session of `groupId` (a chat tab was closed, see D20). */
  async closeGroup(groupId: string): Promise<void> {
    this.closedGroups.add(groupId);
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
    // Nothing queued may start a turn on a session that is going away; the
    // notice is posted now, while a view may still display it.
    session.closing = true;
    if (session.cancelTimer) {
      clearTimeout(session.cancelTimer);
      session.cancelTimer = null;
    }
    this.discardQueue(session, this.discardRemaining(session));
    // A session whose process exited (or is being loaded into a new one) has
    // nothing to cancel in any process (D31).
    if (session.turnActive && this.agent && !this.unhosted(session)) {
      try {
        await this.agent.cancel(sessionId);
      } catch (error) {
        this.deps.output.appendLine(`[warn] cancel before close failed: ${errorMessage(error)}`);
      }
    }
    this.deps.permissions.cancelAll(sessionId);
    this.deps.permissions.clearPolicies(sessionId);
    // Its commands are children of the extension host, not of kiro-cli: the
    // process stopped below never gets to release them, so they are stopped
    // here (D27, D31; revmux round 23).
    void this.deps.terminal.killSession(sessionId).then(
      (killed) => {
        if (killed.length > 0) {
          this.deps.output.appendLine(`[info] session ${sessionId}: killed its running terminal(s) ${killed.join(", ")} (session closed)`);
        }
      },
      (error: unknown) => this.deps.output.appendLine(`[warn] session ${sessionId}: killing its terminals failed: ${errorMessage(error)}`),
    );
    this.sessions.delete(sessionId);
    this.revokeLink(sessionId);
    this.forgetLinkSession(sessionId);
    // Its process stops once it hosts nothing else (D31). A reload or restore
    // still in flight releases it when it lands (see loadInto / reloadSession).
    this.agent?.releaseSession(sessionId);
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
    const session = this.sessions.get(id) ?? null;
    this.deps.permissions.cancelAll(id);
    if (session && this.unhosted(session)) {
      // No process hosts it (D31): nothing to tell an agent. A turn still
      // waiting for the session's reload ends here; the reload goes on, and
      // the prompt it waited for is not sent (runTurn's generation check).
      if (session.turnActive) this.handleStopReason(session, "cancelled");
    } else {
      if (session?.turnActive) this.armCancelWatchdog(session);
      try {
        await this.agent.cancel(id);
      } catch (error) {
        this.notice(session, "warning", `Cancel failed: ${errorMessage(error)}`);
      }
    }
    // Stop means the running command too (D27): a tool waiting on a service
    // that never exits would otherwise keep the turn open for ever.
    const killed = await this.deps.terminal.killSession(id);
    if (killed.length > 0) {
      this.deps.output.appendLine(`[info] session ${id} stop: killed running terminal(s) ${killed.join(", ")}`);
    }
  }

  /**
   * Stop was pressed: when the agent has not ended the turn (answered the
   * pending `session/prompt`) within {@link CANCEL_GRACE_MS}, end it locally
   * so the composer is usable again; the late answer, if any, is ignored
   * by {@link runTurn}'s generation check (D27).
   */
  private armCancelWatchdog(session: ChatSession): void {
    if (session.cancelTimer) return;
    const generation = session.turnGeneration;
    session.cancelTimer = setTimeout(() => {
      session.cancelTimer = null;
      // The same ChatSession object only: the id may have been closed and restored meanwhile.
      if (!session.turnActive || session.turnGeneration !== generation || this.sessions.get(session.id) !== session) return;
      this.deps.output.appendLine(
        `[warn] session ${session.id}: the agent did not end the turn within ${CANCEL_GRACE_MS} ms of session/cancel; ending it locally`,
      );
      session.abandonedTurn = true;
      this.notice(
        session,
        "warning",
        "Kiro did not confirm the stop; the turn was ended here. Its late reply, if any, is ignored.",
      );
      this.handleStopReason(session, "cancelled");
    }, CANCEL_GRACE_MS);
  }

  private setTurnActive(session: ChatSession, active: boolean, stopReason?: string): void {
    session.turnActive = active;
    session.touch();
    if (this.focusedId === session.id) {
      void vscode.commands.executeCommand("setContext", TURN_ACTIVE_KEY, active);
    }
    this.postTo(session.id, stopReason ? { type: "turn", active, stopReason } : { type: "turn", active });
    this.scheduleSessions();
    this.notifyLinkWaiters();
  }

  // ---------------------------------------------------------------------
  // Prompting
  // ---------------------------------------------------------------------

  /**
   * Send a prompt to `sessionId` (default: the session of `view`, else the
   * focused session) and wait for the turn to end. `view` is the webview the
   * prompt came from, so `/clear` can replace the session in that very view.
   * `images` go out as `image` blocks after the text (D29); they are checked
   * before anything is echoed, and one that fails keeps the whole message
   * from being sent.
   */
  async prompt(
    text: string,
    chips: ContextChip[],
    sessionId?: string,
    view?: ViewHandle,
    images: readonly ImageAttachment[] = [],
  ): Promise<void> {
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
      // `/login` and `/restart` exist for exactly this state (signed out, crashed):
      // run them without a session or a ready agent.
      const early = parseSlash(text.trim());
      if (early?.name === "login") return this.login();
      if (early?.name === "restart") return this.restart();
      this.notice(null, "warning", "No active session. Sign in or restart the agent, then try again.");
      return;
    }
    if (session.closing) {
      // `/clear` is replacing this session: the message was typed for the
      // replacement, so it waits for it and goes there. Nothing may be sent
      // to a closing session (D22).
      const replacement = session.replacement ? await session.replacement : null;
      if (replacement === null) {
        this.notice(session, "warning", "The session is closing; send the message again in a new one.");
        return;
      }
      return this.prompt(text, chips, replacement, view, images);
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
    if (!trimmed && chips.length === 0 && images.length === 0) return;

    // Images are checked before anything is echoed or the chips are cleared:
    // a message with a refused image is not sent at all, not half-sent (D29).
    const attached = images.length > 0 ? this.checkPromptImages(session, images) : [];
    if (attached === null) return;

    // Slash commands run at once, turn or no turn: `/cancel` must stop the
    // running turn and `/clear` must be able to leave it (D22).
    const parsed = parseSlash(trimmed);
    if (parsed && (await this.runSlash(session, parsed, chips, binding, attached))) return;

    const embeddedContext = this.agentInfo?.agentCapabilities.promptCapabilities?.embeddedContext === true;
    const blocks = await buildPromptBlocks(trimmed, chips, readWorkspaceText, { embeddedContext }, attached);

    if (session.turnActive) {
      // Plain text while the agent works: steer the turn, or hold the message
      // until the turn ends when the agent cannot steer (D22).
      await this.promptDuringTurn(agent, session, trimmed, chips, blocks, attached);
      return;
    }

    if (session.firstPrompt === null && trimmed) {
      session.firstPrompt = truncateTitle(trimmed);
    }
    this.echoUserMessage(session, trimmed, chips, undefined, attached);
    this.deps.contextTracker.clearExplicit();
    await this.runTurn(agent, session, blocks);
  }

  /** The agent advertised `promptCapabilities.image`: ACP allows `image` blocks only then (D29). */
  private acceptsImages(): boolean {
    return this.agentInfo?.agentCapabilities.promptCapabilities?.image === true;
  }

  /**
   * The images of a prompt, checked against their bytes (D29): the agent
   * must accept images, there may be at most `MAX_IMAGES_PER_PROMPT`, and
   * every one must pass `checkImageAttachment` (its sniffed `mimeType` and
   * decoded size replace the declared ones). Otherwise one warning names
   * every reason and the result is null: the message is not sent.
   */
  private checkPromptImages(session: ChatSession, images: readonly ImageAttachment[]): ImageAttachment[] | null {
    if (!this.acceptsImages()) {
      this.notice(session, "warning", "Kiro does not accept images, so the message was not sent.");
      return null;
    }
    if (images.length > MAX_IMAGES_PER_PROMPT) {
      this.notice(
        session,
        "warning",
        `A message can carry up to ${MAX_IMAGES_PER_PROMPT} images (this one had ${images.length}), so it was not sent.`,
      );
      return null;
    }
    const checked: ImageAttachment[] = [];
    const reasons: string[] = [];
    for (const image of images) {
      const check = checkImageAttachment(image);
      if (check.ok) checked.push({ ...image, mimeType: check.mimeType, size: check.size });
      else reasons.push(check.reason);
    }
    if (reasons.length > 0) {
      this.notice(session, "warning", `${reasons.join(" ")} The message was not sent.`);
      return null;
    }
    return checked;
  }

  /**
   * `session/prompt` for `session`, already echoed: flips the turn state and
   * reports the stop reason (or the failure) when the agent answers. `depth`
   * is the turn's agent-link chain depth (D30): 0 for what the user sent.
   */
  private async runTurn(agent: KiroAgent, session: ChatSession, blocks: acp.ContentBlock[], depth = 0): Promise<void> {
    session.turnGeneration++;
    const generation = session.turnGeneration;
    session.turnDepth = depth;
    session.lastFailure = null;
    this.setTurnActive(session, true);
    try {
      if (session.processLost !== null) {
        // Its process exited (D31): load it into a new one first. The turn
        // shows as running meanwhile, so what the user types queues behind it.
        const failure = await this.reloadSession(session);
        if (session.turnGeneration !== generation || this.sessions.get(session.id) !== session || session.closing) {
          return; // Stopped, closed or restarted while loading: nothing is sent.
        }
        if (failure !== null) {
          if (agent.status === "auth_required") {
            this.deps.output.appendLine(`[warn] session ${session.id} could not be loaded again, sign-in required: ${failure}`);
          } else {
            this.notice(
              session,
              "error",
              `Could not load this session into a new Kiro process: ${failure}. The message was not sent; start a new session to go on.`,
            );
          }
          this.endTurn(session, "error");
          return;
        }
      }
      const response = await agent.prompt(session.id, blocks);
      if (session.turnGeneration !== generation) {
        // Ended locally by the Stop watchdog (D27): a later turn may be running.
        session.abandonedTurn = false;
        this.deps.output.appendLine(`[info] session ${session.id}: late prompt response (${response.stopReason}) ignored`);
        return;
      }
      this.handleStopReason(session, response.stopReason);
    } catch (error) {
      const message = errorMessage(error);
      if (session.turnGeneration !== generation) {
        // Ended locally meanwhile: by the Stop watchdog (D27), or by the exit
        // of the session's process (D31), which already said so.
        session.abandonedTurn = false;
        this.deps.output.appendLine(`[info] session ${session.id}: late prompt failure ignored: ${message}`);
        return;
      }
      let failure: NoticeView | null = null;
      if (this.sessions.get(session.id) !== session || session.closing) {
        // Closing (its process is released right after the cancel, D31) or
        // replaced by a restart: nobody is left to tell.
        this.deps.output.appendLine(`[info] session ${session.id}: prompt of a closing session ended: ${message}`);
      } else if (agent.status === "auth_required") {
        // The sign-in banner (with the login button) already shows the reason.
        this.deps.output.appendLine(`[warn] session ${session.id} prompt rejected, sign-in required: ${message}`);
      } else {
        failure = this.notice(session, "error", `Prompt failed: ${message}`);
      }
      this.endTurn(session, "error");
      if (failure) session.lastFailure = { noticeId: failure.id, generation: session.turnGeneration, at: Date.now() };
    }
  }

  /**
   * Show the user's message locally (echoed `user_message_chunk`s are ignored,
   * see DECISIONS D13), optionally badged with its delivery state: the text,
   * one image per attachment (its thumbnail, D29), then one chip per context
   * chip, in the order of the prompt blocks. The text chunk is applied even
   * when empty (it renders nothing) so it opens the message. Returns the
   * message's view id (the id `chunk` / `messageDelivery` posts carry).
   */
  private echoUserMessage(
    session: ChatSession,
    text: string,
    chips: ContextChip[],
    delivery?: MessageDelivery,
    images: readonly ImageAttachment[] = [],
  ): string {
    const messageId = `user-${++session.userMessageSeq}`;
    const emitted = this.applyLocalUpdate(session, {
      sessionUpdate: "user_message_chunk",
      messageId,
      content: { type: "text", text },
    });
    const chunk = emitted.find((e): e is Extract<ToWebview, { type: "chunk" }> => e.type === "chunk");
    const viewId = chunk?.messageId ?? session.transcript.openMessage?.id ?? messageId;
    for (const image of images) {
      this.applyLocalUpdate(session, {
        sessionUpdate: "user_message_chunk",
        messageId,
        content: echoImageContent(image),
      });
    }
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
   * A refusal that lands after the steered turn ended (Stop, `/cancel`, an
   * error, or a normal end) still queues the message, so it goes out as the
   * next turn like any other queued prompt; it just does not mark steering
   * as unsupported, since such a refusal says nothing about that.
   */
  private async promptDuringTurn(
    agent: KiroAgent,
    session: ChatSession,
    text: string,
    chips: ContextChip[],
    blocks: acp.ContentBlock[],
    images: readonly ImageAttachment[] = [],
  ): Promise<void> {
    // While the turn waits for the session's reload into a new process (D31)
    // there is no process to steer: queue, without judging steering support.
    if (session.steerUnsupported || this.unhosted(session)) {
      const messageId = this.echoUserMessage(session, text, chips, "queued", images);
      this.deps.contextTracker.clearExplicit();
      this.enqueue(session, { text, chips, blocks, messageId, depth: 0 });
      return;
    }
    const messageId = this.echoUserMessage(session, text, chips, "steering", images);
    this.deps.contextTracker.clearExplicit();
    session.steering.add(messageId);
    const generation = session.turnGeneration;
    const params = { sessionId: session.id, prompt: blocks };
    this.deps.output.appendLine(`[info] steer ${session.id}: ${STEER_METHOD} ${safeJson(withoutImageData(params))}`);
    try {
      const result = await agent.callExtension(STEER_METHOD, params);
      this.deps.output.appendLine(`[info] steer ${session.id}: accepted ${safeJson(result)}`);
      // The user took part in this turn, so from here on it counts as one the
      // user started (D30): its agent messages start a new chain, as the
      // chain-stop notice and the docs promise ("send a message yourself").
      if (session.turnActive && session.turnGeneration === generation && session.turnDepth > 0) {
        this.deps.output.appendLine(
          `[info] agent-link ${session.handle}: chain depth ${session.turnDepth} -> 0 (the user steered the turn)`,
        );
        session.turnDepth = 0;
        session.chainStopNoted = -1;
      }
    } catch (error) {
      const code = error instanceof AcpError && error.code !== undefined ? ` (${error.code})` : "";
      this.deps.output.appendLine(
        `[info] steer ${session.id}: failed${code}: ${errorMessage(error)}; queueing mid-turn prompts instead`,
      );
      session.steering.delete(messageId);
      if (!this.sessions.has(session.id) || session.closing) {
        // The session is gone or on its way out: nothing may start a turn on it.
        this.setDelivery(session, messageId, null);
        return;
      }
      if (session.turnGeneration !== generation || !session.turnActive) {
        // The steered turn is over (cancelled, failed or ended): the refusal
        // says nothing about steering support. The message was typed and is
        // still undelivered, so it goes out as the next turn (Stop ends the
        // current answer only; what the user typed is not lost).
        this.deps.output.appendLine(`[info] steer ${session.id}: the turn ended before the refusal; sending as a prompt`);
      } else {
        session.steerUnsupported = true;
      }
      this.setDelivery(session, messageId, "queued");
      this.enqueue(session, { text, chips, blocks, messageId, depth: 0 });
    }
  }

  /** Hold `item` until the turn ends; sent right away when the turn ended meanwhile. */
  private enqueue(session: ChatSession, item: QueuedPrompt): void {
    if (session.closing) {
      this.setDelivery(session, item.messageId, null);
      this.discardQueue(session, 1);
      return;
    }
    session.queue.push(item);
    if (!session.turnActive) this.drainQueue(session);
  }

  /** Send the next queued prompt of an idle session as a turn of its own. */
  private drainQueue(session: ChatSession): void {
    if (session.turnActive || session.closing) return;
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
    // A queued peer message starts its turn at its own chain depth (D30).
    void this.runTurn(agent, session, next.blocks, next.depth);
  }

  /** Clear the badges of every queued prompt and forget them. Returns how many were dropped. */
  private discardRemaining(session: ChatSession): number {
    const dropped = session.queue.splice(0);
    for (const item of dropped) this.setDelivery(session, item.messageId, null);
    if (dropped.length > 0) this.notifyLinkWaiters();
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
   * agent went away): badges go, and the queue is dropped after an error,
   * else its first prompt starts the next turn (D22). A cancel (Stop,
   * `/cancel`) ends the current answer only: queued prompts still go out.
   */
  private endTurn(session: ChatSession, stopReason: acp.StopReason | "error"): void {
    session.turnGeneration++;
    if (session.cancelTimer) {
      clearTimeout(session.cancelTimer);
      session.cancelTimer = null;
    }
    this.setTurnActive(session, false, stopReason);
    this.clearSteering(session);
    if (stopReason === "error") {
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
    void this.pollContextUsage(session);
  }

  /**
   * After a turn, ask `_kiro/session/context` for the context-window numbers
   * when the agent never reported a percentage itself (D26). The first reply
   * per session is logged, to record its real shape; an agent that rejects
   * the method is not asked again until the next restart.
   */
  private async pollContextUsage(session: ChatSession): Promise<void> {
    const agent = this.agent;
    const method = this.agentInfo ? findExtension(this.slashContext(session.transcript), "context") : undefined;
    // A session no process hosts (D31) would fail the call without saying anything about the method.
    if (!agent || !method || this.contextPollUnsupported || session.closing || this.unhosted(session)) return;
    if (session.usage.contextPercent !== null) return;
    let result: unknown;
    try {
      result = await agent.callExtension(method, { sessionId: session.id });
    } catch (error) {
      this.contextPollUnsupported = true;
      this.deps.output.appendLine(`[info] ${method} after the turn failed: ${errorMessage(error)}; not polling again`);
      return;
    }
    if (!this.sessions.has(session.id)) return;
    if (!session.contextReplyLogged) {
      session.contextReplyLogged = true;
      this.deps.output.appendLine(`[info] session ${session.id} ${method} reply: ${truncate(safeJson(result), 2000)}`);
    }
    const usage = applyContextResult(session.usage, result);
    if (usage) {
      session.usage = usage;
      this.postTo(session.id, { type: "usage", usage });
    }
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
        // Only activity (messages, tool calls, plan) counts as "recent": the
        // metadata updates an agent sends right after `session/new` (available
        // commands, mode, config options) must not reorder the session list.
        const update = event.update;
        const replay = event.replay === true;
        if (replay && session.reload && isActivityUpdate(update)) {
          // History the new process replays while the session is loaded into
          // it after its old one exited (D31): the transcript shows it already.
          return;
        }
        if (session.abandonedTurn && !session.turnActive && !replay && isActivityUpdate(update)) {
          // The agent resumed streaming the turn the Stop watchdog ended (D27):
          // with no turn running, this is that turn's late output, not a reply.
          if (!session.abandonedDropLogged) {
            session.abandonedDropLogged = true;
            this.deps.output.appendLine(`[info] session ${session.id}: dropping late ${update.sessionUpdate} of the stopped turn`);
          }
          return;
        }
        if (isActivityUpdate(update)) session.touch();
        this.scheduleSessions();
        const usage = applyUsageUpdate(session.usage, update);
        if (usage) {
          session.usage = usage;
          this.postTo(session.id, { type: "usage", usage });
        }
        if (update.sessionUpdate === "session_info_update" && !replay) {
          // One example of every kind per session, to record the real shapes
          // (usage, turn metering, ...): the docs name the kinds, not the fields.
          const kind = kiroKind(update._meta) ?? (typeof update.title === "string" ? "title" : "untyped");
          if (!session.loggedInfoKinds.has(kind)) {
            session.loggedInfoKinds.add(kind);
            this.deps.output.appendLine(`[info] session ${session.id} session_info_update (${kind}): ${truncate(safeJson(update), 2000)}`);
          }
        }
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
      case "process_exited":
        this.onProcessExited(event.sessionIds, event.message);
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
    // A session that now waits for the user ends the waits on it (`needs_input`, D30).
    this.notifyLinkWaiters();
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
        await this.prompt(message.text, message.chips, sessionId ?? undefined, binding, message.images ?? []);
        return;
      case "pickImages":
        await this.pickImages(session ?? null, binding);
        return;
      case "dropFiles":
        await this.dropFiles(message.uris, session ?? null, binding);
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
      case "revealSession":
        this.revealSession(message.sessionId, binding);
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
    if (!(await this.ensureHosted(session))) return;
    try {
      await op(agent, session.id);
    } catch (error) {
      this.notice(session, "warning", errorMessage(error));
    }
  }

  /**
   * Before a request for `session` that is not a turn (mode, model, option,
   * extension method): load it into a new process first when its process
   * exited (D31). False, with a warning, when that failed.
   */
  private async ensureHosted(session: ChatSession): Promise<boolean> {
    if (!this.unhosted(session)) return true;
    const failure = await this.reloadSession(session);
    if (failure === null) return true;
    if (this.sessions.get(session.id) === session && !session.closing) {
      this.notice(session, "warning", `Could not load this session into a new Kiro process: ${failure}.`);
    }
    return false;
  }

  /**
   * Sign in with `methodId` (default: the first terminal method the agent
   * offers, else the fallback: `kiro-cli logout`, then `kiro-cli login` in a
   * terminal, i.e. a fresh sign-in, never a token refresh), then reconnect and
   * restore the sessions the chat views were showing (D25).
   */
  async login(methodId?: string): Promise<void> {
    await this.ensureStarted();
    const agent = this.agent;
    if (!agent) return;
    const id =
      methodId ??
      this.agentInfo?.authMethods.find((m) => "type" in m && m.type === "terminal")?.id ??
      FALLBACK_LOGIN_METHOD.id;
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
  // Image attachments (D29)
  // ---------------------------------------------------------------------

  /**
   * The composer's attach button: a file dialog for images. The ones that
   * pass the checks go back to the requesting view as `imagesAttached` (the
   * webview makes the previews), the others are named in one warning.
   */
  private async pickImages(session: ChatSession | null, view: ViewBinding | undefined): Promise<void> {
    if (!this.acceptsImages()) {
      this.notice(session, "info", "Kiro does not accept images.");
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: { Images: Object.keys(IMAGE_TYPE_BY_EXTENSION).map((ext) => ext.slice(1)) },
    });
    if (!uris || uris.length === 0) return;
    const images = await this.readImageFiles(uris, session);
    if (images.length > 0) this.postRequester(view, { type: "imagesAttached", images });
  }

  /**
   * URIs dropped on the composer (VS Code drags carry a uri-list, not the
   * bytes): image files (by extension) are read like picked ones; any other
   * `file:` URI naming a file becomes an `@` file chip. Folders, other
   * schemes and strings that do not parse are ignored.
   */
  private async dropFiles(
    uris: readonly string[],
    session: ChatSession | null,
    view: ViewBinding | undefined,
  ): Promise<void> {
    const imageUris: vscode.Uri[] = [];
    let refused = 0;
    let chips = 0;
    for (const raw of Array.isArray(uris) ? uris : []) {
      const uri = parseDroppedUri(raw);
      if (!uri) continue;
      if (imageTypeForName(uri.path)) {
        if (this.acceptsImages()) imageUris.push(uri);
        else refused++;
        continue;
      }
      if (uri.scheme !== "file" || !(await isFile(uri))) continue;
      this.deps.contextTracker.addFileChip(uri.fsPath);
      chips++;
    }
    if (refused > 0) {
      const what = refused === 1 ? "the image was" : `${refused} images were`;
      this.notice(session, "info", `Kiro does not accept images, so ${what} not attached.`);
    }
    const images = await this.readImageFiles(imageUris, session);
    if (images.length > 0) this.postRequester(view, { type: "imagesAttached", images });
    if (images.length > 0 || chips > 0) this.postRequester(view, { type: "focusInput" });
  }

  /**
   * Read picked or dropped image files: at most `MAX_IMAGES_PER_PROMPT` per
   * pick or drop (the composer enforces the total), each through
   * {@link readImageFile}. Every refusal is named in one warning on
   * `session` (every view without one).
   */
  private async readImageFiles(uris: readonly vscode.Uri[], session: ChatSession | null): Promise<ImageAttachment[]> {
    const images: ImageAttachment[] = [];
    const reasons: string[] = [];
    for (const uri of uris.slice(0, MAX_IMAGES_PER_PROMPT)) {
      const read = await this.readImageFile(uri);
      if (read.ok) images.push(read.image);
      else reasons.push(read.reason);
    }
    const extra = uris.length - MAX_IMAGES_PER_PROMPT;
    if (extra > 0) {
      const what = extra === 1 ? "1 more image was" : `${extra} more images were`;
      reasons.push(`${what} not attached: a message can carry up to ${MAX_IMAGES_PER_PROMPT} images.`);
    }
    if (reasons.length > 0) this.notice(session, "warning", reasons.join(" "));
    return images;
  }

  /**
   * One image file as an attachment (id `host-img-N`, `path` for `file:`
   * URIs): a file over `MAX_IMAGE_BYTES` is refused from its size without
   * being read; the bytes decide the type (`imageAttachmentFromBytes`).
   */
  private async readImageFile(uri: vscode.Uri): Promise<ImageRead> {
    const name = uri.path.slice(uri.path.lastIndexOf("/") + 1) || uri.toString(true);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) === 0) {
        return { ok: false, reason: `${name} was not attached: it is not a file.` };
      }
      const tooLarge =
        stat.size > MAX_IMAGE_BYTES ? imageRejection(name, imageTypeForName(name) ?? "", stat.size) : undefined;
      if (tooLarge) return { ok: false, reason: tooLarge };
      const bytes = await vscode.workspace.fs.readFile(uri);
      const filePath = uri.scheme === "file" ? uri.fsPath : undefined;
      return imageAttachmentFromBytes(`host-img-${++this.imageSeq}`, name, bytes, filePath);
    } catch (error) {
      return { ok: false, reason: `${name} was not attached: ${errorMessage(error)}` };
    }
  }

  /** Post to the view a request came from, or to every view when it came without one. */
  private postRequester(view: ViewBinding | undefined, message: ToWebview): void {
    if (view) this.postView(view, message);
    else this.postAll(message);
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
   * (advertised by the agent) return false so the text goes out as a prompt,
   * `images` included. `/plan <text>` sends `images` with its text; any
   * other command runs in the extension, so attached images are not sent and
   * an info notice says so once the command ran (D29).
   */
  private async runSlash(
    session: ChatSession,
    parsed: ParsedSlash,
    chips: ContextChip[],
    sender?: ViewBinding,
    images: readonly ImageAttachment[] = [],
  ): Promise<boolean> {
    const context = this.slashContext(session.transcript);
    const action = routeSlash(parsed, context);
    if (action.kind === "forward") return false;
    const sendsImages = action.kind === "plan" && action.modeId !== null && action.text !== "";
    const handled = await this.runSlashAction(session, parsed, action, context, chips, sender, sendsImages ? images : []);
    if (handled && images.length > 0 && !sendsImages) {
      // Told after the command: `/clear`, `/new` and `/restart` change the session the view shows.
      const shown = sender?.sessionId ? this.sessions.get(sender.sessionId) : undefined;
      const what = images.length === 1 ? "The image was" : `The ${images.length} images were`;
      this.notice(
        shown ?? this.sessions.get(session.id) ?? null,
        "info",
        `${what} not sent: /${parsed.name} runs in the extension.`,
      );
    }
    return handled;
  }

  private async runSlashAction(
    session: ChatSession,
    parsed: ParsedSlash,
    action: SlashAction,
    context: SlashContext,
    chips: ContextChip[],
    sender: ViewBinding | undefined,
    images: readonly ImageAttachment[],
  ): Promise<boolean> {
    const raw = `/${parsed.name}${parsed.args ? ` ${parsed.args}` : ""}`;
    const agent = this.agent;
    const sessionId = session.id;
    const asksAgent =
      action.kind === "set_mode" || action.kind === "set_config" || action.kind === "extension" || action.kind === "plan";
    if (asksAgent && agent && this.unhosted(session)) {
      // Its process exited (D31): load it into a new one before asking.
      const failure = await this.reloadSession(session);
      if (failure !== null) {
        this.localExchange(session, raw, `Could not load this session into a new Kiro process: ${failure}`);
        return true;
      }
    }
    switch (action.kind) {
      case "forward":
        return false;
      case "new_session": {
        // `/clear` and `/new`: a new session in the view the command came from
        // (else the focused view, else any view) when it displays this session.
        // `/clear` replaces the session: its queue is discarded and its turn
        // cancelled first (nothing may start another turn on it meanwhile),
        // then the old session is forgotten locally so the tab starts over
        // with a single clean session (the agent keeps its history, D20).
        // `/new` leaves the old session alone, running turn and queue included.
        const displays = (v: ViewBinding | null | undefined): ViewBinding | undefined =>
          v && !v.follows && v.displayed === sessionId ? v : undefined;
        const view =
          displays(sender) ?? displays(this.focusedView) ?? [...this.views].find((v) => displays(v) !== undefined);
        if (!action.replace) {
          await this.newSession(view);
          return true;
        }
        session.closing = true;
        this.discardQueue(session, this.discardRemaining(session));
        if (session.turnActive) await this.cancel(sessionId);
        const replacement = (async (): Promise<string | null> => {
          const created = await this.newSession(view);
          if (created !== null && created !== sessionId) {
            await this.closeSession(sessionId);
            return created;
          }
          session.closing = false; // the replacement failed: the session stays usable
          this.notifyLinkWaiters(); // a wait on it goes on judging it (D30)
          return null;
        })();
        session.replacement = replacement;
        try {
          await replacement;
        } finally {
          session.replacement = null;
        }
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
          await this.prompt(action.text, chips, sessionId, undefined, images);
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
    lines.push("", ...this.describeProcesses(session));
    lines.push("", `Remembered for new sessions: ${this.describeRememberedOptions()}`);
    lines.push("", `Agent link: ${this.describeAgentLink()}`);
    return lines.join("\n");
  }

  /**
   * `/capabilities`: `Processes: N running (max M)`, then one line per
   * kiro-cli process (D31): its number, pid and the handles of its sessions
   * (this session marked), or `spare`.
   */
  private describeProcesses(session: ChatSession): string[] {
    const processes = this.agentProcesses();
    const max = this.agentProcessLimit() ?? this.agentProcessesMax();
    const lines = [`**Processes:** ${processes.length} running (max ${max}, \`kiroAcp.agentProcesses.max\`)`];
    for (const p of processes) {
      const hosted = p.sessionIds.map((id) => {
        const handle = this.sessions.get(id)?.handle ?? id;
        return id === session.id ? `${handle} (this session)` : handle;
      });
      const what = [...hosted, ...(p.spare ? ["spare"] : [])].join(", ") || "idle";
      const status = p.status === "ready" ? "" : `, ${p.status}`;
      lines.push(`- process ${p.id} (pid ${p.pid ?? "unknown"}${status}): ${what}`);
    }
    if (this.unhosted(session)) {
      lines.push(`- this session: no process (its process exited; the next message loads it again)`);
    }
    return lines;
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
    // No agent: every pending wait ends `closed` now, its timer cleared (D30).
    for (const waiter of [...this.linkWaiters]) waiter.check();
    void this.stopAgentLink("disposed");
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

/** Session-metadata updates that say nothing about when the session was last used. */
const METADATA_UPDATES = new Set<string>([
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);

function isActivityUpdate(update: acp.SessionUpdate): boolean {
  return !METADATA_UPDATES.has(update.sessionUpdate);
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

/** A peer message as the confirmation card quotes it (D30): whitespace collapsed, ~80 characters, in quotes. */
function confirmSnippet(text: string): string {
  // By code point, so the cut never splits a surrogate pair.
  const chars = [...text.replace(/\s+/g, " ").trim()];
  const cut =
    chars.length <= CONFIRM_SNIPPET_MAX ? chars.join("") : `${chars.slice(0, CONFIRM_SNIPPET_MAX - 1).join("").trimEnd()}…`;
  return JSON.stringify(cut);
}

/** What an aborted `signal` rejects with: its reason when it is an error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("The call was cancelled.");
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

/** A dropped URI string as a `vscode.Uri`; `undefined` when it does not parse (no scheme, junk). */
function parseDroppedUri(raw: unknown): vscode.Uri | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    return vscode.Uri.parse(raw.trim(), true);
  } catch {
    return undefined;
  }
}

/** True when `uri` names an existing file (not a folder). */
async function isFile(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
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

/** Prompt params for the output channel: each image's base64 payload replaced by its size (D29). */
function withoutImageData(params: { sessionId: string; prompt: acp.ContentBlock[] }): unknown {
  return {
    ...params,
    prompt: params.prompt.map((block) =>
      block.type === "image" ? { ...block, data: `<${formatBytes(base64Size(block.data))} of base64>` } : block,
    ),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}
