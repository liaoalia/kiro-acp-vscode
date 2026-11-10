/**
 * WebviewViewProvider for the chat view in the secondary side bar.
 *
 * Thin: it builds the HTML, forwards `FromWebview` messages to the
 * controller and lets the controller post `ToWebview` messages back.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { ChatController } from "./chatController.js";
import type { FromWebview, ToWebview } from "./protocol.js";
import { getWebviewHtml } from "./webviewHtml.js";

export const CHAT_VIEW_ID = "kiroAcp.chat";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const webview = webviewView.webview;
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
    this.controller.attach(poster);

    const subscriptions: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: FromWebview) => {
        void this.controller.handle(message);
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          poster({ type: "state", state: this.controller.snapshot() });
        }
      }),
    ];
    webviewView.onDidDispose(() => {
      for (const d of subscriptions) d.dispose();
      this.controller.detach();
      this.view = null;
    });
  }

  reveal(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    }
  }

  focusInput(): void {
    this.reveal();
    this.view?.webview.postMessage({ type: "focusInput" } satisfies ToWebview);
  }
}
