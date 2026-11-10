/**
 * Chat as an editor tab (WebviewPanel), the default location.
 *
 * Shares the ChatController with the sidebar view; both can be open at once
 * because the controller fans messages out to every attached webview.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { ChatController } from "./chatController.js";
import type { FromWebview, ToWebview } from "./protocol.js";
import { getWebviewHtml } from "./webviewHtml.js";

export const CHAT_PANEL_VIEW_TYPE = "kiroAcp.chatPanel";

export class ChatPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {
    // Restore the tab after a window reload.
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(CHAT_PANEL_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => {
          this.adopt(panel);
        },
      }),
    );
  }

  /** Open the chat tab in the active editor group, or reveal the existing one. */
  open(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      CHAT_PANEL_VIEW_TYPE,
      "Kiro Chat",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist"),
          vscode.Uri.joinPath(this.extensionUri, "media"),
        ],
      },
    );
    this.adopt(panel);
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  focusInput(): void {
    this.open();
    this.panel?.webview.postMessage({ type: "focusInput" } satisfies ToWebview);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "kiro-color-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "kiro-color.svg"),
    };
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };
    const nonce = randomBytes(16).toString("base64url");
    webview.html = getWebviewHtml({
      cspSource: webview.cspSource,
      nonce,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css")).toString(),
    });

    const poster = (message: ToWebview): void => {
      void webview.postMessage(message);
    };
    const detach = this.controller.attach(poster);
    const subs: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: FromWebview) => {
        void this.controller.handle(message);
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible) poster({ type: "state", state: this.controller.snapshot() });
      }),
    ];
    panel.onDidDispose(() => {
      for (const d of subs) d.dispose();
      detach();
      if (this.panel === panel) this.panel = null;
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
