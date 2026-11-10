/**
 * ACP terminal methods (DECISIONS.md D9).
 *
 * Each `terminal/create` spawns a real child process; its output is mirrored
 * into a visible VS Code pseudoterminal and retained (bounded) for the agent.
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
  child: ChildProcess;
  buffer: OutputBuffer;
  exit: ExitStatus | undefined;
  exitPromise: Promise<ExitStatus>;
  pty: MirrorPty;
  terminal: vscode.Terminal;
  killed: boolean;
}

/** Pseudoterminal that mirrors a child process' output and forwards input. */
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

export class TerminalService implements vscode.Disposable {
  private readonly active = new Map<string, TerminalEntry>();
  /** Every VS Code terminal ever created, including released ones (for "show"). */
  private readonly terminals = new Map<string, vscode.Terminal>();
  /** Final output/exit of released terminals so tool cards can still show them. */
  private readonly released = new Map<string, TerminalSnapshot>();
  private counter = 0;

  constructor(private readonly options: TerminalServiceOptions = {}) {}

  // ---------------------------------------------------------------------
  // ClientServices
  // ---------------------------------------------------------------------

  /** ClientServices.createTerminal */
  async createTerminal(req: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    if (typeof req.command !== "string" || req.command.length === 0) {
      throw new Error("terminal/create requires a command");
    }
    const id = `term-${++this.counter}`;
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
    });

    const pty = new MirrorPty(
      (data) => {
        const entry = this.active.get(id);
        if (entry && !entry.exit && child.stdin && !child.stdin.destroyed) {
          child.stdin.write(data === "\r" ? "\n" : data);
          pty.write(data === "\r" ? "\r\n" : data);
        }
      },
      () => {
        // User closed the terminal tab: stop the process.
        void this.killEntry(this.active.get(id));
      },
    );
    const terminal = vscode.window.createTerminal({
      name: `Kiro: ${truncate(req.command, 40)}`,
      pty,
    });
    this.terminals.set(id, terminal);

    let resolveExit!: (s: ExitStatus) => void;
    const exitPromise = new Promise<ExitStatus>((resolve) => {
      resolveExit = resolve;
    });
    const entry: TerminalEntry = {
      id,
      child,
      buffer,
      exit: undefined,
      exitPromise,
      pty,
      terminal,
      killed: false,
    };
    this.active.set(id, entry);

    pty.write(`$ ${commandLine}\r\n`);
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer.append(text);
      pty.write(toPtyText(text));
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      const msg = `[spawn error: ${err.message}]`;
      buffer.append(`\n${msg}\n`);
      pty.write(`\r\n${msg}\r\n`);
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
      const label =
        status.signal !== null && status.exitCode === null
          ? `[terminated by ${status.signal}]`
          : `[exit code ${status.exitCode ?? "unknown"}]`;
      pty.write(`\r\n${label}\r\n`);
      resolveExit(status);
    });

    terminal.show(true);
    this.options.logger?.info(`terminal ${id}: spawned "${commandLine}" in ${cwd}`);
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

  /** ClientServices.releaseTerminal — kills if running; the VS Code tab stays open. */
  async releaseTerminal(req: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    const entry = this.require(req.terminalId);
    await this.killEntry(entry);
    this.released.set(entry.id, snapshotOf(entry));
    this.active.delete(entry.id);
    return {};
  }

  /**
   * Output so far and exit code of a terminal (also after release), for the
   * chat tool card; `undefined` for unknown ids.
   */
  snapshot(terminalId: string): TerminalSnapshot | undefined {
    const entry = this.active.get(terminalId);
    if (entry) {
      return snapshotOf(entry);
    }
    return this.released.get(terminalId);
  }

  // ---------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------

  /** Reveal the VS Code terminal for `terminalId` (works after release too). */
  showTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
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

  /** Kill every running process and forget all terminals (tabs stay open). */
  disposeAll(): void {
    for (const entry of this.active.values()) {
      void this.killEntry(entry);
      entry.pty.dispose();
    }
    this.active.clear();
    this.terminals.clear();
    this.released.clear();
  }

  dispose(): void {
    this.disposeAll();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private require(terminalId: string): TerminalEntry {
    const entry = this.active.get(terminalId);
    if (!entry) {
      throw new Error(`Unknown terminal: ${terminalId}`);
    }
    return entry;
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
      entry.child.kill("SIGTERM");
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

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
