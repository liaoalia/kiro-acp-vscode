/**
 * Pure helpers for how agent terminals are presented (DECISIONS.md D9):
 * the `kiroAcp.terminal.mode` setting, the shared terminal's name, the
 * header/footer written around each command and which child receives
 * keystrokes typed into a shared terminal.
 * vscode-free; tested in `test/features-terminalPresentation.test.ts`.
 */

/**
 * `shared`: one VS Code terminal per ACP session; `perCommand`: one per
 * `terminal/create`; `hidden`: no VS Code terminal (chat card only).
 */
export type TerminalMode = "shared" | "perCommand" | "hidden";

export const DEFAULT_TERMINAL_MODE: TerminalMode = "shared";

/**
 * Parse the setting value. Accepts the enum (case- and separator-insensitive:
 * `per-command`, `PerCommand`, `per_command`), legacy booleans (`true` →
 * `perCommand`, `false` → `hidden`) and a few synonyms (`session`, `single`,
 * `none`, `off`). Anything else falls back to `shared`.
 */
export function parseTerminalMode(value: unknown): TerminalMode {
  if (value === true) {
    return "perCommand";
  }
  if (value === false) {
    return "hidden";
  }
  if (typeof value !== "string") {
    return DEFAULT_TERMINAL_MODE;
  }
  const key = value.toLowerCase().replace(/[\s_-]/g, "");
  switch (key) {
    case "shared":
    case "session":
    case "persession":
    case "single":
      return "shared";
    case "percommand":
    case "command":
    case "separate":
    case "visible":
    case "always":
      return "perCommand";
    case "hidden":
    case "none":
    case "off":
    case "never":
      return "hidden";
    default:
      return DEFAULT_TERMINAL_MODE;
  }
}

/** Prefix of every terminal name this extension creates (`Kiro · …`, `Kiro: …`). */
export const TERMINAL_NAME_PREFIX = "Kiro";

const UUID_HEAD = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/**
 * Short form of an ACP session id for terminal names: the first group of a
 * UUID (`0b8e2f4a`), otherwise the first 12 characters (`sess-3`).
 */
export function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    return "session";
  }
  if (UUID_HEAD.test(trimmed)) {
    return trimmed.slice(0, 8);
  }
  return trimmed.slice(0, 12);
}

/** Name of the session's shared terminal: `Kiro · <title or short id>`. */
export function sharedTerminalName(sessionId: string, title?: string | null): string {
  const label = title?.trim() ? oneLine(title, 40) : shortSessionId(sessionId);
  return `${TERMINAL_NAME_PREFIX} · ${label}`;
}

/** Name of a per-command terminal: `Kiro: <command>`. */
export function commandTerminalName(command: string): string {
  return `${TERMINAL_NAME_PREFIX}: ${oneLine(command, 40)}`;
}

const BOLD_DIM = "\x1b[1;2m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Header written before a command's output: a blank line, then the command
 * line and its cwd in bold+dim. Uses `\r\n` (pseudoterminal line endings).
 */
export function formatCommandHeader(commandLine: string, cwd: string): string {
  const where = cwd.length > 0 ? `   [${cwd}]` : "";
  return `\r\n${BOLD_DIM}$ ${commandLine}${where}${RESET}\r\n`;
}

export interface ExitLike {
  exitCode: number | null;
  signal: string | null;
}

/** Plain footer label: `[exit code N]` or `[terminated by SIGTERM]`. */
export function exitLabel(exit: ExitLike): string {
  if (exit.signal !== null && exit.exitCode === null) {
    return `[terminated by ${exit.signal}]`;
  }
  return `[exit code ${exit.exitCode ?? "unknown"}]`;
}

/** Footer written after a command's output (dim), on its own line. */
export function formatExitFooter(exit: ExitLike): string {
  return `\r\n${DIM}${exitLabel(exit)}${RESET}\r\n`;
}

export interface InputCandidate {
  id: string;
  /** Monotonic start order (higher = started later). */
  seq: number;
  running: boolean;
}

/**
 * Which child receives keystrokes typed into a shared terminal: the most
 * recently started one that is still running, or `undefined`.
 */
export function pickInputTarget<T extends InputCandidate>(candidates: Iterable<T>): T | undefined {
  let best: T | undefined;
  for (const c of candidates) {
    if (!c.running) {
      continue;
    }
    if (best === undefined || c.seq > best.seq) {
      best = c;
    }
  }
  return best;
}

/** Prefix for the output lines of a command that runs concurrently with another. */
export function concurrentPrefix(terminalId: string): string {
  return `[${terminalId}] `;
}

/**
 * Inserts `prefix` at the start of every line across chunk boundaries, so
 * interleaved output of concurrent commands stays attributable.
 */
export class LinePrefixer {
  private atLineStart = true;

  constructor(readonly prefix: string) {}

  /** Return `chunk` with the prefix inserted where lines begin. */
  apply(chunk: string): string {
    if (chunk.length === 0 || this.prefix.length === 0) {
      return chunk;
    }
    let out = "";
    for (const part of chunk.split(/(\r\n|\n)/)) {
      if (part === "\r\n" || part === "\n") {
        out += part;
        this.atLineStart = true;
        continue;
      }
      if (part.length === 0) {
        continue;
      }
      if (this.atLineStart) {
        out += this.prefix;
        this.atLineStart = false;
      }
      out += part;
    }
    return out;
  }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
