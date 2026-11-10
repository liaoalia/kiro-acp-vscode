/**
 * Public contract of the ACP layer.
 *
 * Everything in `src/acp/` is independent of the `vscode` module so it can be
 * unit-tested against a fake agent. The host (extension) implements
 * {@link ClientServices}; the ACP layer implements {@link KiroAgent}.
 */
import type * as acp from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface ProtocolLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Raw JSON-RPC traffic. Only called when protocol logging is enabled. */
  trace?(direction: "send" | "recv" | "stderr", payload: string): void;
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

export interface AgentProcessOptions {
  /** Resolved executable path or bare command name. */
  command: string;
  /** Full argument list, e.g. ["acp", "--agent-engine=v3"]. */
  args: string[];
  /** Working directory for the child; usually the workspace root. */
  cwd: string;
  /** Environment for the child. Pass `process.env` so proxy variables flow through. */
  env: NodeJS.ProcessEnv;
  logger: ProtocolLogger;
}

// ---------------------------------------------------------------------------
// Host services (implemented by the VS Code side, called by the ACP layer)
// ---------------------------------------------------------------------------

export interface ClientServices {
  requestPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  readTextFile(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(request: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  createTerminal(request: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  terminalOutput(request: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse>;
  waitForTerminalExit(
    request: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse>;
  killTerminal(request: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse>;
  releaseTerminal(request: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse>;
  /**
   * Kiro extension `_kiro/openExternalUrl` (used for MCP OAuth). The host
   * should confirm with the user and hand the URL to the OS browser.
   * Optional: when absent the request is answered with -32601.
   */
  openExternalUrl?(url: string): Promise<void>;
  /**
   * Run a terminal-type auth method (e.g. Kiro's "Log in to Kiro") in a
   * terminal the user can see. `executable` is the resolved kiro-cli path;
   * `method.args`/`method.env` come from the agent. Resolves when the user
   * acknowledges completion (the host then restarts the agent process).
   */
  runTerminalAuth?(
    method: acp.AuthMethodTerminal & { type: "terminal" },
    executable: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionStatus =
  | "stopped"
  | "starting"
  | "ready"
  /** Agent answered initialize but requires sign-in before sessions work. */
  | "auth_required"
  | "error";

export interface AgentInfo {
  protocolVersion: number;
  agentCapabilities: acp.AgentCapabilities;
  agentInfo: acp.Implementation | null;
  authMethods: acp.AuthMethod[];
  /** `agentCapabilities._meta.kiro.extensionMethods` when advertised (CLI V3). */
  kiroExtensionMethods: string[];
}

export interface ConnectionStateChange {
  status: ConnectionStatus;
  agent?: AgentInfo;
  /** Human-readable reason for `error` / `stopped`. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Session-level state reported by `session/new` and later updates. */
export interface SessionState {
  sessionId: string;
  cwd: string;
  modes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[] | null;
  /**
   * Unstable ACP v1 model state (`models` on NewSessionResponse) used by the
   * CLI v2 server together with `session/set_model`. Null when not advertised.
   */
  models: ModelState | null;
  availableCommands: acp.AvailableCommand[];
  /** Raw `_meta` of the session/new response (Kiro puts extra state here). */
  meta: Record<string, unknown> | null;
}

export interface ModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string; description?: string | null }>;
}

export type SessionEvent =
  | { type: "update"; sessionId: string; update: acp.SessionUpdate }
  | { type: "turn_started"; sessionId: string }
  | { type: "turn_finished"; sessionId: string; stopReason: acp.StopReason }
  | { type: "turn_failed"; sessionId: string; error: string }
  | { type: "state"; session: SessionState }
  /** Any `_kiro…` notification the layer does not interpret. Surfaced for the log/UI. */
  | { type: "extension_notification"; method: string; params: unknown };

export type Unsubscribe = () => void;

/**
 * Facade over one `kiro-cli acp` process. One process hosts one or more
 * sessions; the extension uses one session at a time.
 */
export interface KiroAgent {
  readonly status: ConnectionStatus;
  readonly agent: AgentInfo | null;

  /** Spawn the process and run `initialize`. Resolves when the agent answered. */
  start(): Promise<AgentInfo>;
  /** Kill the process; pending requests are rejected. Idempotent. */
  stop(): Promise<void>;

  onConnectionChange(listener: (change: ConnectionStateChange) => void): Unsubscribe;
  onSessionEvent(listener: (event: SessionEvent) => void): Unsubscribe;

  newSession(cwd: string, options?: { mcpServers?: acp.McpServer[]; meta?: Record<string, unknown> }): Promise<SessionState>;
  /**
   * Send a prompt. Resolves with the final stop reason once the agent answers
   * `session/prompt`; updates stream through {@link onSessionEvent}.
   */
  prompt(sessionId: string, content: acp.ContentBlock[]): Promise<acp.PromptResponse>;
  /** Send `session/cancel`; pending permission requests resolve `cancelled`. */
  cancel(sessionId: string): Promise<void>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<acp.SessionConfigOption[]>;
  /** CLI v2 only (`session/set_model`). Rejects when the agent did not advertise models. */
  setModel(sessionId: string, modelId: string): Promise<void>;
  /** Run an advertised auth method. Terminal methods are delegated back to the host. */
  authenticate(methodId: string): Promise<void>;
  /** Call a Kiro extension method advertised in `kiroExtensionMethods`. */
  callExtension<T = unknown>(method: string, params: unknown): Promise<T>;
}

/** Thrown by the ACP layer for well-known protocol failures. */
export class AcpError extends Error {
  constructor(
    message: string,
    public readonly code: number | undefined = undefined,
    public readonly data: unknown = undefined,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/** JSON-RPC error code Kiro returns while signed out (recorded from the real CLI if different). */
export const AUTH_REQUIRED_CODE = -32000;
