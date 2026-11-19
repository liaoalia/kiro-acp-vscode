/**
 * `AgentPool`: one `kiro-cli acp` process per session behind the single
 * {@link KiroAgent} facade the host already talks to (D31 (process per session)).
 *
 * A `kiro-cli acp` process runs one turn at a time, so sessions sharing one
 * process wait for each other (three tabs prompted at once: two got nothing
 * for 33 minutes). The pool gives each session its own process and routes
 * every session-scoped call to the process that hosts the session. A
 * pre-warmed spare keeps `session/new` as fast as with one process; past
 * `maxProcesses` new sessions share the least busy process. A process that
 * exits takes only its own sessions down (`process_exited`), never the pool.
 * No `vscode` import.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { KiroAgentImpl, toAcpError } from "./client.js";
import {
  AcpError,
  type AgentInfo,
  type AgentProcessOptions,
  type ClientServices,
  type ConnectionStateChange,
  type ConnectionStatus,
  type KiroAgent,
  type ProtocolLogger,
  type SessionEvent,
  type SessionListEntry,
  type SessionState,
  type Unsubscribe,
} from "./types.js";

/** One process of the pool: a {@link KiroAgent}, with its OS pid when known (for the log). */
export type PooledAgent = KiroAgent & { readonly pid?: number | null };

/** Makes the (not yet started) agent of pool process `processId` (1, 2, … in spawn order). */
export type AgentProcessFactory = (processId: number) => PooledAgent;

export interface AgentPoolOptions {
  /**
   * Most processes alive at once, the spare included (at least 1). At the
   * limit a new session shares the process with the fewest sessions; 1 means
   * one process hosts every session, as before D31.
   */
  maxProcesses: number;
  logger: ProtocolLogger;
}

/** Snapshot of one pool process (for `/capabilities` and tests). */
export interface PoolProcessInfo {
  /** Pool-local number, as in the log ("process 3"). */
  id: number;
  pid: number | null;
  status: ConnectionStatus;
  /** The idle process the next new or loaded session gets. */
  spare: boolean;
  sessionIds: string[];
}

interface PoolEntry {
  id: number;
  agent: PooledAgent;
  /** Sessions bound to this process. */
  sessions: Set<string>;
  /** `session/new` / `session/load` requests in flight on it (not bound yet). */
  pending: number;
  /** The process's `start()`; rejects when it failed or the pool stopped it first. */
  started: Promise<AgentInfo>;
  /** `start()` succeeded: from now on an `error` / `stopped` change means the process exited. */
  ready: boolean;
  /** The pool stops it (release, `stop()`): its exit is not a crash. */
  stopping: boolean;
  /** Message of the process's `error` change while it started (forwarded when the spare cannot start). */
  failure: string | null;
}

/** `session/list` cursors remembered at once; older ones (abandoned listings) are forgotten first. */
const MAX_TRACKED_CURSORS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Initialized and answering (a process asking for a sign-in still answers). */
function isLive(entry: PoolEntry): boolean {
  const status = entry.agent.status;
  return entry.ready && (status === "ready" || status === "auth_required");
}

export class AgentPool implements KiroAgent {
  readonly maxProcesses: number;
  private _status: ConnectionStatus = "stopped";
  private _agent: AgentInfo | null = null;
  /** True before `start()` and from `stop()` on: nothing may spawn a process then. */
  private stopped = true;
  private startPromise: Promise<AgentInfo> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lastProcessId = 0;
  /** Live processes, the spare included. */
  private readonly entries = new Set<PoolEntry>();
  private spare: PoolEntry | null = null;
  private readonly bindings = new Map<string, PoolEntry>();
  /** `session/list` `nextCursor` → the process that issued it (pages of one listing stay on one process). */
  private readonly cursorIssuers = new Map<string, PoolEntry>();
  /** Process stops in flight (release, unused process), awaited by `stop()`. */
  private readonly exiting = new Set<Promise<void>>();
  private readonly connectionListeners = new Set<(change: ConnectionStateChange) => void>();
  private readonly sessionListeners = new Set<(event: SessionEvent) => void>();

  constructor(
    private readonly factory: AgentProcessFactory,
    private readonly options: AgentPoolOptions,
  ) {
    const max = options.maxProcesses;
    this.maxProcesses = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get agent(): AgentInfo | null {
    return this._agent;
  }

  /** The live processes, spawn order. */
  processes(): PoolProcessInfo[] {
    return [...this.entries].map((entry) => ({
      id: entry.id,
      pid: entry.agent.pid ?? null,
      status: entry.agent.status,
      spare: entry === this.spare,
      sessionIds: [...entry.sessions],
    }));
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

  /** Start the spare process; resolves with its `AgentInfo`. Idempotent while running. */
  start(): Promise<AgentInfo> {
    if (this.startPromise) return this.startPromise;
    if (!this.stopped && this._agent && (this._status === "ready" || this._status === "auth_required")) {
      this.ensureSpare();
      return Promise.resolve(this._agent);
    }
    const promise = this.doStart().finally(() => {
      if (this.startPromise === promise) this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  private async doStart(): Promise<AgentInfo> {
    if (this.stopPromise) await this.stopPromise;
    this.stopped = false;
    this.setStatus("starting");
    let entry: PoolEntry | null = null;
    try {
      entry = this.spare ?? this.spawn(true);
      const info = await entry.started;
      this._agent = info;
      this.setStatus("ready", { agent: info });
      return info;
    } catch (error) {
      const err = toAcpError(error, "agent start failed");
      if (!this.stopped) this.setStatus("error", { message: entry?.failure ?? err.message });
      throw err;
    }
  }

  /** Stop every process, the spare included; pending requests are rejected. Idempotent. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const promise = this.doStop().finally(() => {
      if (this.stopPromise === promise) this.stopPromise = null;
    });
    this.stopPromise = promise;
    return promise;
  }

  private async doStop(): Promise<void> {
    this.stopped = true;
    for (const entry of [...this.entries]) this.stopEntry(entry, "pool stopped");
    await Promise.all([...this.exiting]);
    if (this._status !== "stopped") this.setStatus("stopped", { message: "agent stopped" });
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  newSession(
    cwd: string,
    options?: { mcpServers?: acp.McpServer[]; meta?: Record<string, unknown> },
  ): Promise<SessionState> {
    return this.openSession((agent) => agent.newSession(cwd, options));
  }

  async loadSession(sessionId: string, cwd: string, options?: { mcpServers?: acp.McpServer[] }): Promise<SessionState> {
    // Live in a process already: load it again there, as the one process did.
    const owner = this.bindings.get(sessionId);
    if (owner) return owner.agent.loadSession(sessionId, cwd, options);
    // Replayed history needs no binding: every process's events are forwarded.
    return this.openSession((agent) => agent.loadSession(sessionId, cwd, options));
  }

  /**
   * Forget the session's process; that process is stopped once it hosts no
   * other session (or becomes the spare when the pool has none, see {@link idle}).
   */
  releaseSession(sessionId: string): void {
    const entry = this.bindings.get(sessionId);
    if (!entry) return;
    this.bindings.delete(sessionId);
    entry.sessions.delete(sessionId);
    this.log(`session ${sessionId} released from process ${entry.id}`);
    if (entry.sessions.size === 0 && entry.pending === 0) this.idle(entry, "released");
  }

  async prompt(sessionId: string, content: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.owner(sessionId).prompt(sessionId, content);
  }

  async cancel(sessionId: string): Promise<void> {
    return this.owner(sessionId).cancel(sessionId);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    return this.owner(sessionId).setMode(sessionId, modeId);
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<acp.SessionConfigOption[]> {
    return this.owner(sessionId).setConfigOption(sessionId, configId, value);
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    return this.owner(sessionId).setModel(sessionId, modelId);
  }

  // -------------------------------------------------------------------------
  // Process-wide requests
  // -------------------------------------------------------------------------

  async listSessions(
    options?: { cwd?: string; cursor?: string },
  ): Promise<{ sessions: SessionListEntry[]; nextCursor: string | null }> {
    // A cursor belongs to the process that issued it: the next page must come
    // from there even if the spare changed in between (a session took it).
    let entry: PoolEntry;
    if (options?.cursor !== undefined) {
      const issuer = this.cursorIssuers.get(options.cursor);
      this.cursorIssuers.delete(options.cursor);
      if (!issuer || !this.entries.has(issuer) || !isLive(issuer)) {
        throw new AcpError("session/list cursor expired: the process that issued it is gone; list again from the start");
      }
      entry = issuer;
    } else {
      entry = await this.anyProcess();
    }
    const page = await entry.agent.listSessions(options);
    if (page.nextCursor !== null) {
      this.cursorIssuers.set(page.nextCursor, entry);
      // Cursors of abandoned listings must not pile up.
      while (this.cursorIssuers.size > MAX_TRACKED_CURSORS) {
        const oldest = this.cursorIssuers.keys().next().value;
        if (oldest === undefined) break;
        this.cursorIssuers.delete(oldest);
      }
    }
    return page;
  }

  async authenticate(methodId: string): Promise<void> {
    // The process that asked for the sign-in offered the methods the host shows (D25).
    const entry = this.askingForSignIn() ?? (await this.anyProcess());
    await entry.agent.authenticate(methodId);
    this.refreshStatus();
  }

  /** Session-scoped when `params.sessionId` is a string (routed to its process), else process-wide. */
  async callExtension<T = unknown>(method: string, params: unknown): Promise<T> {
    const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null;
    const agent = sessionId !== null ? this.owner(sessionId) : (await this.anyProcess()).agent;
    return agent.callExtension<T>(method, params);
  }

  // -------------------------------------------------------------------------
  // Processes
  // -------------------------------------------------------------------------

  /** Create and start pool process N (the spare when `asSpare`). */
  private spawn(asSpare: boolean): PoolEntry {
    const id = ++this.lastProcessId;
    const agent = this.factory(id);
    // `started` is set below: start() reports `starting` synchronously, so the
    // entry must exist (and be listened to) before it is called.
    const entry = { id, agent, sessions: new Set<string>(), pending: 0, ready: false, stopping: false, failure: null } as PoolEntry;
    agent.onSessionEvent((event) => this.emitSession(event));
    agent.onConnectionChange((change) => this.onProcessChange(entry, change));
    entry.started = agent.start().then(
      (info) => this.onStarted(entry, info),
      (error: unknown) => this.onStartFailed(entry, error),
    );
    entry.started.catch(() => undefined); // a background spare's failure is logged, not thrown
    this.entries.add(entry);
    if (asSpare) this.spare = entry;
    return entry;
  }

  private async onStarted(entry: PoolEntry, info: AgentInfo): Promise<AgentInfo> {
    if (entry.stopping) {
      // Stopped while starting: KiroAgentImpl may spawn its child after an
      // early stop(), so make sure that child is gone too.
      await entry.agent.stop();
      throw new AcpError("agent stopped");
    }
    entry.ready = true;
    this.log(`process ${entry.id} started (pid ${entry.agent.pid ?? "unknown"})${entry === this.spare ? " as the spare" : ""}`);
    return info;
  }

  private async onStartFailed(entry: PoolEntry, error: unknown): Promise<never> {
    const err = toAcpError(error, "agent start failed");
    if (!entry.stopping) {
      this.options.logger.warn(`agent-pool: process ${entry.id} failed to start: ${entry.failure ?? err.message}`);
      this.forget(entry);
      await entry.agent.stop();
      // Nothing left that could serve: the pool cannot work (forward the failure).
      const serving = this._status === "ready" || this._status === "auth_required";
      if (serving && this.entries.size === 0) this.setStatus("error", { message: entry.failure ?? err.message });
    }
    throw err;
  }

  private onProcessChange(entry: PoolEntry, change: ConnectionStateChange): void {
    if (!entry.ready) {
      // A failed start is reported by start()'s rejection (onStartFailed).
      if (change.status === "error") entry.failure = change.message ?? null;
      return;
    }
    if (entry.stopping || !this.entries.has(entry)) return; // stopped by the pool: not a crash
    if (change.status === "error" || change.status === "stopped") {
      this.onProcessExit(entry, change.message ?? `kiro-cli ${change.status}`);
      return;
    }
    this.refreshStatus(change.status === "auth_required" ? change.message : undefined);
  }

  /** A process exited on its own: its sessions end (`process_exited`); the pool stays up. */
  private onProcessExit(entry: PoolEntry, message: string): void {
    const sessionIds = [...entry.sessions];
    this.forget(entry);
    if (sessionIds.length > 0) {
      this.options.logger.warn(`agent-pool: process ${entry.id} exited (${message}); its sessions end: ${sessionIds.join(", ")}`);
      this.emitSession({ type: "process_exited", sessionIds, message });
    } else {
      this.options.logger.warn(`agent-pool: process ${entry.id} exited without sessions (${message})`);
    }
    this.refreshStatus();
    // Only a session process's exit re-warms: a spare dying at once would loop.
    if (sessionIds.length > 0) this.ensureSpare();
  }

  /** Stop a process the pool no longer needs; `stop()` awaits it. */
  private stopEntry(entry: PoolEntry, reason: string): void {
    if (entry.stopping) return;
    entry.stopping = true;
    this.forget(entry);
    this.refreshStatus(); // it may have been the process asking for a sign-in
    const done: Promise<void> = (async () => {
      try {
        await entry.agent.stop();
        // A start still in flight settles once onStarted has stopped a late child.
        if (!entry.ready) await entry.started.catch(() => undefined);
        this.log(`process ${entry.id} stopped (${reason})`);
      } catch (error) {
        this.options.logger.warn(`agent-pool: process ${entry.id} stop failed: ${toAcpError(error).message}`);
      }
    })().finally(() => this.exiting.delete(done));
    this.exiting.add(done);
  }

  /** Remove a process and its bindings from the pool. */
  private forget(entry: PoolEntry): void {
    if (!this.entries.delete(entry)) return;
    if (this.spare === entry) this.spare = null;
    for (const sessionId of entry.sessions) {
      if (this.bindings.get(sessionId) === entry) this.bindings.delete(sessionId);
    }
  }

  /** Start a spare in the background when there is none and room for one (a failure is retried on demand). */
  private ensureSpare(): void {
    if (this.stopped || this.spare || this.entries.size >= this.maxProcesses) return;
    this.spawn(true);
  }

  /**
   * A process left without sessions becomes the spare when the pool has
   * none (no respawn; with `maxProcesses = 1` the one process lives on, as
   * before D31), else it is stopped.
   */
  private idle(entry: PoolEntry, reason: string): void {
    if (!this.entries.has(entry)) return;
    if (!this.spare && isLive(entry)) {
      this.spare = entry;
      this.log(`process ${entry.id} is the spare again`);
      return;
    }
    this.stopEntry(entry, reason);
  }

  /**
   * Run `session/new` / `session/load` on the spare (started now when there
   * is none) or, once `maxProcesses` run, on the process with the fewest
   * sessions; bind the session to it and pre-warm the next spare.
   */
  private async openSession(request: (agent: KiroAgent) => Promise<SessionState>): Promise<SessionState> {
    this.requireRunning();
    let entry = this.spare;
    let shared = false;
    if (entry) {
      this.spare = null;
    } else if (this.entries.size < this.maxProcesses) {
      entry = this.spawn(false);
    } else {
      entry = this.leastBusy();
      shared = true;
    }
    entry.pending++;
    let state: SessionState;
    try {
      await entry.started;
      state = await request(entry.agent);
    } catch (error) {
      entry.pending--;
      // The process the failed request was meant for goes back (spare or stopped).
      if (entry.sessions.size === 0 && entry.pending === 0) this.idle(entry, "unused");
      throw error;
    }
    entry.pending--;
    if (!this.entries.has(entry)) throw new AcpError("agent stopped");
    this.bind(state.sessionId, entry, shared);
    this.ensureSpare();
    return state;
  }

  private bind(sessionId: string, entry: PoolEntry, shared: boolean): void {
    const previous = this.bindings.get(sessionId);
    if (previous && previous !== entry) this.releaseSession(sessionId);
    this.bindings.set(sessionId, entry);
    entry.sessions.add(sessionId);
    const note = shared ? ` (shared: ${this.maxProcesses} process limit reached)` : "";
    this.log(`session ${sessionId} -> process ${entry.id}${note}`);
  }

  private leastBusy(): PoolEntry {
    let best: PoolEntry | null = null;
    for (const entry of this.entries) {
      if (!best || entry.sessions.size + entry.pending < best.sessions.size + best.pending) best = entry;
    }
    if (!best) throw new AcpError("agent is not running");
    return best;
  }

  /** A process for a process-wide call: the ready spare, else any ready process, else a spare started now. */
  private async anyProcess(): Promise<PoolEntry> {
    this.requireRunning();
    const live = [...(this.spare ? [this.spare] : []), ...this.entries].filter(isLive);
    let entry = live.find((e) => e.agent.status === "ready") ?? live[0] ?? null;
    if (!entry) {
      this.ensureSpare();
      entry = this.spare ?? this.leastBusy();
      await entry.started;
    }
    return entry;
  }

  /** The process of `sessionId`; AcpError when no process hosts it. */
  private owner(sessionId: string): PooledAgent {
    const entry = this.bindings.get(sessionId);
    if (!entry) throw new AcpError(`unknown session ${sessionId}: no agent process hosts it`);
    return entry.agent;
  }

  private askingForSignIn(): PoolEntry | null {
    return [...this.entries].find((e) => e.ready && e.agent.status === "auth_required") ?? null;
  }

  private requireRunning(): void {
    if (this.stopped || this._status === "error") throw new AcpError("agent is not running");
  }

  /** `auth_required` while any process asks for a sign-in, `ready` again once none does. */
  private refreshStatus(message?: string): void {
    if (this.stopped || (this._status !== "ready" && this._status !== "auth_required")) return;
    const asking = this.askingForSignIn();
    if (asking) {
      if (this._status === "auth_required") return;
      this._agent = asking.agent.agent ?? this._agent;
      this.setStatus("auth_required", message !== undefined ? { message } : {});
    } else if (this._status === "auth_required") {
      const serving = [...(this.spare ? [this.spare] : []), ...this.entries].find(isLive);
      this._agent = serving?.agent.agent ?? this._agent;
      this.setStatus("ready");
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private log(message: string): void {
    this.options.logger.info(`agent-pool: ${message}`);
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

/**
 * Pool processes log with their number so interleaved lines stay
 * attributable; raw traces (and stderr) pass through unchanged.
 */
function processLogger(logger: ProtocolLogger, processId: number): ProtocolLogger {
  const prefix = `process ${processId}: `;
  const out: ProtocolLogger = {
    info: (message) => logger.info(prefix + message),
    warn: (message) => logger.warn(prefix + message),
    error: (message) => logger.error(prefix + message),
  };
  if (logger.trace) out.trace = logger.trace.bind(logger);
  return out;
}

/** An {@link AgentPool} of {@link KiroAgentImpl} processes sharing the host services. */
export function createAgentPool(
  options: AgentProcessOptions,
  services: ClientServices,
  poolOptions: { maxProcesses: number },
): AgentPool {
  return new AgentPool(
    (processId) => new KiroAgentImpl({ ...options, logger: processLogger(options.logger, processId) }, services),
    { maxProcesses: poolOptions.maxProcesses, logger: options.logger },
  );
}
