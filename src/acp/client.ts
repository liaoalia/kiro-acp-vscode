/**
 * `KiroAgentImpl`: the ACP client facade over one `kiro-cli acp` process.
 *
 * Built on the official SDK (`@agentclientprotocol/sdk`, v1 stable). No
 * `vscode` import; the host supplies {@link ClientServices}.
 */
import * as acp from "@agentclientprotocol/sdk";
import {
  resolveCliPath,
  spawnAgentProcess,
  terminateProcess,
  type AgentChildProcess,
} from "./process.js";
import { createChildStream, interceptNotifications, readLines } from "./stream.js";
import {
  AcpError,
  type AgentInfo,
  type AgentProcessOptions,
  type ClientServices,
  type ConnectionStateChange,
  type ConnectionStatus,
  FALLBACK_LOGIN_METHOD,
  isAuthRequiredError,
  type KiroAgent,
  type ModelState,
  type SessionEvent,
  type SessionListEntry,
  type SessionState,
  type Unsubscribe,
} from "./types.js";

export const CLIENT_NAME = "kiro-acp-vscode";
export const CLIENT_TITLE = "Kiro ACP Chat for VS Code";

/** Kiro CLI v2 notification carrying the slash-command catalogue. */
export const KIRO_V2_COMMANDS_AVAILABLE = "_kiro.dev/commands/available";
/** Kiro extension request asking the client to open a URL (MCP OAuth). */
export const KIRO_OPEN_EXTERNAL_URL = "_kiro/openExternalUrl";
/** Unstable ACP v1 model selection used by the CLI v2 server. */
export const SESSION_SET_MODEL = "session/set_model";

const KNOWN_SESSION_UPDATES: ReadonlySet<string> = new Set<acp.SessionUpdate["sessionUpdate"]>([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "notice",
  "compaction_update",
  "compaction_summary_chunk",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convert any thrown value into an {@link AcpError}, preserving JSON-RPC code/data. */
export function toAcpError(error: unknown, fallback = "ACP request failed"): AcpError {
  if (error instanceof AcpError) return error;
  if (error instanceof acp.RequestError) return new AcpError(error.message, error.code, error.data);
  if (isRecord(error) && typeof error.code === "number" && typeof error.message === "string") {
    return new AcpError(error.message, error.code, error.data);
  }
  if (error instanceof Error) return new AcpError(error.message || fallback);
  return new AcpError(typeof error === "string" && error ? error : fallback);
}

function isTerminalMethod(method: acp.AuthMethod): method is acp.AuthMethodTerminal & { type: "terminal" } {
  return "type" in method && method.type === "terminal";
}

export function readKiroExtensionMethods(capabilities: acp.AgentCapabilities | undefined): string[] {
  const meta = capabilities?._meta;
  if (!isRecord(meta)) return [];
  const kiro = meta.kiro;
  if (!isRecord(kiro)) return [];
  const methods = kiro.extensionMethods;
  if (!Array.isArray(methods)) return [];
  return methods.filter((m): m is string => typeof m === "string");
}

/** Read the unstable `models` field of a `session/new` response defensively. */
export function readModelState(raw: unknown): ModelState | null {
  if (!isRecord(raw)) return null;
  const models = raw.models;
  if (!isRecord(models)) return null;
  const currentModelId = models.currentModelId;
  if (typeof currentModelId !== "string") return null;
  const available = Array.isArray(models.availableModels) ? models.availableModels : [];
  const availableModels: ModelState["availableModels"] = [];
  for (const entry of available) {
    if (!isRecord(entry) || typeof entry.modelId !== "string") continue;
    availableModels.push({
      modelId: entry.modelId,
      name: typeof entry.name === "string" ? entry.name : entry.modelId,
      description: typeof entry.description === "string" ? entry.description : null,
    });
  }
  return { currentModelId, availableModels };
}

export function buildSessionState(cwd: string, response: acp.NewSessionResponse): SessionState {
  return {
    sessionId: response.sessionId,
    cwd,
    modes: response.modes ?? null,
    configOptions: response.configOptions ?? null,
    models: readModelState(response),
    availableCommands: [],
    meta: isRecord(response._meta) ? response._meta : null,
  };
}

/** Map one `session/list` entry defensively (missing optional fields become null). */
export function readSessionListEntry(raw: unknown): SessionListEntry | null {
  if (!isRecord(raw) || typeof raw.sessionId !== "string") return null;
  return {
    sessionId: raw.sessionId,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    title: typeof raw.title === "string" ? raw.title : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

/** True when a `session/update` carries Kiro's `_meta.kiro.replay: true` marker. */
export function isReplayUpdate(update: unknown): boolean {
  if (!isRecord(update)) return false;
  const meta = update._meta;
  if (!isRecord(meta)) return false;
  const kiro = meta.kiro;
  return isRecord(kiro) && kiro.replay === true;
}

/** Best-effort mapping of Kiro v2 `_kiro.dev/commands/available` params. */
export function mapV2Commands(params: unknown): { sessionId: string | null; commands: acp.AvailableCommand[] } | null {
  if (!isRecord(params)) return null;
  const list = Array.isArray(params.commands)
    ? params.commands
    : Array.isArray(params.availableCommands)
      ? params.availableCommands
      : null;
  if (!list) return null;
  const commands: acp.AvailableCommand[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const command: acp.AvailableCommand = {
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
    };
    if (isRecord(item.input) && typeof item.input.hint === "string") {
      command.input = { hint: item.input.hint };
    } else if (typeof item.hint === "string") {
      command.input = { hint: item.hint };
    }
    commands.push(command);
  }
  return { sessionId: typeof params.sessionId === "string" ? params.sessionId : null, commands };
}

export class KiroAgentImpl implements KiroAgent {
  private _status: ConnectionStatus = "stopped";
  private _agent: AgentInfo | null = null;
  private child: AgentChildProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  private resolvedCommand: string | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, SessionState>();
  /** Session ids whose `session/load` is in flight: their updates are replayed history. */
  private readonly loadingSessions = new Set<string>();
  private lastSessionId: string | null = null;
  private readonly pendingPermissions = new Map<string, Set<AbortController>>();
  private readonly connectionListeners = new Set<(change: ConnectionStateChange) => void>();
  private readonly sessionListeners = new Set<(event: SessionEvent) => void>();

  constructor(
    private readonly options: AgentProcessOptions,
    private readonly services: ClientServices,
  ) {}

  get status(): ConnectionStatus {
    return this._status;
  }

  get agent(): AgentInfo | null {
    return this._agent;
  }

  /** Snapshot of the known session state (null when unknown). */
  getSession(sessionId: string): SessionState | null {
    return this.sessions.get(sessionId) ?? null;
  }

  onConnectionChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  onSessionEvent(listener: (event: SessionEvent) => void): Unsubscribe {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<AgentInfo> {
    if (this.connection && this._agent) return this._agent;
    if (this.stopPromise) await this.stopPromise;
    const { logger } = this.options;
    this.stopping = false;
    this.setStatus("starting");

    const command = await resolveCliPath(this.options.command);
    this.resolvedCommand = command;
    logger.info(`Starting agent: ${command} ${this.options.args.join(" ")}`.trim());

    let child: AgentChildProcess;
    try {
      child = spawnAgentProcess({
        command,
        args: this.options.args,
        cwd: this.options.cwd,
        env: this.options.env,
      });
    } catch (error) {
      const err = toAcpError(error, "failed to spawn agent");
      this.setStatus("error", { message: `Failed to start ${command}: ${err.message}` });
      throw err;
    }
    this.child = child;

    let spawnFailed: Error | null = null;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error: Error) => {
        spawnFailed = error;
        reject(error);
      });
    });
    spawned.catch(() => undefined);
    child.on("error", (error: Error) => {
      logger.error(`Agent process error: ${error.message}`);
    });
    child.stdin.on("error", (error: Error) => {
      logger.warn(`Agent stdin error: ${error.message}`);
    });
    readLines(child.stderr, (line) => {
      logger.trace?.("stderr", line);
      if (line.trim().length > 0) logger.warn(`[kiro-cli] ${line}`);
    });
    child.on("exit", (code, signal) => this.handleExit(child, code, signal));

    try {
      await spawned;
    } catch (error) {
      this.child = null;
      const err = toAcpError(spawnFailed ?? error, "failed to spawn agent");
      this.setStatus("error", { message: `Failed to start ${command}: ${err.message}` });
      throw err;
    }

    const stream = interceptNotifications(createChildStream(child, logger), (method, params) => {
      if (method === acp.methods.client.session.update) {
        this.handleSessionUpdate(params);
        return true;
      }
      if (method.startsWith("_")) {
        this.handleUnknownNotification(method, params);
        return true;
      }
      return false;
    });
    const connection = this.buildClientApp().connect(stream);
    this.connection = connection;
    void connection.closed.then(() => this.handleConnectionClosed(connection));

    const version = this.options.clientVersion ?? "0.0.0";
    const initParams: acp.InitializeRequest = {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        auth: { terminal: true },
        _meta: { kiro: { openExternalUrl: true }, "terminal-auth": true },
      },
      clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version },
    };

    let response: acp.InitializeResponse;
    try {
      response = await connection.agent.request(acp.methods.agent.initialize, initParams);
    } catch (error) {
      const err = toAcpError(error, "initialize failed");
      logger.error(`initialize failed: ${err.message}`);
      await this.stop();
      this.setStatus("error", { message: `initialize failed: ${err.message}` });
      throw err;
    }

    const agentCapabilities = response.agentCapabilities ?? {};
    const info: AgentInfo = {
      protocolVersion: response.protocolVersion,
      agentCapabilities,
      agentInfo: response.agentInfo ?? null,
      authMethods: response.authMethods ?? [],
      kiroExtensionMethods: readKiroExtensionMethods(agentCapabilities),
    };
    this._agent = info;
    logger.info(
      `Agent ready: ${info.agentInfo?.name ?? "unknown"} ${info.agentInfo?.version ?? ""} (protocol ${info.protocolVersion})`.trim(),
    );
    this.setStatus("ready", { agent: info });
    return info;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const promise = this.doStop().finally(() => {
      if (this.stopPromise === promise) this.stopPromise = null;
    });
    this.stopPromise = promise;
    return promise;
  }

  private async doStop(): Promise<void> {
    this.stopping = true;
    const connection = this.connection;
    const child = this.child;
    this.connection = null;
    if (connection) connection.close(new AcpError("agent stopped"));
    this.abortAllPermissions();
    if (child) {
      await terminateProcess(child);
      this.child = null;
    }
    this.sessions.clear();
    this.loadingSessions.clear();
    this.lastSessionId = null;
    if (this._status !== "stopped") this.setStatus("stopped", { message: "agent stopped" });
  }

  private handleExit(child: AgentChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child && this.child !== null) return; // a newer process replaced it
    this.child = null;
    const connection = this.connection;
    this.connection = null;
    const description =
      signal !== null ? `kiro-cli exited on signal ${signal}` : `kiro-cli exited with code ${code ?? "unknown"}`;
    if (connection) connection.close(new AcpError(description));
    this.abortAllPermissions();
    this.sessions.clear();
    this.loadingSessions.clear();
    if (this.stopping || this._status === "stopped") {
      if (this._status !== "stopped") this.setStatus("stopped", { message: "agent stopped" });
      return;
    }
    if (code === 0 && signal === null) {
      this.options.logger.info(description);
      this.setStatus("stopped", { message: description });
    } else {
      this.options.logger.error(description);
      this.setStatus("error", { message: description });
    }
  }

  private handleConnectionClosed(connection: acp.ClientConnection): void {
    if (this.connection !== connection) return; // already handled by stop()/exit
    this.connection = null;
    this.abortAllPermissions();
    const child = this.child;
    if (child && !this.stopping) {
      this.options.logger.warn("ACP connection closed while kiro-cli is still running; terminating it");
      void terminateProcess(child);
    }
  }

  // -------------------------------------------------------------------------
  // Agent requests
  // -------------------------------------------------------------------------

  async newSession(
    cwd: string,
    options?: { mcpServers?: acp.McpServer[]; meta?: Record<string, unknown> },
  ): Promise<SessionState> {
    const agent = this.requireAgent();
    const params: acp.NewSessionRequest = {
      cwd,
      mcpServers: options?.mcpServers ?? [],
    };
    if (options?.meta) params._meta = options.meta;
    let response: acp.NewSessionResponse;
    try {
      response = await agent.request(acp.methods.agent.session.new, params);
    } catch (error) {
      const err = toAcpError(error, "session/new failed");
      if (this._agent && (this._agent.authMethods.length > 0 || isAuthRequiredError(err))) {
        this.markAuthRequired("session/new", err);
      }
      throw err;
    }
    const state = buildSessionState(cwd, response);
    this.sessions.set(state.sessionId, state);
    this.lastSessionId = state.sessionId;
    if (this._status === "auth_required") this.setStatus("ready", { agent: this._agent ?? undefined });
    this.emitSession({ type: "state", session: state });
    return state;
  }

  async listSessions(
    options?: { cwd?: string; cursor?: string },
  ): Promise<{ sessions: SessionListEntry[]; nextCursor: string | null }> {
    const agent = this.requireAgent();
    const listCapability = this._agent?.agentCapabilities.sessionCapabilities?.list;
    if (listCapability === undefined || listCapability === null) {
      throw new AcpError("the agent did not advertise session/list");
    }
    const params: acp.ListSessionsRequest = {};
    if (options?.cwd !== undefined) params.cwd = options.cwd;
    if (options?.cursor !== undefined) params.cursor = options.cursor;
    let response: acp.ListSessionsResponse;
    try {
      response = await agent.request(acp.methods.agent.session.list, params);
    } catch (error) {
      throw toAcpError(error, "session/list failed");
    }
    const rawSessions = isRecord(response) && Array.isArray(response.sessions) ? response.sessions : [];
    const sessions: SessionListEntry[] = [];
    for (const entry of rawSessions) {
      const mapped = readSessionListEntry(entry);
      if (mapped) sessions.push(mapped);
    }
    const nextCursor = isRecord(response) && typeof response.nextCursor === "string" ? response.nextCursor : null;
    return { sessions, nextCursor };
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options?: { mcpServers?: acp.McpServer[] },
  ): Promise<SessionState> {
    const agent = this.requireAgent();
    if (this._agent?.agentCapabilities.loadSession !== true) {
      throw new AcpError("the agent did not advertise session/load");
    }
    const previous = this.sessions.get(sessionId);
    const placeholder: SessionState = {
      sessionId,
      cwd,
      modes: null,
      configOptions: null,
      models: null,
      availableCommands: [],
      meta: null,
    };
    // Register before sending so replayed `session/update`s are routed to this
    // session and flagged `replay: true` while the load is in flight.
    this.sessions.set(sessionId, placeholder);
    this.loadingSessions.add(sessionId);
    const params: acp.LoadSessionRequest = { sessionId, cwd, mcpServers: options?.mcpServers ?? [] };
    let response: acp.LoadSessionResponse;
    try {
      response = await agent.request(acp.methods.agent.session.load, params);
    } catch (error) {
      this.loadingSessions.delete(sessionId);
      if (previous) this.sessions.set(sessionId, previous);
      else this.sessions.delete(sessionId);
      const err = toAcpError(error, "session/load failed");
      if (isAuthRequiredError(err)) this.markAuthRequired("session/load", err);
      throw err;
    }
    this.loadingSessions.delete(sessionId);
    const current = this.sessions.get(sessionId) ?? placeholder;
    const state: SessionState = {
      ...current,
      cwd,
      modes: response?.modes ?? current.modes,
      configOptions: response?.configOptions ?? current.configOptions,
      models: readModelState(response) ?? current.models,
      meta: isRecord(response?._meta) ? response._meta : current.meta,
    };
    this.sessions.set(sessionId, state);
    this.lastSessionId = sessionId;
    if (this._status === "auth_required") this.setStatus("ready", { agent: this._agent ?? undefined });
    this.emitSession({ type: "state", session: state });
    return state;
  }

  async prompt(sessionId: string, content: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const agent = this.requireAgent();
    this.emitSession({ type: "turn_started", sessionId });
    try {
      const response = await agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: content });
      this.emitSession({ type: "turn_finished", sessionId, stopReason: response.stopReason });
      return response;
    } catch (error) {
      const err = toAcpError(error, "session/prompt failed");
      if (isAuthRequiredError(err)) this.markAuthRequired("session/prompt", err);
      this.emitSession({ type: "turn_failed", sessionId, error: err.message });
      throw err;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const agent = this.connection?.agent;
    if (!agent) {
      this.abortPermissions(sessionId);
      return;
    }
    const sent = agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch((error: unknown) => {
      this.options.logger.warn(`session/cancel failed: ${toAcpError(error).message}`);
    });
    this.abortPermissions(sessionId);
    await sent;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const agent = this.requireAgent();
    try {
      await agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
    } catch (error) {
      throw toAcpError(error, "session/set_mode failed");
    }
    const session = this.sessions.get(sessionId);
    if (session && session.modes?.currentModeId !== modeId) {
      this.updateSession(sessionId, (s) => ({
        ...s,
        modes: s.modes ? { ...s.modes, currentModeId: modeId } : { currentModeId: modeId, availableModes: [] },
      }));
    }
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<acp.SessionConfigOption[]> {
    const agent = this.requireAgent();
    const params: acp.SetSessionConfigOptionRequest =
      typeof value === "boolean"
        ? { sessionId, configId, type: "boolean", value }
        : { sessionId, configId, value };
    let response: acp.SetSessionConfigOptionResponse;
    try {
      response = await agent.request(acp.methods.agent.session.setConfigOption, params);
    } catch (error) {
      throw toAcpError(error, "session/set_config_option failed");
    }
    const configOptions = Array.isArray(response?.configOptions) ? response.configOptions : [];
    this.updateSession(sessionId, (s) => ({ ...s, configOptions }));
    return configOptions;
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const agent = this.requireAgent();
    const session = this.sessions.get(sessionId);
    if (!session?.models) {
      throw new AcpError("The agent did not advertise models for this session (session/set_model unavailable)");
    }
    try {
      await agent.request<unknown>(SESSION_SET_MODEL, { sessionId, modelId });
    } catch (error) {
      throw toAcpError(error, "session/set_model failed");
    }
    this.updateSession(sessionId, (s) => ({
      ...s,
      models: s.models ? { ...s.models, currentModelId: modelId } : s.models,
    }));
  }

  /**
   * A request was rejected because the user is signed out: switch to
   * `auth_required` so the host offers a login. Without an advertised auth
   * method the terminal fallback (`kiro-cli login`) is offered instead, so
   * the user can still sign in from the chat (D25).
   */
  private markAuthRequired(request: string, err: AcpError): void {
    if (!this._agent || !this.connection) return;
    this.options.logger.warn(`${request} rejected (${err.code ?? "no code"}): ${err.message}; sign-in required`);
    if (this._agent.authMethods.length === 0) {
      this._agent = { ...this._agent, authMethods: [FALLBACK_LOGIN_METHOD] };
    }
    this.setStatus("auth_required", { agent: this._agent, message: err.message });
  }

  async authenticate(methodId: string): Promise<void> {
    const info = this._agent;
    if (!info) throw new AcpError("agent is not initialized");
    // The fallback is always accepted (a `/login` typed while still signed in).
    const method: acp.AuthMethod | undefined =
      info.authMethods.find((m) => m.id === methodId) ??
      (methodId === FALLBACK_LOGIN_METHOD.id ? FALLBACK_LOGIN_METHOD : undefined);
    if (!method) throw new AcpError(`Unknown auth method '${methodId}'`);
    if (isTerminalMethod(method)) {
      if (!this.services.runTerminalAuth) {
        throw new AcpError(`Auth method '${methodId}' requires a terminal, which the host does not provide`);
      }
      await this.services.runTerminalAuth(method, this.resolvedCommand ?? this.options.command);
      return;
    }
    const agent = this.requireAgent();
    try {
      await agent.request(acp.methods.agent.authenticate, { methodId });
    } catch (error) {
      throw toAcpError(error, "authenticate failed");
    }
    if (this._status === "auth_required") this.setStatus("ready", { agent: info });
  }

  async callExtension<T = unknown>(method: string, params: unknown): Promise<T> {
    const agent = this.requireAgent();
    try {
      return await agent.request<T>(method, params);
    } catch (error) {
      throw toAcpError(error, `${method} failed`);
    }
  }

  // -------------------------------------------------------------------------
  // Client-side handlers
  // -------------------------------------------------------------------------

  private buildClientApp(): acp.ClientApp {
    const services = this.services;
    const logger = this.options.logger;
    return acp
      .client({ name: CLIENT_NAME })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handlePermission(ctx.params, ctx.signal),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => services.readTextFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => services.writeTextFile(ctx.params))
      .onRequest(acp.methods.client.terminal.create, (ctx) => services.createTerminal(ctx.params))
      .onRequest(acp.methods.client.terminal.output, (ctx) => services.terminalOutput(ctx.params))
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) => services.waitForTerminalExit(ctx.params))
      .onRequest(acp.methods.client.terminal.kill, (ctx) => services.killTerminal(ctx.params))
      .onRequest(acp.methods.client.terminal.release, (ctx) => services.releaseTerminal(ctx.params))
      .onRequest(
        KIRO_OPEN_EXTERNAL_URL,
        (params: unknown) => params,
        async (ctx) => {
          if (!services.openExternalUrl) throw acp.RequestError.methodNotFound(ctx.method);
          const url = isRecord(ctx.params) ? ctx.params.url : undefined;
          if (typeof url !== "string" || url.length === 0) {
            throw acp.RequestError.invalidParams(undefined, "expected { url: string }");
          }
          await services.openExternalUrl(url);
          return {};
        },
      )
      .onRequest("*", (ctx) => {
        logger.warn(`Unknown request from agent: ${ctx.method}`);
        throw acp.RequestError.methodNotFound(ctx.method);
      })
      // `session/update` and `_…` notifications are consumed by the stream
      // interceptor (see start()); anything else lands here.
      .onNotification("*", (ctx) => this.handleUnknownNotification(ctx.method, ctx.params));
  }

  private async handlePermission(
    params: acp.RequestPermissionRequest,
    requestSignal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const controller = new AbortController();
    const sessionId = params.sessionId;
    let set = this.pendingPermissions.get(sessionId);
    if (!set) {
      set = new Set();
      this.pendingPermissions.set(sessionId, set);
    }
    set.add(controller);
    const signal = AbortSignal.any([requestSignal, controller.signal]);
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    try {
      return await new Promise<acp.RequestPermissionResponse>((resolve, reject) => {
        if (signal.aborted) {
          resolve(cancelled);
          return;
        }
        const onAbort = (): void => resolve(cancelled);
        signal.addEventListener("abort", onAbort, { once: true });
        let host: Promise<acp.RequestPermissionResponse>;
        try {
          host = Promise.resolve(this.services.requestPermission(params, signal));
        } catch (error) {
          host = Promise.reject(error);
        }
        host.then(
          (response) => {
            signal.removeEventListener("abort", onAbort);
            resolve(signal.aborted ? cancelled : response);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            if (signal.aborted) resolve(cancelled);
            else reject(error);
          },
        );
      });
    } finally {
      set.delete(controller);
      if (set.size === 0) this.pendingPermissions.delete(sessionId);
    }
  }

  private abortPermissions(sessionId: string): void {
    const set = this.pendingPermissions.get(sessionId);
    if (!set) return;
    for (const controller of set) controller.abort(new AcpError("cancelled"));
  }

  private abortAllPermissions(): void {
    for (const sessionId of [...this.pendingPermissions.keys()]) this.abortPermissions(sessionId);
  }

  private handleSessionUpdate(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.sessionId !== "string" || !isRecord(raw.update)) {
      this.options.logger.warn("Malformed session/update notification ignored");
      this.emitSession({ type: "extension_notification", method: acp.methods.client.session.update, params: raw });
      return;
    }
    const sessionId = raw.sessionId;
    const update = raw.update;
    const kind = update.sessionUpdate;
    if (typeof kind !== "string" || !KNOWN_SESSION_UPDATES.has(kind)) {
      this.emitSession({ type: "extension_notification", method: acp.methods.client.session.update, params: raw });
      return;
    }
    const typed = update as unknown as acp.SessionUpdate;
    const replay = this.loadingSessions.has(sessionId) || isReplayUpdate(update);
    this.emitSession(replay ? { type: "update", sessionId, update: typed, replay: true } : { type: "update", sessionId, update: typed });
    if (!this.sessions.has(sessionId)) return;
    switch (typed.sessionUpdate) {
      case "current_mode_update": {
        const currentModeId = typed.currentModeId;
        this.updateSession(sessionId, (s) => ({
          ...s,
          modes: s.modes ? { ...s.modes, currentModeId } : { currentModeId, availableModes: [] },
        }));
        break;
      }
      case "config_option_update": {
        const configOptions = Array.isArray(typed.configOptions) ? typed.configOptions : [];
        this.updateSession(sessionId, (s) => ({ ...s, configOptions }));
        break;
      }
      case "available_commands_update": {
        const availableCommands = Array.isArray(typed.availableCommands) ? typed.availableCommands : [];
        this.updateSession(sessionId, (s) => ({ ...s, availableCommands }));
        break;
      }
      default:
        break;
    }
  }

  private handleUnknownNotification(method: string, params: unknown): void {
    if (method === KIRO_V2_COMMANDS_AVAILABLE) {
      const mapped = mapV2Commands(params);
      const sessionId = mapped?.sessionId ?? this.lastSessionId;
      if (mapped && sessionId && this.sessions.has(sessionId)) {
        const update: acp.SessionUpdate = {
          sessionUpdate: "available_commands_update",
          availableCommands: mapped.commands,
        };
        this.emitSession({ type: "update", sessionId, update });
        this.updateSession(sessionId, (s) => ({ ...s, availableCommands: mapped.commands }));
        return;
      }
    }
    this.emitSession({ type: "extension_notification", method, params });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireAgent(): acp.ClientContext {
    const connection = this.connection;
    if (!connection) throw new AcpError("agent is not running");
    return connection.agent;
  }

  private updateSession(sessionId: string, mutate: (state: SessionState) => SessionState): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    const next = mutate(current);
    this.sessions.set(sessionId, next);
    this.emitSession({ type: "state", session: next });
  }

  private setStatus(status: ConnectionStatus, extra: Omit<ConnectionStateChange, "status"> = {}): void {
    this._status = status;
    const change: ConnectionStateChange = { status, ...extra };
    if (change.agent === undefined && this._agent && status !== "stopped" && status !== "error") {
      change.agent = this._agent;
    }
    for (const listener of [...this.connectionListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.options.logger.error(`connection listener failed: ${toAcpError(error).message}`);
      }
    }
  }

  private emitSession(event: SessionEvent): void {
    for (const listener of [...this.sessionListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger.error(`session listener failed: ${toAcpError(error).message}`);
      }
    }
  }
}

export function createKiroAgent(options: AgentProcessOptions, services: ClientServices): KiroAgent {
  return new KiroAgentImpl(options, services);
}
