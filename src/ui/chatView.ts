/**
 * WebviewViewProvider for the chat view in the secondary side bar.
 *
 * Thin: it builds the HTML, forwards `FromWebview` messages to the
 * controller (on behalf of its own view handle) and lets the controller
 * post `ToWebview` messages back. The sidebar starts on the focused session.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { ChatController, ViewHandle } from "./chatController.js";
import type { FromWebview, ToWebview } from "./protocol.js";
import { getWebviewHtml } from "./webviewHtml.js";

export const CHAT_VIEW_ID = "kiroAcp.chat";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private handle: ViewHandle | null = null;

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
    const handle = this.controller.attachView(poster, { prefer: "focused" });
    this.handle = handle;

    const subscriptions: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: FromWebview) => {
        void this.controller.handle(message, handle);
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          poster({ type: "state", state: handle.snapshot() });
        }
      }),
    ];
    webviewView.onDidDispose(() => {
      for (const d of subscriptions) d.dispose();
      handle.dispose();
      if (this.handle === handle) this.handle = null;
      this.view = null;
    });
  }

  /** The session the sidebar displays, or null. */
  get sessionId(): string | null {
    return this.handle?.sessionId ?? null;
  }

  reveal(): void {
    if (this.view) {
      this.view.show(true);
      this.handle?.focus();
    } else {
      void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    }
  }

  focusInput(): void {
    this.reveal();
    this.view?.webview.postMessage({ type: "focusInput" } satisfies ToWebview);
  }
}
