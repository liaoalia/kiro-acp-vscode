/**
 * Process helpers for the `kiro-cli acp` child: executable resolution,
 * spawning and termination. No `vscode` import.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { access, constants } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";

export type AgentChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export type ExistsFn = (candidate: string) => Promise<boolean>;

async function defaultExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function envLookup(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Windows environment keys are case-insensitive; a plain object (tests) is not.
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

function homeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (
    envLookup(env, "HOME") ??
    (platform === "win32" ? envLookup(env, "USERPROFILE") : undefined) ??
    os.homedir()
  );
}

function defaultLocations(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const home = homeDir(env, platform);
  switch (platform) {
    case "win32": {
      const programFiles = envLookup(env, "ProgramFiles") ?? "C:\\Program Files";
      const localAppData = envLookup(env, "LOCALAPPDATA");
      const out = [path.win32.join(programFiles, "Kiro-Cli", "kiro-cli.exe")];
      if (localAppData) out.push(path.win32.join(localAppData, "Programs", "Kiro-Cli", "kiro-cli.exe"));
      return out;
    }
    case "darwin":
      return [
        "/opt/homebrew/bin/kiro-cli",
        "/usr/local/bin/kiro-cli",
        path.posix.join(home, ".local", "bin", "kiro-cli"),
      ];
    default:
      return [
        path.posix.join(home, ".local", "bin", "kiro-cli"),
        "/usr/local/bin/kiro-cli",
        "/usr/bin/kiro-cli",
      ];
  }
}

/**
 * Resolve the configured CLI command to an executable path.
 *
 * 1. A value containing a path separator, or one that exists as given, is returned unchanged.
 * 2. Otherwise each `PATH` entry is searched (with `PATHEXT` on win32).
 * 3. Otherwise, when the command is `kiro-cli`, the platform default install locations are tried.
 * 4. Otherwise the configured value is returned unchanged (spawn will fail with ENOENT).
 */
export async function resolveCliPath(
  configured: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: ExistsFn = defaultExists,
): Promise<string> {
  const trimmed = configured.trim();
  if (trimmed.length === 0) return configured;
  if (/[\\/]/.test(trimmed)) return trimmed;
  if (await exists(trimmed)) return trimmed;

  const isWin = platform === "win32";
  const sep = isWin ? ";" : ":";
  const pathValue = envLookup(env, "PATH") ?? "";
  const dirs = pathValue.split(sep).filter((d) => d.length > 0);
  const pathJoin = isWin ? path.win32.join : path.posix.join;

  const extensions: string[] = [""];
  if (isWin) {
    const pathext = (envLookup(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const hasExt = path.win32.extname(trimmed).length > 0;
    if (!hasExt) extensions.push(...pathext);
  }

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = pathJoin(dir, trimmed + ext);
      if (await exists(candidate)) return candidate;
    }
  }

  const base = isWin ? path.win32.parse(trimmed).name : path.posix.parse(trimmed).name;
  if (base.toLowerCase() === "kiro-cli") {
    for (const candidate of defaultLocations(platform, env)) {
      if (await exists(candidate)) return candidate;
    }
  }

  return configured;
}

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Spawn the agent with piped stdio. The environment is passed through untouched. */
export function spawnAgentProcess(options: SpawnAgentOptions): AgentChildProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Terminate the child: SIGTERM, then SIGKILL after `graceMs` on POSIX; a plain
 * `kill()` on Windows. Resolves once the process has exited (or immediately
 * if it already has).
 */
export function terminateProcess(
  child: AgentChildProcess,
  platform: NodeJS.Platform = process.platform,
  graceMs = 2000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    child.once("close", done);
    try {
      if (platform === "win32") {
        child.kill();
      } else {
        child.kill("SIGTERM");
        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, graceMs);
        timer.unref?.();
      }
    } catch {
      done();
    }
  });
}
