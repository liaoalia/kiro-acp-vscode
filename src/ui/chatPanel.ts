/**
 * Chat as editor tabs (WebviewPanels), the default location.
 *
 * Any number of tabs can be open; each has its own view handle on the
 * shared ChatController, displays its own session and is a session *group*
 * of its own: its session panel lists only the sessions created in that
 * tab, and closing the tab closes them (DECISIONS D20). `openNew()` adds a
 * tab, `open()` reveals the most recently active one (or adds the first).
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import type { ChatController, ViewHandle } from "./chatController.js";
import type { FromWebview, ToWebview } from "./protocol.js";
import { getWebviewHtml } from "./webviewHtml.js";

export const CHAT_PANEL_VIEW_TYPE = "kiroAcp.chatPanel";
const TITLE_PREFIX = "Kiro Chat";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  view: ViewHandle;
  groupId: string;
}

export class ChatPanelManager implements vscode.Disposable {
  private readonly entries: PanelEntry[] = [];
  /** The panel most recently active (or created). */
  private recent: PanelEntry | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  /** Numbers the tab titles (`Kiro Chat 1`, `Kiro Chat 2`, ...). */
  private titleCounter = 0;
  private groupCounter = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {
    // Restore the tabs after a window reload; each gets a fresh session in a
    // group of its own and keeps the title it was saved with.
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(CHAT_PANEL_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => {
          const numbered = /^Kiro Chat (\d+)$/.exec(panel.title);
          if (numbered) this.titleCounter = Math.max(this.titleCounter, Number(numbered[1]));
          this.adopt(panel);
        },
      }),
    );
  }

  /**
   * Open a new chat tab in the active editor group. It displays `sessionId`
   * when given (joining that session's group), otherwise a fresh session
   * created once the agent is ready.
   */
  openNew(sessionId?: string): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      CHAT_PANEL_VIEW_TYPE,
      `${TITLE_PREFIX} ${++this.titleCounter}`,
      { viewColumn: vscode.ViewColumn.Active },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist"),
          vscode.Uri.joinPath(this.extensionUri, "media"),
        ],
      },
    );
    this.adopt(panel, sessionId);
    return panel;
  }

  /** Reveal the most recently active chat tab, or open the first one. */
  open(preserveFocus = false): void {
    if (this.recent) {
      this.recent.panel.reveal(undefined, preserveFocus);
      return;
    }
    this.openNew();
  }

  isOpen(): boolean {
    return this.entries.length > 0;
  }

  /** Open chat tabs, oldest first. */
  panels(): readonly vscode.WebviewPanel[] {
    return this.entries.map((e) => e.panel);
  }

  /** The session a chat tab displays (null until it has one). */
  sessionOf(panel: vscode.WebviewPanel): string | null {
    return this.entries.find((e) => e.panel === panel)?.view.sessionId ?? null;
  }

  /** The controller view handle of a chat tab (null when the tab is not one of ours). */
  viewOf(panel: vscode.WebviewPanel): ViewHandle | null {
    return this.entries.find((e) => e.panel === panel)?.view ?? null;
  }

  focusInput(): void {
    this.open();
    this.recent?.panel.webview.postMessage({ type: "focusInput" } satisfies ToWebview);
  }

  private adopt(panel: vscode.WebviewPanel, sessionId?: string): void {
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
    // A tab opened on an existing session joins that session's group (a
    // permission request arrived while no chat was open); otherwise the tab
    // is a new group.
    const groupId = (sessionId && this.controller.sessionGroup(sessionId)) || `tab-${++this.groupCounter}`;
    const view = this.controller.attachView(poster, { prefer: "fresh", groupId });
    const entry: PanelEntry = { panel, view, groupId };
    this.entries.push(entry);
    this.recent = entry;
    if (sessionId) view.setSession(sessionId);
    else void this.controller.ensureViewSession(view);

    const subs: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: FromWebview) => {
        void this.controller.handle(message, view);
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          this.recent = entry;
          view.focus();
        }
        if (panel.visible) poster({ type: "state", state: view.snapshot() });
      }),
    ];
    panel.onDidDispose(() => {
      for (const d of subs) d.dispose();
      view.dispose();
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
      if (this.recent === entry) this.recent = this.entries[this.entries.length - 1] ?? null;
      // Closing the tab ends its sessions (D20), unless another tab shares the group.
      if (!this.entries.some((e) => e.groupId === groupId)) void this.controller.closeGroup(groupId);
    });
  }

  dispose(): void {
    for (const entry of this.entries.splice(0)) entry.panel.dispose();
    this.recent = null;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
