/**
 * Pure helpers for `fs/read_text_file` / `fs/write_text_file`: line slicing
 * and path normalisation. vscode-free; tested in `test/features-textRange.test.ts`.
 */
import * as path from "node:path";

/**
 * Return the lines of `text` starting at 1-based `line` (default 1), at most
 * `limit` lines (default: all). Line endings are preserved exactly, so joining
 * consecutive slices reproduces the input. A start line beyond the end yields
 * an empty string.
 */
export function sliceLines(
  text: string,
  line?: number | null,
  limit?: number | null,
): string {
  const start = Math.max(1, Math.floor(line ?? 1));
  const hasLimit = limit !== undefined && limit !== null;
  if (start === 1 && !hasLimit) {
    return text;
  }
  if (hasLimit && limit <= 0) {
    return "";
  }
  // Split after every "\n" so each element keeps its own terminator.
  const lines = text.length === 0 ? [] : text.split(/(?<=\n)/);
  const from = start - 1;
  if (from >= lines.length) {
    return "";
  }
  const to = hasLimit ? from + Math.floor(limit) : lines.length;
  return lines.slice(from, to).join("");
}

export type Platform = "win32" | "posix";

function platformOf(platform?: NodeJS.Platform | Platform): Platform {
  const p = platform ?? process.platform;
  return p === "win32" ? "win32" : "posix";
}

/**
 * Normalise an absolute path for comparisons: resolves `.`/`..`, and on
 * Windows lower-cases the drive letter and uses backslashes consistently.
 * The result is suitable as a map key (`normalizeFsPath(a) === normalizeFsPath(b)`
 * iff both name the same file, modulo case on NTFS which we do not fold).
 */
export function normalizeFsPath(p: string, platform?: NodeJS.Platform | Platform): string {
  if (platformOf(platform) === "win32") {
    let resolved = path.win32.resolve(p.replace(/\//g, "\\"));
    if (/^[A-Za-z]:/.test(resolved)) {
      resolved = resolved[0]!.toLowerCase() + resolved.slice(1);
    }
    // Strip a trailing separator except for the drive root ("c:\").
    if (resolved.length > 3 && resolved.endsWith("\\")) {
      resolved = resolved.slice(0, -1);
    }
    return resolved;
  }
  let resolved = path.posix.resolve(p);
  if (resolved.length > 1 && resolved.endsWith("/")) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

/** `true` when `p` is absolute on the given platform (default: current). */
export function isAbsolutePath(p: string, platform?: NodeJS.Platform | Platform): boolean {
  if (typeof p !== "string" || p.length === 0) {
    return false;
  }
  return platformOf(platform) === "win32" ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p);
}

/**
 * `true` when `child` is `root` or lies beneath it. Both are normalised with
 * {@link normalizeFsPath}; on Windows the comparison is case-insensitive.
 */
export function isWithinRoot(
  child: string,
  root: string,
  platform?: NodeJS.Platform | Platform,
): boolean {
  const plat = platformOf(platform);
  let c = normalizeFsPath(child, plat);
  let r = normalizeFsPath(root, plat);
  if (plat === "win32") {
    c = c.toLowerCase();
    r = r.toLowerCase();
  }
  if (c === r) {
    return true;
  }
  const sep = plat === "win32" ? "\\" : "/";
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}
