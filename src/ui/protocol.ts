/**
 * Message protocol between the extension host and the chat webview.
 *
 * The webview never talks to the agent process. It only renders state sent
 * by the extension and reports user intents back. Keep this file free of
 * `vscode` and Node imports: it is compiled into both bundles.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export type ConnectionStatus = "stopped" | "starting" | "ready" | "auth_required" | "error";

export interface AuthMethodView {
  id: string;
  name: string;
  description?: string | null;
  /** `true` when choosing it opens a terminal the user must complete. */
  terminal: boolean;
}

export interface ConnectionView {
  status: ConnectionStatus;
  agentName?: string;
  agentVersion?: string;
  message?: string;
  authMethods?: AuthMethodView[];
  /** The agent advertised `session/list` + `session/load`, so a history button makes sense. */
  canBrowseSessions?: boolean;
  /**
   * The agent advertised `promptCapabilities.image`: the composer offers image
   * attachments (paste, drop, attach button). ACP forbids image blocks otherwise (D29).
   */
  acceptsImages?: boolean;
}

/**
 * An image attached in the composer and sent with a prompt as an ACP `image`
 * content block (D29). Rules (types, size, count) live in `src/ui/images.ts`.
 */
export interface ImageAttachment {
  /** Unique within the composer; never sent to the agent. */
  id: string;
  /** File name, or a generated one for a pasted image ("Pasted image 1.png"). */
  name: string;
  /** One of `ACCEPTED_IMAGE_TYPES`; the host re-checks it against the bytes. */
  mimeType: string;
  /** The image bytes, base64 without a `data:` prefix. */
  data: string;
  /** Decoded size in bytes. */
  size: number;
  /** Absolute path when the image came from a file (picked or dropped). */
  path?: string;
  /**
   * Small `data:` URL thumbnail made by the webview; shown on the composer
   * tile and, after sending, in the user's message instead of the full image.
   */
  preview?: string;
}

export interface ContextChip {
  id: string;
  kind: "file" | "selection";
  /** Absolute path. */
  path: string;
  /** Workspace-relative label, e.g. `src/app.ts`. */
  label: string;
  /** 1-based inclusive line range for selections. */
  startLine?: number;
  endLine?: number;
  /** The active-file chip is implicit and can be removed; `@` chips are explicit. */
  implicit: boolean;
}

export type MessageRole = "user" | "agent" | "thought";

export interface TextSegment {
  type: "text";
  text: string;
}
export interface ResourceSegment {
  type: "resource";
  uri: string;
  label: string;
}
export interface ImageSegment {
  type: "image";
  mimeType: string;
  /** File name when known (from the block's `uri`). */
  name?: string;
  /**
   * `data:` URL to show (a thumbnail for echoed prompts, the image itself when
   * small); absent when too large or unknown, then an "[image]" chip is shown.
   * Always passes `isSafeImageDataUrl`.
   */
  src?: string;
}
export type MessageSegment = TextSegment | ResourceSegment | ImageSegment;

/**
 * Delivery state of a user message typed while a turn was running:
 * `steering` = sent to the agent mid-turn (`_session/steer`) and not yet
 * injected; `queued` = held by the extension until the turn ends, then sent
 * as a normal prompt. Absent/undefined = delivered normally.
 */
export type MessageDelivery = "steering" | "queued";

export interface MessageView {
  id: string;
  role: MessageRole;
  segments: MessageSegment[];
  delivery?: MessageDelivery;
}

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface ToolTextContent {
  type: "text";
  text: string;
}
export interface ToolDiffContent {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}
export interface ToolTerminalContent {
  type: "terminal";
  terminalId: string;
  output: string;
  exitCode?: number | null;
}
export type ToolContentView = ToolTextContent | ToolDiffContent | ToolTerminalContent;

export interface ToolCallView {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolStatus;
  content: ToolContentView[];
  locations: Array<{ path: string; line?: number | null }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Set while a permission request for this call is waiting for the user. */
  pendingPermissionId?: string;
  /** `_meta.kiro.failureReason` when present. */
  failureReason?: string;
}

export interface PlanEntryView {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type PermissionScope = "kind" | "capability" | "resource";

export interface PermissionView {
  requestId: string;
  toolCallId: string;
  title: string;
  /** Resolved tool kind (from the request, else from the known tool call). */
  kind: ToolKind;
  options: PermissionOptionView[];
  /** True when the tool call carries diff content (a diff editor may be open). */
  hasDiff: boolean;
  /** Kiro V3 consent context when present. */
  consent?: { capability?: string; resource?: string; persistableConsent?: boolean };
  /**
   * Client-side "always" policies the host can offer for this request, with
   * ready-made labels (e.g. "Allow all edits this session",
   * "Allow all changes to tasks.json this session").
   */
  policies?: Array<{ scope: PermissionScope; label: string; rejectLabel: string }>;
}

export interface ModeView {
  id: string;
  name: string;
  description?: string | null;
}

export interface ConfigOptionView {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select" | "boolean";
  currentValue: string | boolean;
  /** Flattened for select options; groups are flattened with a `group` label. */
  options?: Array<{ value: string; name: string; description?: string | null; group?: string }>;
}

export interface ModelView {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string; description?: string | null }>;
}

export interface CommandView {
  name: string;
  description: string;
  hint?: string;
}

/** Per-session status shown in the session panel. */
export type SessionStatus =
  /** No turn running, nothing pending. */
  | "idle"
  /** A prompt turn is in progress. */
  | "running"
  /** Waiting for the user: a permission request is pending. */
  | "needs_input"
  /** The agent process is stopped or crashed; every session is unusable until restart. */
  | "error";

/**
 * Context-window / token usage of a session, from whichever updates the agent
 * sends (ACP `usage_update`, Kiro `context_usage` / `turn_completion`; D26).
 * Every field is `null` until reported.
 */
export interface SessionUsage {
  /** Share of the context window in use, 0-100. */
  contextPercent: number | null;
  /** Tokens currently in context / the window size. */
  contextUsed: number | null;
  contextSize: number | null;
  /** Tokens spent by the session so far (summed over the agent's turn summaries). */
  tokensSpent: number | null;
  /** Cumulative cost reported by the agent (`usage_update.cost`). */
  cost: { amount: number; currency: string } | null;
}

export interface SessionSummary {
  id: string;
  /** First user message (truncated) or the title the agent reported; "New session" until then. */
  title: string;
  status: SessionStatus;
  /** Epoch ms of the last activity, for ordering. */
  updatedAt: number;
}

export interface TranscriptItemMessage {
  type: "message";
  message: MessageView;
}
export interface TranscriptItemTool {
  type: "tool";
  toolCallId: string;
}
export type TranscriptItem = TranscriptItemMessage | TranscriptItemTool;

/** Full state snapshot; sent on webview (re)load and after a new session. */
export interface UiState {
  connection: ConnectionView;
  /**
   * The host accepts prompts while a turn is running (steering or queueing),
   * so the composer must stay enabled; when false the webview disables Send
   * during a turn (legacy behaviour).
   */
  acceptsPromptsDuringTurn?: boolean;
  /** The session this webview currently displays; all other fields describe it. */
  sessionId: string | null;
  /**
   * The sessions this webview can switch between, most recent first: the
   * sessions of its group (one group per chat tab, one for the sidebar) or,
   * for a view without a group, every live session of the agent process.
   */
  sessions: SessionSummary[];
  turnActive: boolean;
  items: TranscriptItem[];
  toolCalls: Record<string, ToolCallView>;
  plan: PlanEntryView[];
  permissions: PermissionView[];
  modes: { currentModeId: string; availableModes: ModeView[] } | null;
  configOptions: ConfigOptionView[];
  models: ModelView | null;
  commands: CommandView[];
  chips: ContextChip[];
  /** Transient notices (errors, refusal, max_tokens, ...). */
  notices: NoticeView[];
  /** Usage of the displayed session once the agent reported any (D26); absent/null until then. */
  usage?: SessionUsage | null;
  /**
   * When the displayed session last changed (ms since the epoch): a prompt
   * sent, a chunk, a tool call, a permission request. The working strip shows
   * "no reply for N min" from it while a turn runs. The snapshot carries the
   * host's `ChatSession.updatedAt`; the webview restamps it on the session
   * messages that changed its state (chunks, tool calls, plan, permissions,
   * turn, usage, delivery) and clears it when the session switches.
   */
  lastActivityAt?: number | null;
  /** Host-side display preferences (defaults; the webview may override locally). */
  prefs?: {
    /** Show the mode/model/config pickers without pressing the settings toggle. */
    showSettings: boolean;
    /** Start with the session panel collapsed to icons. */
    sessionPanelCollapsed?: boolean;
  };
}

export interface NoticeView {
  id: string;
  severity: "info" | "warning" | "error";
  text: string;
}

export interface FileSuggestion {
  path: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Extension → Webview
// ---------------------------------------------------------------------------

export type ToWebview =
  | { type: "state"; state: UiState }
  | { type: "connection"; connection: ConnectionView }
  /**
   * The displayed session changed (or ended when null). A `state` snapshot
   * for the new session always follows, so the webview just resets.
   */
  | { type: "session"; sessionId: string | null }
  /** The session list changed (new/closed session, status or title update). */
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "turn"; active: boolean; stopReason?: string }
  | { type: "chunk"; messageId: string; role: MessageRole; segment: MessageSegment }
  /** Update (or clear with `null`) the delivery badge of a user message. */
  | { type: "messageDelivery"; messageId: string; delivery: MessageDelivery | null }
  | { type: "toolCall"; call: ToolCallView }
  | { type: "plan"; entries: PlanEntryView[] }
  | { type: "permission"; request: PermissionView }
  | { type: "permissionResolved"; requestId: string }
  | { type: "modes"; modes: UiState["modes"] }
  | { type: "configOptions"; options: ConfigOptionView[] }
  | { type: "models"; models: ModelView | null }
  | { type: "commands"; commands: CommandView[] }
  | { type: "chips"; chips: ContextChip[] }
  | { type: "fileSuggestions"; query: string; items: FileSuggestion[] }
  | { type: "notice"; notice: NoticeView }
  | { type: "clearNotice"; id: string }
  /** Context / token usage of the displayed session changed (D26). */
  | { type: "usage"; usage: SessionUsage | null }
  | { type: "focusInput" }
  /**
   * Images read by the host for `pickImages` / `dropFiles`, posted to the
   * requesting view only; the webview adds them to the composer (making the
   * previews itself). Rejected files were already reported as a notice.
   */
  | { type: "imagesAttached"; images: ImageAttachment[] };

// ---------------------------------------------------------------------------
// Webview → Extension
// ---------------------------------------------------------------------------

export type FromWebview =
  | { type: "ready" }
  /** `images`: composer attachments, sent as `image` blocks after the text (D29). */
  | { type: "prompt"; text: string; chips: ContextChip[]; images?: ImageAttachment[] }
  | { type: "cancel" }
  /** Attach button: the host opens a file dialog and answers with `imagesAttached`. */
  | { type: "pickImages" }
  /**
   * URIs dropped on the composer (VS Code explorer drags carry a uri-list, not
   * the bytes): image files are read and answered with `imagesAttached`, other
   * `file:` URIs become `@` file chips.
   */
  | { type: "dropFiles"; uris: string[] }
  /** Create a new session and display it in this webview. */
  | { type: "newSession" }
  /** Display an existing session in this webview. */
  | { type: "selectSession"; sessionId: string }
  /** Close (forget) a session; if it is displayed, the webview shows the next one. */
  | { type: "closeSession"; sessionId: string }
  /** Open the host's picker of past sessions (`session/list`); the chosen one is loaded into this webview. */
  | { type: "browseSessions" }
  | { type: "restart" }
  | { type: "login"; methodId: string }
  | { type: "permissionResponse"; requestId: string; optionId: string }
  /**
   * Client-side policy: remember this choice for the rest of the session.
   * `scope` selects the key: `kind` (tool kind, default), `capability`
   * (Kiro consent capability such as `fs_write`), or `resource` (the exact
   * consent resource, e.g. one file path).
   */
  | { type: "permissionAlways"; requestId: string; decision: "allow" | "reject"; scope?: PermissionScope }
  | { type: "setMode"; modeId: string }
  | { type: "setConfigOption"; configId: string; value: string | boolean }
  | { type: "setModel"; modelId: string }
  | { type: "queryFiles"; query: string }
  | { type: "removeChip"; id: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; toolCallId: string; index: number }
  | { type: "showTerminal"; terminalId: string }
  | { type: "openPlan" }
  | { type: "showLog" };
