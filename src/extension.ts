import * as vscode from "vscode";

import { ContextTracker } from "./features/context.js";
import { DiffManager } from "./features/diff.js";
import { FsService } from "./features/fs.js";
import { PermissionManager } from "./features/permissions.js";
import { PlanDocument } from "./features/plan.js";
import { createClientServices } from "./features/services.js";
import { TerminalService } from "./features/terminal.js";
import { ChatController } from "./ui/chatController.js";
import { ChatPanelManager } from "./ui/chatPanel.js";
import { CHAT_VIEW_ID, ChatViewProvider } from "./ui/chatView.js";

/** Exposed via `vscode.extensions.getExtension("liaoalia.kiro-acp").exports` for integration tests. */
export interface KiroAcpApi {
  controller: ChatController;
  permissions: PermissionManager;
  diff: DiffManager;
  plan: PlanDocument;
  terminal: TerminalService;
  contextTracker: ContextTracker;
  output: vscode.OutputChannel;
}

export function activate(context: vscode.ExtensionContext): KiroAcpApi {
  const output = vscode.window.createOutputChannel("Kiro ACP");
  const logger = {
    info: (m: string) => output.appendLine(`[info] ${m}`),
    warn: (m: string) => output.appendLine(`[warn] ${m}`),
    error: (m: string) => output.appendLine(`[error] ${m}`),
  };

  const permissions = new PermissionManager();
  const diff = new DiffManager(permissions, { logger });
  const fs = new FsService({ writeInterceptor: (p, c) => diff.interceptWrite(p, c) });
  const terminal = new TerminalService({ logger });
  const plan = new PlanDocument(permissions);
  const contextTracker = new ContextTracker();
  const services = createClientServices({ permissions, fs, terminal, logger });

  const controller = new ChatController({
    context,
    output,
    services,
    permissions,
    diff,
    plan,
    terminal,
    contextTracker,
  });
  const view = new ChatViewProvider(context.extensionUri, controller);
  const panel = new ChatPanelManager(context.extensionUri, controller);
  const chatInEditor = (): boolean =>
    vscode.workspace.getConfiguration("kiroAcp").get<string>("chatLocation", "editor") === "editor";
  /** Reveal the chat where the user configured it (editor tab by default). */
  const focusChat = (): void => {
    if (chatInEditor()) panel.open();
    else view.reveal();
  };

  context.subscriptions.push(
    panel,
    output,
    permissions,
    diff,
    fs,
    terminal,
    plan,
    contextTracker,
    controller,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("kiroAcp.focus", () => focusChat()),
    vscode.commands.registerCommand("kiroAcp.openInEditor", () => panel.open()),
    vscode.commands.registerCommand("kiroAcp.newSession", () => controller.newSession()),
    vscode.commands.registerCommand("kiroAcp.cancel", () => controller.cancel()),
    vscode.commands.registerCommand("kiroAcp.restart", () => controller.restart()),
    vscode.commands.registerCommand("kiroAcp.openPlan", () => plan.open()),
    vscode.commands.registerCommand("kiroAcp.showLog", () => output.show(true)),
    vscode.commands.registerCommand("kiroAcp.sendSelection", () => {
      if (!controller.addSelectionChip()) {
        void vscode.window.showInformationMessage("Open a file and select some text first.");
        return;
      }
      if (chatInEditor()) panel.focusInput();
      else view.focusInput();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kiroAcp.cliPath") || e.affectsConfiguration("kiroAcp.cliArgs")) {
        void vscode.window
          .showInformationMessage("Kiro CLI settings changed. Restart the agent to apply.", "Restart")
          .then((choice) => {
            if (choice === "Restart") void controller.restart();
          });
      }
    }),
  );

  return { controller, permissions, diff, plan, terminal, contextTracker, output };
}

export function deactivate(): void {
  // Disposables registered in activate() stop the agent process.
}
