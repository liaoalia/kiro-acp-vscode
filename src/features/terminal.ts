/**
 * ACP terminal methods (DECISIONS.md D9).
 *
 * Each `terminal/create` spawns a real child process; its output is retained
 * (bounded) for the agent and the chat card, and mirrored into a VS Code
 * pseudoterminal according to `kiroAcp.terminal.mode`:
 *
 * - `shared` (default): one terminal per ACP session, created lazily and
 *   revealed only on its first command; every command of the session writes
 *   a header, its output and an exit footer into it.
 * - `perCommand`: one terminal per command, revealed on creation.
 * - `hidden`: no VS Code terminal at all.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import {
  OutputBuffer,
  buildShellCommand,
  mergeEnv,
  stripAnsi,
  toPtyText,
} from "./pure/outputBuffer.js";
import {
  LinePrefixer,
  commandTerminalName,
  concurrentPrefix,
  formatCommandHeader,
  formatExitFooter,
  makeRunId,
  makeTerminalId,
  parseTerminalMode,
  pickInputTarget,
  sharedTerminalName,
  shouldMirrorOutput,
  type TerminalMode,
} from "./pure/terminalPresentation.js";

export interface TerminalServiceOptions {
  /** Fallback cwd when the request has none; defaults to the first workspace folder. */
  workspaceRoot?: string;
  /** Overrides the `kiroAcp.terminal.outputByteLimit` setting. */
  defaultOutputByteLimit?: number;
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/** Output retained for a terminal plus its exit code (`undefined` while running). */
export interface TerminalSnapshot {
  output: string;
  exitCode: number | null | undefined;
}

interface TerminalEntry {
  id: string;
  /** Start order; keystrokes in a shared terminal go to the highest running one. */
  seq: number;
  sessionId: string;
  mode: TerminalMode;
  child: ChildProcess;
  buffer: OutputBuffer;
  exit: ExitStatus | undefined;
  exitPromise: Promise<ExitStatus>;
  killed: boolean;
  /** `terminal/release` happened: in `shared` mode, output of a surviving process is no longer mirrored. */
  released: boolean;
  /** Mirror text into the VS Code terminal (no-op in `hidden` mode). */
  write: (text: string) => void;
  /** `perCommand` only: this command's own pseudoterminal. */
  pty?: MirrorPty;
}

/** Where a terminal id was shown, kept after release for "Show terminal". */
interface Placement {
  mode: TerminalMode;
  sessionId: string;
  /** `perCommand` only. */
  terminal?: vscode.Terminal;
}

/** The one VS Code terminal of a session in `shared` mode. */
interface SharedTerminal {
  sessionId: string;
  pty: MirrorPty;
  terminal: vscode.Terminal;
}

/** Pseudoterminal that mirrors child process output and forwards input. */
class MirrorPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private opened = false;
  private queue: string[] = [];

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(
    private readonly onInput: (data: string) => void,
    private readonly onUserClose: () => void,
  ) {}

  open(): void {
    this.opened = true;
    for (const chunk of this.queue) {
      this.writeEmitter.fire(chunk);
    }
    this.queue = [];
  }

  close(): void {
    this.onUserClose();
  }

  handleInput(data: string): void {
    this.onInput(data);
  }

  write(text: string): void {
    if (this.opened) {
      this.writeEmitter.fire(text);
    } else {
      this.queue.push(text);
    }
  }

  dispose(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

const DEFAULT_LIMIT = 1024 * 1024;
/** POSIX: SIGKILL follows SIGTERM after this long when the process group is still alive. */
const POSIX_KILL_GRACE_MS = 2_000;

export class TerminalService implements vscode.Disposable {
  private readonly active = new Map<string, TerminalEntry>();
  /** Where every terminal id ever created was shown, including released ones. */
  private readonly placements = new Map<string, Placement>();
  /** Final output/exit of released terminals so tool cards can still show them. */
  private readonly released = new Map<string, TerminalSnapshot>();
  /** `shared` mode: the session's terminal, present while its tab is open. */
  private readonly shared = new Map<string, SharedTerminal>();
  private counter = 0;
  /**
   * Random per-run id baked into every terminal id, so ids of an earlier
   * extension-host run (replayed by `session/load`) never match a live one.
   */
  private readonly runId = makeRunId();

  constructor(private readonly options: TerminalServiceOptions = {}) {}

  // ---------------------------------------------------------------------
  // ClientServices
  // ---------------------------------------------------------------------

  /** ClientServices.createTerminal */
  async createTerminal(req: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    if (typeof req.command !== "string" || req.command.length === 0) {
      throw new Error("terminal/create requires a command");
    }
    const seq = ++this.counter;
    const id = makeTerminalId(this.runId, seq);
    const sessionId = typeof req.sessionId === "string" && req.sessionId ? req.sessionId : "default";
    const mode = this.currentMode();
    const commandLine = buildShellCommand(req.command, req.args);
    const cwd = req.cwd ?? this.defaultCwd();
    const env = mergeEnv(process.env, req.env);
    const limit = req.outputByteLimit ?? this.defaultLimit();
    const buffer = new OutputBuffer(limit);

    const child = spawn(commandLine, [], {
      cwd,
      env,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: own process group, so a kill reaches the shell's children too
      // (a started service, not just `sh -c`); Windows uses `taskkill /T`.
      detached: process.platform !== "win32",
    });

    let resolveExit!: (s: ExitStatus) => void;
    const exitPromise = new Promise<ExitStatus>((resolve) => {
      resolveExit = resolve;
    });
    const entry: TerminalEntry = {
      id,
      seq,
      sessionId,
      mode,
      child,
      buffer,
      exit: undefined,
      exitPromise,
      killed: false,
      released: false,
      write: () => {},
    };
    this.attachPresentation(entry, req.command);
    this.active.set(id, entry);

    entry.write(formatCommandHeader(commandLine, cwd));
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer.append(text);
      if (shouldMirrorOutput(entry)) {
        entry.write(toPtyText(text));
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      const msg = `[spawn error: ${err.message}]`;
      buffer.append(`\n${msg}\n`);
      if (shouldMirrorOutput(entry)) {
        entry.write(`\r\n${msg}\r\n`);
      }
      this.options.logger?.error(`terminal ${id}: ${err.message}`);
      if (!entry.exit) {
        // "close" may never fire when the spawn itself failed.
        entry.exit = { exitCode: null, signal: null };
        resolveExit(entry.exit);
      }
    });
    child.on("close", (code, signal) => {
      if (entry.exit) {
        return;
      }
      const status: ExitStatus = { exitCode: code, signal: signal ?? null };
      entry.exit = status;
      entry.write(formatExitFooter(status));
      resolveExit(status);
    });

    this.options.logger?.info(`terminal ${id} (${mode}): spawned "${commandLine}" in ${cwd}`);
    return { terminalId: id };
  }

  /** ClientServices.terminalOutput */
  async terminalOutput(req: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    const entry = this.require(req.terminalId);
    const response: acp.TerminalOutputResponse = {
      output: stripAnsi(entry.buffer.text),
      truncated: entry.buffer.truncated,
    };
    if (entry.exit) {
      response.exitStatus = { exitCode: entry.exit.exitCode, signal: entry.exit.signal };
    }
    return response;
  }

  /** ClientServices.waitForTerminalExit */
  async waitForTerminalExit(
    req: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const entry = this.require(req.terminalId);
    const status = entry.exit ?? (await entry.exitPromise);
    return { exitCode: status.exitCode, signal: status.signal };
  }

  /** ClientServices.killTerminal — the terminal stays valid for output/wait. */
  async killTerminal(req: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
    const entry = this.require(req.terminalId);
    await this.killEntry(entry);
    return {};
  }

  /**
   * Stop every command still running for `sessionId` (the user pressed Stop,
   * D27): their `terminal/wait_for_exit` resolve, so an agent waiting on one
   * can end the turn. The terminals stay valid for output/wait like after
   * `terminal/kill`. Returns the ids that were killed.
   */
  async killSession(sessionId: string): Promise<string[]> {
    const running = [...this.active.values()].filter((e) => e.sessionId === sessionId && !e.exit && !e.killed);
    await Promise.all(running.map((e) => this.killEntry(e)));
    return running.map((e) => e.id);
  }

  /**
   * ClientServices.releaseTerminal — kills if running; the VS Code terminal
   * stays open. In `shared` mode nothing the process (or a survivor of the
   * kill) still writes reaches the session's terminal afterwards; only the
   * exit footer does.
   */
  async releaseTerminal(req: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    const entry = this.require(req.terminalId);
    entry.released = true;
    await this.killEntry(entry);
    this.released.set(entry.id, snapshotOf(entry));
    this.active.delete(entry.id);
    return {};
  }

  /**
   * Output so far and exit code of a terminal (also after release), for the
   * chat tool card; `undefined` for unknown ids (including ids of a previous
   * run) and, when `sessionId` is given, for terminals of another session.
   */
  snapshot(terminalId: string, sessionId?: string): TerminalSnapshot | undefined {
    if (!this.belongsTo(terminalId, sessionId)) {
      return undefined;
    }
    const entry = this.active.get(terminalId);
    if (entry) {
      return snapshotOf(entry);
    }
    return this.released.get(terminalId);
  }

  // ---------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------

  /**
   * Reveal the VS Code terminal that showed `terminalId` (works after release
   * too): its own tab in `perCommand` mode, the session's tab in `shared`
   * mode. `false` when there is none (`hidden` mode, unknown id, the user
   * closed the shared tab) or, when `sessionId` is given, the terminal
   * belongs to another session.
   */
  showTerminal(terminalId: string, sessionId?: string): boolean {
    const placement = this.placements.get(terminalId);
    if (!placement || !this.belongsTo(terminalId, sessionId)) {
      return false;
    }
    const terminal =
      placement.mode === "shared" ? this.shared.get(placement.sessionId)?.terminal : placement.terminal;
    if (!terminal) {
      return false;
    }
    terminal.show(false);
    return true;
  }

  /** Ids of terminals the agent still holds. */
  activeIds(): string[] {
    return [...this.active.keys()];
  }

  /** The current `kiroAcp.terminal.mode` (read on every `terminal/create`). */
  currentMode(): TerminalMode {
    return parseTerminalMode(vscode.workspace.getConfiguration("kiroAcp").get("terminal.mode"));
  }

  /**
   * Kill every running process and forget all terminals. Shared session
   * terminals are closed; per-command tabs stay open.
   */
  disposeAll(): void {
    for (const entry of this.active.values()) {
      void this.killEntry(entry);
      entry.pty?.dispose();
    }
    this.active.clear();
    const sharedTerminals = [...this.shared.values()];
    this.shared.clear();
    for (const st of sharedTerminals) {
      st.terminal.dispose();
      st.pty.dispose();
    }
    this.placements.clear();
    this.released.clear();
  }

  dispose(): void {
    this.disposeAll();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Whether `terminalId` may be looked up on behalf of `sessionId`: every
   * placement (all modes) records the session that created the terminal, so
   * a card of one session never shows another session's command output.
   * Without a `sessionId` the check is skipped; unknown ids fail it.
   */
  private belongsTo(terminalId: string, sessionId: string | undefined): boolean {
    if (sessionId === undefined) {
      return true;
    }
    const placement = this.placements.get(terminalId);
    return placement !== undefined && placement.sessionId === sessionId;
  }

  private require(terminalId: string): TerminalEntry {
    const entry = this.active.get(terminalId);
    if (!entry) {
      throw new Error(`Unknown terminal: ${terminalId}`);
    }
    return entry;
  }

  /** Wire `entry.write` (and input/close handling) according to its mode. */
  private attachPresentation(entry: TerminalEntry, command: string): void {
    switch (entry.mode) {
      case "hidden":
        this.placements.set(entry.id, { mode: "hidden", sessionId: entry.sessionId });
        return;
      case "perCommand": {
        const pty = new MirrorPty(
          (data) => this.forwardInput(entry, data),
          () => {
            // User closed the terminal tab: stop the process.
            void this.killEntry(this.active.get(entry.id));
          },
        );
        const terminal = vscode.window.createTerminal({ name: commandTerminalName(command), pty });
        entry.pty = pty;
        entry.write = (text) => pty.write(text);
        this.placements.set(entry.id, { mode: "perCommand", sessionId: entry.sessionId, terminal });
        terminal.show(true);
        return;
      }
      case "shared": {
        const concurrent = [...this.active.values()].some(
          (other) => other.sessionId === entry.sessionId && !other.exit,
        );
        const prefixer = concurrent ? new LinePrefixer(concurrentPrefix(entry.id)) : undefined;
        const st = this.sharedTerminalFor(entry.sessionId);
        entry.write = (text) => {
          // Only while this is still the session's terminal: after the user
          // closed it, late output of killed children must not leak into a
          // terminal created for a later command.
          if (this.shared.get(entry.sessionId) === st) {
            st.pty.write(prefixer ? prefixer.apply(text) : text);
          }
        };
        this.placements.set(entry.id, { mode: "shared", sessionId: entry.sessionId });
        return;
      }
    }
  }

  /** The session's shared terminal, created (and revealed once) on demand. */
  private sharedTerminalFor(sessionId: string): SharedTerminal {
    const existing = this.shared.get(sessionId);
    if (existing) {
      return existing;
    }
    const pty = new MirrorPty(
      (data) => {
        const target = pickInputTarget(
          [...this.active.values()]
            .filter((e) => e.sessionId === sessionId && e.mode === "shared")
            .map((e) => ({ id: e.id, seq: e.seq, running: !e.exit, entry: e })),
        );
        if (target) {
          this.forwardInput(target.entry, data);
        }
      },
      () => this.onSharedClosed(sessionId, st),
    );
    const st: SharedTerminal = {
      sessionId,
      pty,
      terminal: vscode.window.createTerminal({ name: sharedTerminalName(sessionId), pty }),
    };
    this.shared.set(sessionId, st);
    // Revealed only now, on the session's first command; later commands never re-show it.
    st.terminal.show(true);
    this.options.logger?.info(`terminal: opened shared terminal for session ${sessionId}`);
    return st;
  }

  /** The user closed a session's shared terminal: stop its running commands. */
  private onSharedClosed(sessionId: string, st: SharedTerminal): void {
    if (this.shared.get(sessionId) !== st) {
      return;
    }
    this.shared.delete(sessionId);
    for (const entry of this.active.values()) {
      if (entry.sessionId === sessionId && entry.mode === "shared") {
        void this.killEntry(entry);
      }
    }
    st.pty.dispose();
  }

  /** Send typed data to the child's stdin and echo it into the terminal. */
  private forwardInput(entry: TerminalEntry, data: string): void {
    const { child } = entry;
    if (this.active.get(entry.id) === entry && !entry.exit && child.stdin && !child.stdin.destroyed) {
      child.stdin.write(data === "\r" ? "\n" : data);
      entry.write(data === "\r" ? "\r\n" : data);
    }
  }

  private async killEntry(entry: TerminalEntry | undefined): Promise<void> {
    if (!entry || entry.exit || entry.killed) {
      return;
    }
    entry.killed = true;
    const pid = entry.child.pid;
    if (process.platform === "win32" && pid !== undefined) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {
          entry.child.kill();
          resolve();
        });
        killer.on("close", () => resolve());
      });
    } else {
      // The whole process group (negative pid), SIGKILL after a grace period
      // for whatever ignored SIGTERM; the plain child as a fallback.
      const signalGroup = (signal: NodeJS.Signals): boolean => {
        if (pid === undefined) return false;
        try {
          process.kill(-pid, signal);
          return true;
        } catch {
          return false;
        }
      };
      if (!signalGroup("SIGTERM")) entry.child.kill("SIGTERM");
      const escalate = setTimeout(() => {
        if (entry.exit) return;
        if (!signalGroup("SIGKILL")) entry.child.kill("SIGKILL");
      }, POSIX_KILL_GRACE_MS);
      void entry.exitPromise.then(() => clearTimeout(escalate));
    }
  }

  private defaultCwd(): string {
    return (
      this.options.workspaceRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      process.cwd()
    );
  }

  private defaultLimit(): number {
    if (this.options.defaultOutputByteLimit !== undefined) {
      return this.options.defaultOutputByteLimit;
    }
    const configured = vscode.workspace
      .getConfiguration("kiroAcp")
      .get<number>("terminal.outputByteLimit", DEFAULT_LIMIT);
    return typeof configured === "number" && configured > 0 ? configured : DEFAULT_LIMIT;
  }
}

function snapshotOf(entry: TerminalEntry): TerminalSnapshot {
  return {
    output: stripAnsi(entry.buffer.text),
    exitCode: entry.exit ? entry.exit.exitCode : undefined,
  };
}
