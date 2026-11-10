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
}
export type MessageSegment = TextSegment | ResourceSegment | ImageSegment;

export interface MessageView {
  id: string;
  role: MessageRole;
  segments: MessageSegment[];
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

export interface PermissionView {
  requestId: string;
  toolCallId: string;
  title: string;
  kind: ToolKind;
  options: PermissionOptionView[];
  /** True when the tool call carries diff content (a diff editor may be open). */
  hasDiff: boolean;
  /** Kiro V3 consent context when present. */
  consent?: { capability?: string; resource?: string; persistableConsent?: boolean };
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
  sessionId: string | null;
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
  /** Host-side display preferences (defaults; the webview may override locally). */
  prefs?: {
    /** Show the mode/model/config pickers without pressing the settings toggle. */
    showSettings: boolean;
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
  | { type: "session"; sessionId: string | null }
  | { type: "turn"; active: boolean; stopReason?: string }
  | { type: "chunk"; messageId: string; role: MessageRole; segment: MessageSegment }
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
  | { type: "focusInput" };

// ---------------------------------------------------------------------------
// Webview → Extension
// ---------------------------------------------------------------------------

export type FromWebview =
  | { type: "ready" }
  | { type: "prompt"; text: string; chips: ContextChip[] }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "restart" }
  | { type: "login"; methodId: string }
  | { type: "permissionResponse"; requestId: string; optionId: string }
  /** Client-side policy: remember this choice for the rest of the session for the tool kind. */
  | { type: "permissionAlways"; requestId: string; decision: "allow" | "reject" }
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
