/**
 * Compose the feature services into the {@link ClientServices} the ACP layer calls.
 */
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import type { ClientServices } from "../acp/types.js";
import type { FsService } from "./fs.js";
import type { PermissionManager } from "./permissions.js";
import type { TerminalService } from "./terminal.js";
import { quoteArg } from "./pure/outputBuffer.js";

export interface ServicesLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ClientServicesDeps {
  permissions: PermissionManager;
  fs: FsService;
  terminal: TerminalService;
  logger: ServicesLogger;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Command line for the login terminal. On Windows a quoted executable path
 * needs the PowerShell call operator (`& "C:\…\kiro-cli.exe" login`), which
 * is only emitted when quoting is actually required so cmd.exe users with
 * space-free paths are unaffected.
 */
export function buildAuthCommandLine(executable: string, args: readonly string[]): string {
  const quotedExe = quoteArg(executable);
  const parts = [quotedExe, ...args.map((a) => quoteArg(a))];
  const line = parts.join(" ");
  if (process.platform === "win32" && quotedExe !== executable) {
    return `& ${line}`;
  }
  return line;
}

/** Build the host services object handed to the ACP connection. */
export function createClientServices(deps: ClientServicesDeps): ClientServices {
  const { permissions, fs, terminal, logger } = deps;
  return {
    requestPermission: (request, signal) => permissions.request(request, signal),
    readTextFile: (request) => fs.readTextFile(request),
    writeTextFile: (request) => fs.writeTextFile(request),
    createTerminal: (request) => terminal.createTerminal(request),
    terminalOutput: (request) => terminal.terminalOutput(request),
    waitForTerminalExit: (request) => terminal.waitForTerminalExit(request),
    killTerminal: (request) => terminal.killTerminal(request),
    releaseTerminal: (request) => terminal.releaseTerminal(request),

    async openExternalUrl(url: string): Promise<void> {
      const choice = await vscode.window.showInformationMessage(
        `Kiro wants to open ${hostOf(url)} in your browser.`,
        { modal: true, detail: url },
        "Open",
      );
      if (choice !== "Open") {
        throw new Error("User declined to open the URL");
      }
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
      if (!opened) {
        throw new Error("The operating system could not open the URL");
      }
      logger.info(`opened external URL ${hostOf(url)}`);
    },

    async runTerminalAuth(
      method: acp.AuthMethodTerminal & { type: "terminal" },
      executable: string,
    ): Promise<void> {
      const term = vscode.window.createTerminal({
        name: "Kiro login",
        env: method.env ?? undefined,
      });
      term.show(false);
      term.sendText(buildAuthCommandLine(executable, method.args ?? []), true);
      logger.info(`started terminal auth "${method.name}" (${method.id})`);
      const choice = await vscode.window.showInformationMessage(
        "Finish signing in in the terminal, then click Reconnect.",
        "Reconnect",
      );
      if (choice !== "Reconnect") {
        throw new Error("Sign-in was not confirmed; use Reconnect when you are done.");
      }
    },
  };
}
