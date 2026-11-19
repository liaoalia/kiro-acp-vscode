/**
 * F17 — agent link (D30): with `kiroAcp.agentLink.enabled` every session gets
 * the `kiro-acp-tabs` MCP server; the fake agent's `agent-link` scenario calls
 * its `list_sessions` tool over loopback HTTP and says what it got.
 */
import * as vscode from "vscode";

import {
  assert,
  assertEqual,
  closeAllEditors,
  ensureReady,
  fakeAgentReports,
  freshSession,
  messagesOf,
  runPrompt,
  test,
  textOf,
  waitFor,
  withTimeout,
} from "./harness.js";
import type { KiroAcpApi } from "../../src/extension.js";
import type { ToolCallView, UiState } from "../../src/ui/protocol.js";

const ENABLED = "agentLink.enabled";

async function setLink(value: boolean | undefined): Promise<void> {
  await vscode.workspace.getConfiguration("kiroAcp").update(ENABLED, value, vscode.ConfigurationTarget.Workspace);
}

/** Send `text` to `sessionId` (not necessarily the focused one) and wait for its turn to end. */
async function promptIn(api: KiroAcpApi, sessionId: string, text: string): Promise<UiState> {
  await withTimeout(api.controller.prompt(text, [], sessionId), 30_000, `turn for ${JSON.stringify(text)} in ${sessionId}`);
  return waitFor(
    () => {
      const state = api.controller.snapshot(sessionId);
      return state.turnActive ? undefined : state;
    },
    15_000,
    `the turn in ${sessionId} to end`,
  );
}

function linkCall(state: UiState): ToolCallView | undefined {
  return Object.values(state.toolCalls).find((c) => c.title.includes("list_sessions"));
}

function agentText(state: UiState): string {
  return messagesOf(state)
    .filter((m) => m.role === "agent")
    .map(textOf)
    .join("\n");
}

async function capabilitiesLine(api: KiroAcpApi): Promise<string> {
  await runPrompt(api, "/capabilities");
  const reply = await waitFor(() => {
    const msgs = messagesOf(api.controller.snapshot());
    const last = msgs[msgs.length - 1];
    return last && last.role === "agent" ? textOf(last) : undefined;
  }, 15_000, "the /capabilities reply");
  const line = reply.split("\n").find((l) => l.startsWith("Agent link:"));
  assert(line, `/capabilities has an "Agent link:" line: ${reply.slice(-300)}`);
  return line;
}

test("F17.1 agent link on: the agent in one tab lists the sessions of the other tabs", async ({ api }) => {
  await closeAllEditors();
  await ensureReady(api);
  await setLink(true);
  try {
    const p1 = api.panel.openNew();
    const p2 = api.panel.openNew();
    await waitFor(
      () => (api.panel.sessionOf(p1) && api.panel.sessionOf(p2) ? true : undefined),
      15_000,
      "a session in each new tab",
    );
    // A tab may adopt a spare session created before the setting was on (and
    // so without the server): give each tab a session created now.
    const linkedSessionIn = async (panel: vscode.WebviewPanel): Promise<string> => {
      const view = api.panel.viewOf(panel);
      assert(view, "the tab has a controller view");
      const id = await withTimeout(api.controller.newSession(view), 15_000, `newSession() in ${panel.title}`);
      assert(id, `a new session in ${panel.title}`);
      return id;
    };
    const s1 = await linkedSessionIn(p1);
    const s2 = await linkedSessionIn(p2);
    // Give the second tab's session a title of its own.
    await promptIn(api, s2, "/scenario chat");

    const state = await promptIn(api, s1, "/scenario agent-link");
    assertEqual(fakeAgentReports(state).length, 0, `no fake-agent reports: ${JSON.stringify(fakeAgentReports(state))}`);
    const call = linkCall(state);
    assert(call, `a list_sessions tool card: ${JSON.stringify(Object.values(state.toolCalls).map((c) => c.title))}`);
    assertEqual(call.status, "completed", "the tool call completed");

    const text = agentText(state);
    assert(text.includes(`You are s`), `the result names the caller: ${text}`);
    assert(text.includes(`tab ${JSON.stringify(p1.title)}`), `the caller's tab is named "${p1.title}": ${text}`);
    assert(text.includes(`tab ${JSON.stringify(p2.title)}`), `the other tab "${p2.title}" is listed: ${text}`);
    assert(text.includes("/scenario chat"), `the other session's title is listed: ${text}`);

    const line = await capabilitiesLine(api);
    assert(/^Agent link: on — 127\.0\.0\.1:\d+, \d+ sessions? linked$/.test(line), `capabilities line: ${line}`);
  } finally {
    await setLink(undefined);
    await closeAllEditors();
  }
});

test("F17.2 agent link off: sessions get no server (and turning it off cuts live sessions off)", async ({ api }) => {
  await ensureReady(api);
  await setLink(true);
  const linked = await freshSession(api);
  await setLink(undefined);
  // The setting change stops the server; the session created while it was on is cut off.
  const cut = await promptIn(api, linked, "/scenario agent-link");
  const cutCall = linkCall(cut);
  assert(cutCall && cutCall.status === "failed", `the call of a cut-off session fails: ${JSON.stringify(cutCall)}`);

  const plain = await freshSession(api);
  const state = await promptIn(api, plain, "/scenario agent-link");
  const reports = fakeAgentReports(state);
  assert(reports.some((r) => r.includes("kiro-acp-tabs")), `the fake agent saw no kiro-acp-tabs server: ${JSON.stringify(reports)}`);
  const line = await capabilitiesLine(api);
  assertEqual(line, "Agent link: off (kiroAcp.agentLink.enabled is off)", "capabilities line");
});

test("F17.3 an agent without mcpCapabilities.http is never offered the server", async ({ api }) => {
  const config = vscode.workspace.getConfiguration("kiroAcp");
  const prior = config.get<string[]>("cliArgs", []);
  await config.update("cliArgs", [...prior, "--no-mcp-http"], vscode.ConfigurationTarget.Workspace);
  await setLink(true);
  try {
    await withTimeout(api.controller.restart(), 30_000, "restart() with --no-mcp-http");
    await ensureReady(api);
    const session = await freshSession(api);
    const state = await promptIn(api, session, "/scenario agent-link");
    assert(fakeAgentReports(state).some((r) => r.includes("kiro-acp-tabs")), "no kiro-acp-tabs server reached the agent");
    const line = await capabilitiesLine(api);
    assertEqual(line, "Agent link: off (the agent does not advertise mcpCapabilities.http)", "capabilities line");
  } finally {
    await setLink(undefined);
    await config.update("cliArgs", prior, vscode.ConfigurationTarget.Workspace);
    await withTimeout(api.controller.restart(), 30_000, "restart() without --no-mcp-http");
    await ensureReady(api);
  }
});
