/**
 * Folders outside the workspace that Kiro may write to without asking
 * (`kiroAcp.fs.allowedWriteRoots`, DECISIONS D8 addendum). Pure; no vscode.
 *
 * A configured root may use `${tmpdir}` (the OS temp folder), `${home}` or a
 * leading `~`, and `${env:NAME}`. A root whose variable is unknown or empty,
 * or that does not end up absolute, is ignored rather than guessed at: an
 * allow-list must never widen because a variable was missing.
 */
import { isAbsolutePath, isWithinRoot, normalizeFsPath, type Platform } from "./textRange.js";

/** The default of `kiroAcp.fs.allowedWriteRoots`: scratch files in the OS temp folder never ask. */
export const DEFAULT_WRITE_ROOTS: readonly string[] = ["${tmpdir}"];

export interface WriteRootContext {
  /** `os.tmpdir()`. */
  tmpdir: string;
  /** `os.homedir()`. */
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform | Platform;
}

/** Expand one configured root; null when it cannot be resolved to an absolute path. */
export function expandWriteRoot(raw: unknown, ctx: WriteRootContext): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.length === 0) return null;
  if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) text = "${home}" + text.slice(1);
  let unresolved = false;
  const expanded = text.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    let value: string | undefined;
    if (name === "tmpdir") value = ctx.tmpdir;
    else if (name === "home") value = ctx.home;
    else if (name.startsWith("env:")) value = ctx.env[name.slice(4)];
    if (!value) {
      unresolved = true;
      return "";
    }
    return value;
  });
  if (unresolved || !isAbsolutePath(expanded, ctx.platform)) return null;
  return normalizeFsPath(expanded, ctx.platform);
}

/** The first configured root (expanded) that contains `absPath`, or null when none does. */
export function matchWriteRoot(absPath: string, roots: readonly unknown[], ctx: WriteRootContext): string | null {
  for (const raw of roots) {
    const root = expandWriteRoot(raw, ctx);
    if (root !== null && isWithinRoot(absPath, root, ctx.platform)) return root;
  }
  return null;
}
