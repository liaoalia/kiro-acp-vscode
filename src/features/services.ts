/**
 * Compose the feature services into the {@link ClientServices} the ACP layer calls.
 */
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import type { ClientServices } from "../acp/types.js";
import type { FsService } from "./fs.js";
import type { PermissionManager } from "./permissions.js";
import type { TerminalService } from "./terminal.js";
import { shellWrappedCommand } from "../acp/process.js";

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
 * `shellPath`/`shellArgs` that make the sign-in command the terminal's own
 * process. A Windows `.cmd`/`.bat` launcher (the fake agent's wrapper, a
 * shim) cannot be a terminal shell by itself, so it runs through `cmd.exe`
 * with the command line passed verbatim (VS Code accepts `shellArgs` as one
 * string on Windows).
 */
export function loginShell(
  command: string,
  args: readonly string[],
): { shellPath: string; shellArgs: string | string[] } {
  const wrapped = shellWrappedCommand(command, args);
  if (wrapped.command === command) return { shellPath: command, shellArgs: [...args] };
  return { shellPath: wrapped.command, shellArgs: wrapped.args.join(" ") };
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
      invocation: { command: string; args: readonly string[] },
    ): Promise<void> {
      const args = [...invocation.args, ...(method.args ?? [])];
      // The sign-in *is* the terminal's process (not a command typed into a
      // shell), so its exit is observable: code 0 means signed in and the
      // caller reconnects at once; the Reconnect button stays as the manual way.
      const term = vscode.window.createTerminal({
        name: "Kiro login",
        ...loginShell(invocation.command, args),
        env: method.env ?? undefined,
        isTransient: true,
      });
      term.show(false);
      logger.info(`started terminal auth "${method.name}" (${method.id}): ${[invocation.command, ...args].join(" ")}`);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          closed.dispose();
          fn();
        };
        const closed = vscode.window.onDidCloseTerminal((t) => {
          if (t !== term) return;
          const code = term.exitStatus?.code;
          if (code === undefined || code === 0) {
            logger.info(`terminal auth finished${code === 0 ? " (exit 0)" : " (terminal closed)"}`);
            settle(resolve);
          } else {
            settle(() => reject(new Error(`The sign-in command exited with code ${code}; see the Kiro login terminal.`)));
          }
        });
        void vscode.window
          .showInformationMessage(
            "Finish signing in in the terminal; the chat reconnects when it completes (or click Reconnect).",
            "Reconnect",
          )
          .then((choice) => {
            if (choice === "Reconnect") settle(resolve);
            // Dismissed: keep waiting for the terminal.
          });
      });
    },
  };
}
