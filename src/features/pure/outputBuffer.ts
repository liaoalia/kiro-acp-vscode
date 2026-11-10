/**
 * Pure helpers for agent terminals (DECISIONS.md D9): the bounded output
 * buffer, ANSI stripping, shell command assembly and env merging.
 * vscode-free; tested in `test/features-outputBuffer.test.ts`.
 */

/**
 * Retains appended text up to `limitBytes` (UTF-8). When the limit is
 * exceeded the OLDEST bytes are dropped, cutting on a character boundary so
 * the retained text is always valid. `limitBytes <= 0` or non-finite means
 * unbounded.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private sizes: number[] = [];
  private total = 0;
  private cache: string | undefined = "";
  private wasTruncated = false;

  constructor(readonly limitBytes: number) {}

  /** Append `chunk` and trim from the start if necessary. */
  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    const size = Buffer.byteLength(chunk, "utf8");
    this.chunks.push(chunk);
    this.sizes.push(size);
    this.total += size;
    this.cache = undefined;
    this.trim();
  }

  /** The retained text. */
  get text(): string {
    if (this.cache === undefined) {
      this.cache = this.chunks.join("");
    }
    return this.cache;
  }

  /** `true` once any output was dropped because of the limit. */
  get truncated(): boolean {
    return this.wasTruncated;
  }

  /** Retained size in UTF-8 bytes. */
  get byteLength(): number {
    return this.total;
  }

  private get bounded(): boolean {
    return Number.isFinite(this.limitBytes) && this.limitBytes > 0;
  }

  private trim(): void {
    if (!this.bounded || this.total <= this.limitBytes) {
      return;
    }
    this.wasTruncated = true;
    while (this.total > this.limitBytes && this.chunks.length > 0) {
      const excess = this.total - this.limitBytes;
      const firstSize = this.sizes[0]!;
      if (firstSize <= excess) {
        this.chunks.shift();
        this.sizes.shift();
        this.total -= firstSize;
        continue;
      }
      const kept = dropLeadingBytes(this.chunks[0]!, excess);
      const keptSize = Buffer.byteLength(kept, "utf8");
      this.total -= firstSize - keptSize;
      this.chunks[0] = kept;
      this.sizes[0] = keptSize;
      // keptSize < firstSize is guaranteed (we drop at least `excess` bytes).
    }
  }
}

/**
 * Drop at least `bytes` UTF-8 bytes from the start of `s`, moving the cut
 * forward to the next character boundary.
 */
export function dropLeadingBytes(s: string, bytes: number): string {
  if (bytes <= 0) {
    return s;
  }
  const buf = Buffer.from(s, "utf8");
  if (bytes >= buf.length) {
    return "";
  }
  let cut = bytes;
  // UTF-8 continuation bytes are 0b10xxxxxx; advance until a lead byte.
  while (cut < buf.length && (buf[cut]! & 0xc0) === 0x80) {
    cut++;
  }
  return buf.subarray(cut).toString("utf8");
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;

/** Remove ANSI CSI/OSC/ESC control sequences (colours, cursor moves, titles). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export type ShellPlatform = "win32" | "posix";

function platformOf(platform?: NodeJS.Platform | ShellPlatform): ShellPlatform {
  const p = platform ?? process.platform;
  return p === "win32" ? "win32" : "posix";
}

/** Quote a single argument for the platform's default shell when needed. */
export function quoteArg(arg: string, platform?: NodeJS.Platform | ShellPlatform): string {
  if (platformOf(platform) === "win32") {
    if (arg.length > 0 && !/[\s"&|<>^()%!]/.test(arg)) {
      return arg;
    }
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  }
  if (arg.length > 0 && /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the single command line passed to `spawn(…, { shell: true })`.
 * With no args the command is passed verbatim so compound commands
 * (`a && b`) keep working; otherwise each arg is quoted.
 */
export function buildShellCommand(
  command: string,
  args?: readonly string[] | null,
  platform?: NodeJS.Platform | ShellPlatform,
): string {
  if (!args || args.length === 0) {
    return command;
  }
  const plat = platformOf(platform);
  const head = /\s/.test(command) ? quoteArg(command, plat) : command;
  return [head, ...args.map((a) => quoteArg(a, plat))].join(" ");
}

/**
 * Merge ACP `{name, value}` pairs over a base environment. On Windows names
 * are case-insensitive, so an existing key with different casing is replaced.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  extra?: ReadonlyArray<{ name: string; value: string }> | null,
  platform?: NodeJS.Platform | ShellPlatform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!extra) {
    return env;
  }
  const win = platformOf(platform) === "win32";
  for (const { name, value } of extra) {
    if (win) {
      const lower = name.toLowerCase();
      for (const key of Object.keys(env)) {
        if (key !== name && key.toLowerCase() === lower) {
          delete env[key];
        }
      }
    }
    env[name] = value;
  }
  return env;
}

/** Convert bare "\n" to "\r\n" for a VS Code Pseudoterminal. */
export function toPtyText(s: string): string {
  return s.replace(/\r?\n/g, "\r\n");
}
