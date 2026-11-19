/**
 * F18 — agent link stages 2–4 (D30): sessions read, message, wait for and
 * start each other through the `kiro-acp-tabs` tools, end to end. The fake
 * agent acts as the MCP client (`/scenario link-send <handle>` + lines, …) and,
 * on the receiving side, runs the `/scenario <name>` named in the body of the
 * framed peer message it got (`peer-echo` answers with the exact text the
 * agent received, so the frame can be checked).
 *
 * Each test works in views of its own groups (stand-ins for chat tabs, like
 * F14), created after the setting is on so every session gets the server, and
 * closes them again.
 */
import * as vscode from "vscode";

import {
  Recorder,
  assert,
  assertEqual,
  closeAllEditors,
  dialogs,
  ensureReady,
  messagesOf,
  test,
  textOf,
  waitFor,
  withTimeout,
} from "./harness.js";
import { PEER_MESSAGE_PREFIX } from "../../src/agentLink/peerMessage.js";
import type { KiroAcpApi } from "../../src/extension.js";
import type { ViewHandle } from "../../src/ui/chatController.js";
import type { MessageView, PermissionView, ToolCallView, UiState } from "../../src/ui/protocol.js";

// ---------------------------------------------------------------------------
// Settings, tabs and turns
// ---------------------------------------------------------------------------

/** Settings a workspace may not override (scope `machine`) are written to the user settings. */
const MACHINE_SCOPED = new Set(["agentLink.confirm", "agentLink.maxChain", "agentLink.autoApprove", "fs.allowedWriteRoots"]);

async function setSetting(key: string, value: unknown): Promise<void> {
  const target = MACHINE_SCOPED.has(key) ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
  await vscode.workspace.getConfiguration("kiroAcp").update(key, value, target);
}

interface Tab {
  view: ViewHandle;
  recorder: Recorder;
  groupId: string;
  /** The session the tab was opened with. */
  sessionId: string;
}

interface LinkContext {
  /** A view of a group of its own with a fresh, linked session. */
  open(name: string): Promise<Tab>;
}

let groupSeq = 0;

/**
 * Run `body` with the agent link on (`confirm` default `never`, so only the
 * confirmation tests see cards) and close every tab it opened afterwards.
 */
async function withLink(
  api: KiroAcpApi,
  settings: { confirm?: "firstPerPair" | "always" | "never"; maxChain?: number; autoApprove?: boolean },
  body: (ctx: LinkContext) => Promise<void>,
): Promise<void> {
  await ensureReady(api);
  await setSetting("agentLink.enabled", true);
  await setSetting("agentLink.confirm", settings.confirm ?? "never");
  if (settings.maxChain !== undefined) await setSetting("agentLink.maxChain", settings.maxChain);
  if (settings.autoApprove !== undefined) await setSetting("agentLink.autoApprove", settings.autoApprove);
  const tabs: Tab[] = [];
  const open = async (name: string): Promise<Tab> => {
    const recorder = new Recorder();
    const groupId = `f18-${name}-${++groupSeq}`;
    const view = api.controller.attachView(recorder.poster, { prefer: "fresh", groupId });
    const tab: Tab = { view, recorder, groupId, sessionId: "" };
    tabs.push(tab);
    const id = await withTimeout(api.controller.newSession(view), 15_000, `a session in ${groupId}`);
    assert(id, `a new session in ${groupId}`);
    tab.sessionId = id;
    return tab;
  };
  try {
    await body({ open });
  } finally {
    for (const tab of tabs) tab.view.dispose();
    for (const tab of tabs) await api.controller.closeGroup(tab.groupId);
    if (api.controller.agentMessagesPaused) api.controller.resumeAgentMessages();
    await setSetting("agentLink.confirm", undefined);
    await setSetting("agentLink.maxChain", undefined);
    await setSetting("agentLink.autoApprove", undefined);
    await setSetting("agentLink.enabled", undefined);
  }
}

/** The agent-link handle of a live session (`s3`). */
function handleOf(api: KiroAcpApi, sessionId: string): string {
  const self = api.controller.listSessions(sessionId).find((s) => s.self);
  assert(self, `session ${sessionId} is listed`);
  return self.handle;
}

function snapshot(api: KiroAcpApi, sessionId: string): UiState {
  return api.controller.snapshot(sessionId);
}

/** Send `text` to `sessionId` and wait for its turn to end. */
async function promptIn(api: KiroAcpApi, sessionId: string, text: string): Promise<UiState> {
  await withTimeout(api.controller.prompt(text, [], sessionId), 30_000, `turn for ${JSON.stringify(text.slice(0, 80))} in ${sessionId}`);
  return waitFor(
    () => {
      const state = snapshot(api, sessionId);
      return state.turnActive ? undefined : state;
    },
    15_000,
    `the turn in ${sessionId} to end`,
  );
}

/** Wait until `sessionId` has no turn and `predicate` holds for its state. */
function settled(api: KiroAcpApi, sessionId: string, predicate: (state: UiState) => boolean, label: string): Promise<UiState> {
  return waitFor(
    () => {
      const state = snapshot(api, sessionId);
      return !state.turnActive && predicate(state) ? state : undefined;
    },
    20_000,
    label,
  );
}

function agentText(state: UiState): string {
  return messagesOf(state)
    .filter((m) => m.role === "agent")
    .map(textOf)
    .join("\n");
}

function userMessages(state: UiState): MessageView[] {
  return messagesOf(state).filter((m) => m.role === "user");
}

function noReports(state: UiState): void {
  const reports = messagesOf(state)
    .map(textOf)
    .filter((t) => t.includes("[fake-agent]"));
  assertEqual(reports.length, 0, `fake-agent reports: ${JSON.stringify(reports)}`);
}

// ---------------------------------------------------------------------------
// The tool calls the fake agent made
// ---------------------------------------------------------------------------

/** The fake agent's `kiro-acp-tabs/<tool>` cards in transcript order. */
function linkCalls(state: UiState, tool: string): ToolCallView[] {
  const title = `kiro-acp-tabs/${tool}`;
  return state.items.flatMap((item) => {
    if (item.type !== "tool") return [];
    const call = state.toolCalls[item.toolCallId];
    return call && call.title === title ? [call] : [];
  });
}

function lastCall(state: UiState, tool: string): ToolCallView {
  const calls = linkCalls(state, tool);
  const call = calls[calls.length - 1];
  assert(call, `a ${tool} tool card: ${JSON.stringify(Object.values(state.toolCalls).map((c) => c.title))}`);
  return call;
}

interface ToolOutcome {
  text: string;
  data: Record<string, unknown>;
  isError: boolean;
}

/** The CallToolResult the fake agent put into `rawOutput`. */
function outcomeOf(call: ToolCallView): ToolOutcome {
  const raw = call.rawOutput as { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
  assert(raw && Array.isArray(raw.content), `${call.title} has a tool result: ${JSON.stringify(call.rawOutput)}`);
  return {
    text: raw.content.map((c) => c.text ?? "").join("\n"),
    data: raw.structuredContent ?? {},
    isError: raw.isError === true,
  };
}

function assertRefused(call: ToolCallView, code: string, label: string): ToolOutcome {
  const outcome = outcomeOf(call);
  assertEqual(call.status, "failed", `${label}: the card fails`);
  assert(outcome.isError, `${label}: an isError result`);
  assertEqual(outcome.data.error, code, `${label}: error code (${outcome.text})`);
  return outcome;
}

// ---------------------------------------------------------------------------
// Confirmation cards, output, sign-in
// ---------------------------------------------------------------------------

/** The pending agent-link confirmation of `sessionId` (`capability` agent_link_message / agent_link_start_session). */
function pendingConfirmation(api: KiroAcpApi, sessionId: string, capability = "agent_link_message"): Promise<PermissionView> {
  return waitFor(
    () =>
      api.permissions
        .pending()
        .find((p) => p.consent?.capability === capability && api.permissions.getEntry(p.requestId)?.sessionId === sessionId),
    15_000,
    `a ${capability} confirmation in ${sessionId}`,
  );
}

function pendingOf(api: KiroAcpApi, sessionId: string): PermissionView[] {
  return api.permissions.pending().filter((p) => api.permissions.getEntry(p.requestId)?.sessionId === sessionId);
}

/** Lines the extension writes to the Kiro ACP output channel from now on. */
function captureOutput(api: KiroAcpApi): { lines: string[]; dispose(): void } {
  // An own property shadows the channel's prototype method; deleting it restores the method.
  const output = api.output as unknown as { appendLine?: (value: string) => void };
  const original = api.output.appendLine.bind(api.output);
  const lines: string[] = [];
  output.appendLine = (value: string): void => {
    lines.push(value);
    original(value);
  };
  return {
    lines,
    dispose: () => {
      delete output.appendLine;
    },
  };
}

/** `login()` with the fake sign-in (exits 0, the chat reconnects and restores); closes the login terminals after. */
async function signInAgain(api: KiroAcpApi): Promise<void> {
  const opened: vscode.Terminal[] = [];
  const sub = vscode.window.onDidOpenTerminal((t) => opened.push(t));
  try {
    await withTimeout(api.controller.login(), 60_000, "login() and the restore after it");
  } finally {
    sub.dispose();
  }
  for (const t of [...opened, ...vscode.window.terminals.filter((t) => t.name === "Kiro login")]) t.dispose();
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test("F18.1 send_message to an idle session starts its turn; the message says who sent it and the agent gets the frame", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);
    const body = "/scenario peer-echo\nPlease review **this** change:\n- the login check";

    // Handles are case-insensitive.
    const sender = await promptIn(api, a.sessionId, `/scenario link-send ${hB.toUpperCase()}\n${body}`);
    noReports(sender);
    const call = lastCall(sender, "send_message");
    assertEqual(call.status, "completed", "send_message completed");
    const sent = outcomeOf(call);
    assertEqual(sent.data.delivery, "started", "delivery to an idle session");
    assertEqual((sent.data.to as { handle?: string }).handle, hB, "the result names the target");
    assert(sent.text.startsWith(`Delivered to ${hB} `) && sent.text.includes("it started working on it now"), sent.text);
    const senderTitle = api.controller.listSessions(a.sessionId).find((s) => s.self)?.title ?? "";

    const target = await settled(api, b.sessionId, (s) => agentText(s).includes("Received from"), "the target's turn");
    noReports(target);
    const users = userMessages(target);
    assertEqual(users.length, 1, "one user message in the target");
    const peer = users[0]!;
    assertEqual(textOf(peer), body, "the target shows the raw text, without the frame");
    assertEqual(peer.origin?.sessionId, a.sessionId, "origin: the sender's session");
    assertEqual(peer.origin?.handle, hA, "origin: the sender's handle");
    assertEqual(peer.origin?.title, senderTitle, "origin: the sender's title");
    assertEqual(peer.delivery, undefined, "no delivery badge on a message that started a turn");
    assert(b.recorder.ofType("messageOrigin").some((m) => m.messageId === peer.id && m.origin.handle === hA), "a messageOrigin post");
    assert(!b.recorder.ofType("messageDelivery").some((m) => m.delivery === "steering"), "a peer message is never steered");

    // The target's title comes from the message (its first line).
    const targetInfo = api.controller.listSessions(a.sessionId).find((s) => s.handle === hB);
    assertEqual(targetInfo?.title, "/scenario peer-echo", "the target's title");

    // What the agent received: the frame around the text.
    const received = agentText(target);
    assert(received.includes(`Received from ${hA} (depth 1):`), received);
    assert(
      received.includes(`${PEER_MESSAGE_PREFIX} — ${hA} ${JSON.stringify(senderTitle)} in tab ${JSON.stringify(a.groupId)}.`),
      `the header names the sender: ${received}`,
    );
    assert(received.includes("It was not written by the user"), received);
    assert(!received.includes("in a chain of messages"), "a first message names no chain");
    assert(received.includes(`\n\n${body}\n\n`), `the text is passed verbatim: ${received}`);
    assert(received.includes(`send_message (to: ${JSON.stringify(hA)})`), `the footer says how to reply: ${received}`);
  });
});

test("F18.2 send_message to a busy session queues it (badge) and delivers it when the turn ends; never steered", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hB = handleOf(api, b.sessionId);
    const slow = api.controller.prompt("/scenario slow", [], b.sessionId);
    await waitFor(() => snapshot(api, b.sessionId).turnActive || undefined, 15_000, "the target's slow turn");

    const body = "/scenario peer-echo\nwhen you are done";
    const sender = await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n${body}`);
    const sent = outcomeOf(lastCall(sender, "send_message"));
    assertEqual(sent.data.delivery, "queued", "delivery to a busy session");
    assert(sent.text.includes("it is busy and gets it when its current turn ends"), sent.text);

    const queued = userMessages(snapshot(api, b.sessionId)).find((m) => textOf(m) === body);
    assert(queued, "the message is echoed in the target at once");
    assertEqual(queued.delivery, "queued", "queued badge");
    assert(queued.origin, "the queued message carries its origin");
    assertEqual(snapshot(api, b.sessionId).turnActive, true, "the target's own turn goes on");

    await withTimeout(slow, 15_000, "the slow turn");
    await waitFor(
      () => b.recorder.ofType("messageDelivery").some((m) => m.messageId === queued.id && m.delivery === null),
      15_000,
      "the queued badge to clear",
    );
    const target = await settled(api, b.sessionId, (s) => agentText(s).includes("Received from"), "the queued message's turn");
    assertEqual(userMessages(target).find((m) => m.id === queued.id)?.delivery, undefined, "no badge left");
    assert(!b.recorder.ofType("messageDelivery").some((m) => m.delivery === "steering"), "never steered");
    assert(agentText(target).includes("when you are done"), "the agent got it as its own turn");
  });
});

test("F18.3 send_message refusals: self, unknown session, empty text, text over 32 KiB", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);
    const send = async (to: string, text: string): Promise<ToolCallView> =>
      lastCall(await promptIn(api, a.sessionId, `/scenario link-send ${to}${text ? `\n${text}` : ""}`), "send_message");

    assertRefused(await send(hA, "/scenario chat\nhello me"), "self", "to itself");
    const unknown = assertRefused(await send("s9999", "/scenario chat\nhello"), "unknown_session", "unknown handle");
    assert(unknown.text.includes("list_sessions"), `the refusal points at list_sessions: ${unknown.text}`);
    assertRefused(await send(hB, ""), "empty_text", "empty text");
    const tooLong = assertRefused(await send(hB, `/scenario chat\n${"x".repeat(33 * 1024)}`), "too_long", "33 KiB");
    assert(tooLong.text.includes("32 KiB"), tooLong.text);
    assertEqual(userMessages(snapshot(api, b.sessionId)).length, 0, "nothing reached the target");

    // The other tools refuse the same way.
    assertRefused(lastCall(await promptIn(api, a.sessionId, `/scenario link-wait ${hA}`), "wait_for_session"), "self", "waiting for itself");
    assertRefused(lastCall(await promptIn(api, a.sessionId, "/scenario link-read s9999"), "read_session"), "unknown_session", "reading an unknown session");
    assertRefused(lastCall(await promptIn(api, a.sessionId, `/scenario link-read ${hB} 0`), "read_session"), "invalid_argument", "last: 0");
  });
});

// ---------------------------------------------------------------------------
// Replies, chains, rate
// ---------------------------------------------------------------------------

test("F18.4 a reply comes back to the sender as a peer message, framed as message 2 of a chain", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);
    await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n/scenario peer-reply`);

    const target = await settled(api, b.sessionId, (s) => agentText(s).includes("Reply "), "the target's reply turn");
    noReports(target);
    assertEqual(lastCall(target, "send_message").status, "completed", "the reply was sent");

    const back = await settled(api, a.sessionId, (s) => agentText(s).includes(`Received from ${hB}`), "the reply's turn in the sender");
    const reply = userMessages(back).find((m) => m.origin);
    assert(reply, "the sender shows the reply as a peer message");
    assertEqual(textOf(reply), `/scenario peer-echo\nReply to ${hA}`, "the reply text");
    assertEqual(reply.origin?.handle, hB, "the reply's origin");
    const received = agentText(back);
    assert(received.includes(`Received from ${hB} (depth 2):`), received);
    assert(received.includes("This is message 2 in a chain of messages between agents."), received);
  });
});

test("F18.5 kiroAcp.agentLink.maxChain = 1: a send from a peer-started turn is refused, with a notice in both chats", async ({ api }) => {
  await withLink(api, { maxChain: 1 }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);
    const sender = await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n/scenario peer-reply`);
    assertEqual(outcomeOf(lastCall(sender, "send_message")).data.delivery, "started", "the first message (depth 1) goes");

    const target = await settled(api, b.sessionId, (s) => agentText(s).includes("Reply "), "the target's reply turn");
    const refused = assertRefused(lastCall(target, "send_message"), "chain_limit", "the reply");
    assert(refused.text.includes("kiroAcp.agentLink.maxChain"), refused.text);
    assert(
      target.notices.some((n) => n.text.startsWith(`Agent message chain stopped: this session tried to message ${hA}`)),
      `a notice in the target: ${JSON.stringify(target.notices)}`,
    );
    const senderState = snapshot(api, a.sessionId);
    assert(
      senderState.notices.some((n) => n.text.startsWith(`Agent message chain stopped: ${hB} `)),
      `a notice in the sender: ${JSON.stringify(senderState.notices)}`,
    );
    assertEqual(userMessages(senderState).filter((m) => m.origin).length, 0, "no reply reached the sender");
  });
});

test("F18.5b maxChain = 1: text the user steers into a peer-started turn starts the chain over, so its reply goes out", async ({ api }) => {
  await withLink(api, { maxChain: 1 }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);
    const sender = await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n/scenario peer-reply-late`);
    assertEqual(outcomeOf(lastCall(sender, "send_message")).data.delivery, "started", "the first message (depth 1) goes");

    // The target's peer-started turn (depth 1 = maxChain) is still working: the user steers it.
    await waitFor(
      () => {
        const s = snapshot(api, b.sessionId);
        return s.turnActive && agentText(s).includes("Working on it.") ? s : undefined;
      },
      10_000,
      "the target's turn running",
    );
    await withTimeout(api.controller.prompt("Go ahead and answer.", [], b.sessionId), 10_000, "steering the target");

    const target = await settled(api, b.sessionId, (s) => agentText(s).includes("Reply "), "the target's reply turn");
    const reply = lastCall(target, "send_message");
    assertEqual(reply.status, "completed", `the reply is not refused: ${JSON.stringify(reply)}`);
    assert(
      !target.notices.some((n) => n.text.startsWith("Agent message chain stopped")),
      `no chain notice in the target: ${JSON.stringify(target.notices)}`,
    );
    const back = await settled(
      api,
      a.sessionId,
      (s) => userMessages(s).some((m) => m.origin?.sessionId === b.sessionId),
      "the reply in the sender",
    );
    assertEqual(userMessages(back).filter((m) => m.origin?.handle === hB).length, 1, `one reply from ${hB} reached ${hA}`);
  });
});

test("F18.6 the 11th message within a minute is refused (rate_limited); the first ten are delivered", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hB = handleOf(api, b.sessionId);
    const sender = await promptIn(api, a.sessionId, `/scenario link-send-burst ${hB} 11`);
    noReports(sender);
    const calls = linkCalls(sender, "send_message");
    assertEqual(calls.length, 11, "eleven send_message calls");
    for (const [i, call] of calls.slice(0, 10).entries()) assertEqual(call.status, "completed", `message ${i + 1}`);
    const limited = assertRefused(calls[10]!, "rate_limited", "the 11th message");
    assert(limited.text.includes("Too many messages"), limited.text);

    const answers = (s: UiState): number => messagesOf(s).filter((m) => m.role === "agent" && textOf(m) === "The answer is 42.").length;
    const target = await settled(api, b.sessionId, (s) => answers(s) === 10, "ten answers in the target");
    assertEqual(userMessages(target).filter((m) => m.origin?.sessionId === a.sessionId).length, 10, "ten peer messages arrived");
  });
});

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

test("F18.7 confirm firstPerPair: a card in the sender (needs_input) that survives a snapshot; Send delivers, the pair is not asked again", async ({ api }) => {
  await withLink(api, { confirm: "firstPerPair" }, async ({ open }) => {
    const a = await open("a");
    // A second session in the sender's tab, to switch to and back.
    const other = await withTimeout(api.controller.newSession(a.view), 15_000, "a second session in the sender's tab");
    assert(other, "a second session");
    api.controller.selectSession(a.sessionId, a.view);
    const b = await open("b");
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);

    const turn = api.controller.prompt(`/scenario link-send ${hB}\n/scenario peer-echo\nconfirm me`, [], a.sessionId);
    const card = await pendingConfirmation(api, a.sessionId);
    assert(card.title.startsWith(`Send to ${hB} `) && card.title.includes("confirm me"), `card title: ${card.title}`);
    assertEqual(card.options.map((o) => o.name).join(","), "Send,Don't send", "the card's buttons");
    assertEqual(JSON.stringify(card.policies), "[]", "the card offers no session-wide policy");
    await waitFor(
      () => api.controller.listSessions(b.sessionId).find((s) => s.handle === hA)?.status === "needs_input" || undefined,
      15_000,
      "the sender to be needs_input",
    );
    assertEqual(a.view.snapshot().sessions.find((s) => s.id === a.sessionId)?.status, "needs_input", "the session list says so too");
    assertEqual(userMessages(snapshot(api, b.sessionId)).length, 0, "nothing was delivered yet");

    // Switch the tab to the other session and back: the new snapshot still renders the card.
    api.controller.selectSession(other, a.view);
    api.controller.selectSession(a.sessionId, a.view);
    const states = a.recorder.ofType("state");
    const state = states[states.length - 1]?.state;
    assertEqual(state?.sessionId, a.sessionId, "the tab shows the sender again");
    assert(state?.permissions.some((p) => p.requestId === card.requestId), "the snapshot carries the card");
    assertEqual(state?.toolCalls[card.toolCallId]?.status, "pending", "and the tool call it renders in");

    api.permissions.resolve(card.requestId, "send");
    await withTimeout(turn, 15_000, "the sender's turn");
    const sender = await settled(api, a.sessionId, () => true, "the sender's turn to end");
    assertEqual(lastCall(sender, "send_message").status, "completed", "sent after Send");
    assertEqual(sender.toolCalls[card.toolCallId]?.status, "completed", "the card ends completed");
    await settled(api, b.sessionId, (s) => agentText(s).includes("confirm me"), "the target's turn");

    // The pair is allowed now: no second card.
    const mark = a.recorder.mark();
    const again = await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n/scenario chat\nagain`);
    assertEqual(lastCall(again, "send_message").status, "completed", "the second message went");
    assertEqual(a.recorder.ofType("permission", mark).length, 0, "no card the second time");
  });
});

test("F18.8 confirm: Don't send declines (card failed); always asks every time; never never asks", async ({ api }) => {
  await withLink(api, { confirm: "firstPerPair" }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hB = handleOf(api, b.sessionId);
    const sendWithCard = async (text: string, option: "send" | "dont-send"): Promise<{ call: ToolCallView; card: PermissionView; state: UiState }> => {
      const turn = api.controller.prompt(`/scenario link-send ${hB}\n${text}`, [], a.sessionId);
      const card = await pendingConfirmation(api, a.sessionId);
      api.permissions.resolve(card.requestId, option);
      await withTimeout(turn, 15_000, "the sender's turn");
      const state = await settled(api, a.sessionId, () => true, "the sender's turn to end");
      return { call: lastCall(state, "send_message"), card, state };
    };

    const declined = await sendWithCard("/scenario chat\nno thanks", "dont-send");
    const outcome = assertRefused(declined.call, "declined", "Don't send");
    assert(outcome.text.includes("declined"), outcome.text);
    const card = declined.state.toolCalls[declined.card.toolCallId];
    assertEqual(card?.status, "failed", "the card ends failed");
    assert(card?.content.some((c) => c.type === "text" && c.text === "Not sent."), `the card says so: ${JSON.stringify(card?.content)}`);
    assertEqual(userMessages(snapshot(api, b.sessionId)).length, 0, "nothing was delivered");

    await setSetting("agentLink.confirm", "always");
    for (const n of [1, 2]) {
      const { call } = await sendWithCard(`/scenario chat\nalways ${n}`, "send");
      assertEqual(call.status, "completed", `always: message ${n} went after its card`);
    }

    await setSetting("agentLink.confirm", "never");
    const mark = a.recorder.mark();
    const never = await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n/scenario chat\nnever`);
    assertEqual(lastCall(never, "send_message").status, "completed", "never: sent");
    assertEqual(a.recorder.ofType("permission", mark).length, 0, "never: no card");
  });
});

test("F18.9 confirmation cards and session policies stay apart: Kiro's 'always' never sends, the card offers and keeps none", async ({ api }) => {
  // Kiro's own card has to show here, so the extension does not answer it.
  await withLink(api, { confirm: "firstPerPair", autoApprove: false }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const c = await open("c");
    const hB = handleOf(api, b.sessionId);
    const hC = handleOf(api, c.sessionId);

    // Kiro asks its own permission for the MCP call (kind other); the user allows all actions of that kind.
    const turn = api.controller.prompt(`/scenario link-send-asking ${hB}\n/scenario chat\nfrom a`, [], a.sessionId);
    const kiros = await waitFor(
      () => pendingOf(api, a.sessionId).find((p) => p.title === "Use kiro-acp-tabs/send_message"),
      15_000,
      "Kiro's own permission card",
    );
    assertEqual(kiros.kind, "other", "Kiro's card is kind other");
    assert(kiros.policies?.some((p) => p.scope === "kind"), "Kiro's own card still offers its policies");
    api.permissions.setPolicy(kiros.requestId, "allow", "kind");

    // The confirmation still asks, and offers no policy.
    const card = await pendingConfirmation(api, a.sessionId);
    assertEqual(card.kind, "other", "the confirmation is kind other too");
    assertEqual(JSON.stringify(card.policies), "[]", "no policies on the confirmation");
    // An "always" from the card (the webview message) is refused: a warning, and the card stays.
    await api.controller.handle({ type: "permissionAlways", requestId: card.requestId, decision: "allow", scope: "kind" }, a.view);
    assert(api.permissions.get(card.requestId), "the card is still pending");
    assert(
      snapshot(api, a.sessionId).notices.some((n) => n.severity === "warning" && n.text.includes("cannot be remembered")),
      `a warning: ${JSON.stringify(snapshot(api, a.sessionId).notices)}`,
    );
    api.permissions.resolve(card.requestId, "send");
    await withTimeout(turn, 15_000, "the first turn");
    const first = await settled(api, a.sessionId, () => true, "the first turn to end");
    assertEqual(lastCall(first, "send_message").status, "completed", "sent after Send");

    // Kiro's next request of kind other is answered by its policy; the confirmation for a new pair is not.
    const mark = a.recorder.mark();
    const turn2 = api.controller.prompt(`/scenario link-send-asking ${hC}\n/scenario chat\nfrom a`, [], a.sessionId);
    const card2 = await pendingConfirmation(api, a.sessionId);
    assertEqual(pendingOf(api, a.sessionId).length, 1, "only the confirmation is pending (Kiro's own was answered by the policy)");
    assertEqual(a.recorder.ofType("permission", mark).length, 1, "one card shown in this turn");
    api.permissions.resolve(card2.requestId, "dont-send");
    await withTimeout(turn2, 15_000, "the second turn");
    const second = await settled(api, a.sessionId, () => true, "the second turn to end");
    assertRefused(lastCall(second, "send_message"), "declined", "the second message");
    assertEqual(userMessages(snapshot(api, c.sessionId)).length, 0, "nothing reached the new target");
  });
});

// ---------------------------------------------------------------------------
// Reading and waiting
// ---------------------------------------------------------------------------

test("F18.10 read_session returns the target's transcript as text; `last` keeps the newest items", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);
    await promptIn(api, b.sessionId, "/scenario chat");

    const all = outcomeOf(lastCall(await promptIn(api, a.sessionId, `/scenario link-read ${hB}`), "read_session"));
    assertEqual(all.data.text, "user: /scenario chat\n\nagent: The answer is 42.", "the transcript text");
    assertEqual(all.data.items, 2, "two items");
    assertEqual(all.data.truncated, false, "nothing left out");
    assert(all.text.startsWith(`${hB} "/scenario chat"`), `the header names the session: ${all.text}`);

    const last = outcomeOf(lastCall(await promptIn(api, a.sessionId, `/scenario link-read ${hB} 1`), "read_session"));
    assertEqual(last.data.text, "agent: The answer is 42.", "last: 1");
    assertEqual(last.data.truncated, true, "older items left out");

    const own = outcomeOf(lastCall(await promptIn(api, a.sessionId, `/scenario link-read ${hA} 1`), "read_session"));
    assert(own.text.includes("(your own session)"), `a session may read itself: ${own.text}`);
  });
});

test("F18.11 wait_for_session: a working target ends idle with its last answer; a queued message is waited for too", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);

    const started = await promptIn(api, a.sessionId, `/scenario link-send-wait ${hB}\n/scenario peer-slow`);
    noReports(started);
    const waited = outcomeOf(lastCall(started, "wait_for_session"));
    assertEqual(waited.data.outcome, "idle", "the wait ends idle");
    assertEqual(waited.data.lastAnswer, "Slow peer done.", "with the target's last answer");
    assert(waited.text.includes("has finished its turn") && waited.text.endsWith("Its last answer:\nSlow peer done."), waited.text);
    assert(agentText(snapshot(api, b.sessionId)).includes("Slow peer done."), "the target really finished");

    // The target is busy with its own turn: the message queues, and the wait
    // ends only after the queued message's turn, not when the first turn ends.
    const slow = api.controller.prompt("/scenario slow", [], b.sessionId);
    await waitFor(() => snapshot(api, b.sessionId).turnActive || undefined, 15_000, "the target's slow turn");
    const queuedRun = await promptIn(api, a.sessionId, `/scenario link-send-wait ${hB}\n/scenario peer-echo\nqueued, then waited for`);
    assertEqual(outcomeOf(lastCall(queuedRun, "send_message")).data.delivery, "queued", "the message queued");
    const afterQueue = outcomeOf(lastCall(queuedRun, "wait_for_session"));
    assertEqual(afterQueue.data.outcome, "idle", "idle once the queue drained");
    assert(
      typeof afterQueue.data.lastAnswer === "string" && afterQueue.data.lastAnswer.startsWith(`Received from ${hA}`),
      `the last answer is the queued message's: ${JSON.stringify(afterQueue.data.lastAnswer)}`,
    );
    await withTimeout(slow, 15_000, "the slow turn");
  });
});

test("F18.12 wait_for_session: needs_input, closed, timeout, and Stop in the caller ends the wait", async ({ api }) => {
  const output = captureOutput(api);
  try {
    await withLink(api, {}, async ({ open }) => {
      const a = await open("a");
      const b = await open("b");
      const hA = handleOf(api, a.sessionId);
      const hB = handleOf(api, b.sessionId);

      // A permission request in the target ends the wait: it needs its user.
      const asking = await promptIn(api, a.sessionId, `/scenario link-send-wait ${hB}\n/scenario permission-nokind-exec`);
      const needs = outcomeOf(lastCall(asking, "wait_for_session"));
      assertEqual(needs.data.outcome, "needs_input", `needs_input: ${needs.text}`);
      assert(needs.text.includes("waiting for its user"), needs.text);
      const request = pendingOf(api, b.sessionId)[0];
      assert(request, "the target's permission request is pending");
      api.permissions.resolve(request.requestId, "reject");
      await settled(api, b.sessionId, () => true, "the target's turn after the answer");

      // Timeout: the target is still working after 1 s (it stays busy until it is closed below).
      const slow = api.controller.prompt("/scenario slow-long", [], b.sessionId);
      await waitFor(() => snapshot(api, b.sessionId).turnActive || undefined, 15_000, "the target's long turn");
      const timedOut = outcomeOf(lastCall(await promptIn(api, a.sessionId, `/scenario link-wait ${hB} 1`), "wait_for_session"));
      assertEqual(timedOut.data.outcome, "timeout", `timeout: ${timedOut.text}`);
      assert(timedOut.text.includes("still working after 1 s"), timedOut.text);

      // Stop in the caller: its tool call goes away and the host drops the wait.
      const logged = (from: number, text: string): boolean => output.lines.slice(from).some((l) => l.includes(text));
      let mark = output.lines.length;
      const waiting = api.controller.prompt(`/scenario link-wait ${hB}`, [], a.sessionId);
      await waitFor(() => logged(mark, `agent-link ${hA} waits for ${hB}`) || undefined, 15_000, "the wait to start");
      const startedAt = Date.now();
      await api.controller.cancel(a.sessionId);
      await withTimeout(waiting, 15_000, "the cancelled turn");
      await waitFor(() => logged(mark, `agent-link ${hA} wait for ${hB}: aborted`) || undefined, 15_000, "the host to drop the wait");
      assert(Date.now() - startedAt < 4_000, "Stop ended the wait at once, not the watchdog or the target");
      const cancelled = await settled(api, a.sessionId, () => true, "the caller's turn to end");
      assertEqual(lastCall(cancelled, "wait_for_session").status, "failed", "the wait's card ends failed");
      assertEqual(snapshot(api, b.sessionId).turnActive, true, "the target was not touched");

      // Closed: the target goes away while the caller waits.
      mark = output.lines.length;
      const closing = api.controller.prompt(`/scenario link-wait ${hB}`, [], a.sessionId);
      await waitFor(() => logged(mark, `agent-link ${hA} waits for ${hB}`) || undefined, 15_000, "the second wait to start");
      await api.controller.closeSession(b.sessionId);
      await withTimeout(closing, 15_000, "the waiting turn");
      const closed = outcomeOf(lastCall(await settled(api, a.sessionId, () => true, "the caller's turn"), "wait_for_session"));
      assertEqual(closed.data.outcome, "closed", `closed: ${closed.text}`);
      assertEqual(closed.data.session, null, "no session info for a closed target");
      assert(closed.text.includes("was closed"), closed.text);
      await withTimeout(slow, 15_000, "the closed target's turn (cancelled by the close)");
    });
  } finally {
    output.dispose();
  }
});

// ---------------------------------------------------------------------------
// Starting sessions
// ---------------------------------------------------------------------------

test("F18.13 start_session: sameTab keeps the caller's view and lists the new session; newTab opens a chat tab; it asks first", async ({ api }) => {
  await closeAllEditors();
  try {
    await withLink(api, {}, async ({ open }) => {
      const a = await open("a");
      const hA = handleOf(api, a.sessionId);
      const idOf = (handle: string): string => {
        const info = api.controller.listSessions(a.sessionId).find((s) => s.handle === handle);
        assert(info, `${handle} is listed`);
        return info.sessionId;
      };

      // sameTab: in the caller's group, the caller's view stays on the caller.
      const same = await promptIn(api, a.sessionId, "/scenario link-start sameTab\n/scenario peer-echo\nstarted in the same tab");
      noReports(same);
      const sameResult = outcomeOf(lastCall(same, "start_session"));
      assertEqual(sameResult.data.delivery, "started", "the new session started on its prompt");
      const sameHandle = (sameResult.data.session as { handle: string }).handle;
      const sameId = idOf(sameHandle);
      assertEqual(a.view.sessionId, a.sessionId, "the caller's view still shows the caller");
      assertEqual(api.controller.sessionGroup(sameId), a.groupId, "the new session is in the caller's tab");
      await waitFor(
        () => a.view.snapshot().sessions.some((s) => s.id === sameId && s.handle === sameHandle) || undefined,
        15_000,
        "the new session in the caller's session list",
      );
      const started = await settled(api, sameId, (s) => agentText(s).includes("Received from"), "the new session's turn");
      assertEqual(userMessages(started)[0]?.origin?.handle, hA, "its prompt came from the caller");

      // newTab: a chat tab opens on the new session.
      const before = new Set(api.panel.panels());
      const tabbed = await promptIn(api, a.sessionId, "/scenario link-start newTab\n/scenario peer-echo\nstarted in a new tab");
      const newHandle = (outcomeOf(lastCall(tabbed, "start_session")).data.session as { handle: string }).handle;
      const newId = idOf(newHandle);
      const panel = await waitFor(() => api.panel.panels().find((p) => !before.has(p)), 15_000, "a new chat tab");
      assertEqual(api.panel.sessionOf(panel), newId, "the new tab shows the new session");
      assert(api.controller.sessionGroup(newId) !== a.groupId, "the new session belongs to the new tab");
      assertEqual(a.view.sessionId, a.sessionId, "the caller's view still shows the caller");
      await settled(api, newId, (s) => agentText(s).includes("started in a new tab"), "the new tab's session turn");

      // Starting a session always asks unless confirm is never.
      await setSetting("agentLink.confirm", "firstPerPair");
      const turn = api.controller.prompt("/scenario link-start sameTab\n/scenario chat\nplease", [], a.sessionId);
      const card = await pendingConfirmation(api, a.sessionId, "agent_link_start_session");
      assert(card.title.startsWith("Start a new session:"), card.title);
      assertEqual(JSON.stringify(card.policies), "[]", "no policies on the start card either");
      api.permissions.resolve(card.requestId, "send");
      await withTimeout(turn, 15_000, "the start turn");
      const asked = await settled(api, a.sessionId, () => true, "the start turn to end");
      assertEqual(lastCall(asked, "start_session").status, "completed", "started after Send");
    });
  } finally {
    await closeAllEditors();
  }
});

// ---------------------------------------------------------------------------
// Reveal, pause, handles
// ---------------------------------------------------------------------------

test("F18.14 clicking the sender of a peer message reveals its tab; a closed sender gives a notice", async ({ api }) => {
  await closeAllEditors();
  await ensureReady(api);
  await setSetting("agentLink.enabled", true);
  await setSetting("agentLink.confirm", "never");
  try {
    const p1 = api.panel.openNew();
    const p2 = api.panel.openNew();
    const v1 = api.panel.viewOf(p1);
    const v2 = api.panel.viewOf(p2);
    assert(v1 && v2, "both tabs have controller views");
    // Let each tab settle on its first session, then give it one created with the link on.
    await waitFor(() => (api.panel.sessionOf(p1) && api.panel.sessionOf(p2) ? true : undefined), 15_000, "a session in each tab");
    const s1 = await withTimeout(api.controller.newSession(v1), 15_000, "a linked session in tab 1");
    const s2 = await withTimeout(api.controller.newSession(v2), 15_000, "a linked session in tab 2");
    assert(s1 && s2, "a session in each tab");
    const h2 = handleOf(api, s2);

    await promptIn(api, s1, `/scenario link-send ${h2}\n/scenario peer-echo\nfrom tab 1`);
    const target = await settled(api, s2, (s) => agentText(s).includes("Received from"), "the message in tab 2");
    const peer = userMessages(target).find((m) => m.origin);
    assertEqual(peer?.origin?.sessionId, s1, "the peer message names the sender");

    p2.reveal(p2.viewColumn);
    await waitFor(() => p2.active || undefined, 15_000, "tab 2 in front");
    await api.controller.handle({ type: "revealSession", sessionId: s1 }, v2);
    await waitFor(() => p1.active || undefined, 15_000, "tab 1 (the sender's) in front");
    assertEqual(api.controller.focusedSessionId, s1, "the sender's session is focused");

    await api.controller.handle({ type: "revealSession", sessionId: "no-such-session" }, v2);
    assert(
      snapshot(api, s2).notices.some((n) => n.text === "That session is closed."),
      `a notice in the requesting tab: ${JSON.stringify(snapshot(api, s2).notices)}`,
    );
  } finally {
    await setSetting("agentLink.confirm", undefined);
    await setSetting("agentLink.enabled", undefined);
    await closeAllEditors();
  }
});

test("F18.15 Pause Agent Messages drops queued peer messages and refuses send/start; /capabilities says so; Resume works", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hB = handleOf(api, b.sessionId);

    // The target is busy; a prompt its user queued and two peer messages wait behind its turn.
    api.controller.setSteerUnsupportedForTests(b.sessionId, true);
    const slow = api.controller.prompt("/scenario slow-long", [], b.sessionId);
    await waitFor(() => snapshot(api, b.sessionId).turnActive || undefined, 15_000, "the target's long turn");
    await withTimeout(api.controller.prompt("/scenario chat typed by the user", [], b.sessionId), 15_000, "the user's queued prompt");
    for (const n of [1, 2]) {
      const sent = await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n/scenario peer-echo\npeer ${n}`);
      assertEqual(outcomeOf(lastCall(sent, "send_message")).data.delivery, "queued", `peer message ${n} queued`);
    }

    const dialogCount = dialogs.length;
    await vscode.commands.executeCommand("kiroAcp.pauseAgentMessages");
    assert(api.controller.agentMessagesPaused, "paused");
    assert(
      dialogs.slice(dialogCount).some((d) => d.includes("agent messages paused") && d.includes("2 queued agent messages were discarded")),
      `the pause message: ${JSON.stringify(dialogs.slice(dialogCount))}`,
    );
    const paused = snapshot(api, b.sessionId);
    for (const n of [1, 2]) {
      const dropped = userMessages(paused).find((m) => textOf(m) === `/scenario peer-echo\npeer ${n}`);
      assertEqual(dropped?.delivery, undefined, `peer message ${n} lost its badge`);
    }
    assertEqual(
      userMessages(paused).find((m) => textOf(m) === "/scenario chat typed by the user")?.delivery,
      "queued",
      "what the user queued stays queued",
    );
    assert(paused.notices.some((n) => n.text === "2 queued messages discarded."), `discarded notice: ${JSON.stringify(paused.notices)}`);

    const refusedSend = await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n/scenario chat\nwhile paused`);
    assertRefused(lastCall(refusedSend, "send_message"), "paused", "send while paused");
    const refusedStart = await promptIn(api, a.sessionId, "/scenario link-start sameTab\n/scenario chat\nwhile paused");
    assertRefused(lastCall(refusedStart, "start_session"), "paused", "start while paused");

    const caps = await promptIn(api, a.sessionId, "/capabilities");
    const capsText = textOf(messagesOf(caps).filter((m) => m.role === "agent").at(-1)!);
    assert(capsText.includes("- agent messages paused (`Kiro: Resume Agent Messages` resumes them)"), capsText.slice(-500));

    // Stop ends the target's answer only: what its user queued still runs (D22), the dropped peer messages do not.
    await api.controller.cancel(b.sessionId);
    await withTimeout(slow, 15_000, "the stopped turn");
    const drained = await settled(
      api,
      b.sessionId,
      (s) => agentText(s).includes("The answer is 42."),
      "the user's queued prompt to run",
    );
    assert(!agentText(drained).includes("Received from"), "the dropped peer messages never ran");

    await vscode.commands.executeCommand("kiroAcp.resumeAgentMessages");
    assert(!api.controller.agentMessagesPaused, "resumed");
    const resumed = await promptIn(api, a.sessionId, `/scenario link-send ${hB}\n/scenario chat\nresumed`);
    assertEqual(lastCall(resumed, "send_message").status, "completed", "sending works again");
  });
});

test("F18.16 handles are listed and kept across a sign-in restore; the restored sessions still reach each other", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const tab = await open("restore");
    for (const id of ["past-2", "past-1"]) {
      assertEqual(await withTimeout(api.controller.openPastSession(id, tab.view), 15_000, `restore ${id}`), id, `${id} opened`);
    }
    const h1 = handleOf(api, "past-1");
    const h2 = handleOf(api, "past-2");
    assert(h1 !== h2 && /^s\d+$/.test(h1) && /^s\d+$/.test(h2), `distinct handles: ${h1}, ${h2}`);
    const listed = tab.view.snapshot().sessions;
    assertEqual(listed.find((s) => s.id === "past-1")?.handle, h1, "the session list carries the handle");
    assertEqual(listed.find((s) => s.id === "past-2")?.handle, h2, "for every session");
    const listing = await promptIn(api, "past-2", "/scenario agent-link");
    const text = agentText(listing);
    assert(text.includes(`You are ${h2} "Add retry to fetch"`), text);
    assert(text.includes(`- ${h1} "Investigate flaky CI"`), text);

    await signInAgain(api);

    assertEqual(api.controller.snapshot().connection.status, "ready", "reconnected");
    assertEqual(handleOf(api, "past-1"), h1, "past-1 keeps its handle");
    assertEqual(handleOf(api, "past-2"), h2, "past-2 keeps its handle");
    const sent = await promptIn(api, "past-2", `/scenario link-send ${h1}\n/scenario peer-echo\nafter the sign-in`);
    assertEqual(lastCall(sent, "send_message").status, "completed", "a restored session messages another by its old handle");
    const target = await settled(api, "past-1", (s) => agentText(s).includes("after the sign-in"), "the restored target's turn");
    assertEqual(userMessages(target).find((m) => m.origin)?.origin?.handle, h2, "from the restored sender");
  });
});

test("F18.17 an orchestrator starts a helper, waits for it and reads its answer", async ({ api }) => {
  await withLink(api, {}, async ({ open }) => {
    const a = await open("a");
    const hA = handleOf(api, a.sessionId);
    const done = await promptIn(api, a.sessionId, "/scenario link-orchestrate sameTab\n/scenario peer-slow");
    noReports(done);
    const started = outcomeOf(lastCall(done, "start_session"));
    const helper = (started.data.session as { handle: string }).handle;
    assertEqual(outcomeOf(lastCall(done, "wait_for_session")).data.outcome, "idle", "the wait ended when the helper finished");
    const read = outcomeOf(lastCall(done, "read_session"));
    assert(String(read.data.text).endsWith("agent: Slow peer done."), `the read sees the helper's answer: ${String(read.data.text)}`);
    assert(agentText(done).includes(`Helper ${helper} answered: Slow peer done.`), agentText(done));
    const helperId = api.controller.listSessions(a.sessionId).find((s) => s.handle === helper)?.sessionId;
    assert(helperId, "the helper is listed");
    assertEqual(userMessages(snapshot(api, helperId)).find((m) => m.origin)?.origin?.handle, hA, "the helper's prompt came from the orchestrator");
  });
});

test("F18.18 kiroAcp.agentLink.autoApprove answers Kiro's own card for an agent-link tool; with confirm = never no card shows at all", async ({ api }) => {
  await withLink(api, { confirm: "never" }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hB = handleOf(api, b.sessionId);
    const mark = a.recorder.mark();
    const sender = await promptIn(api, a.sessionId, `/scenario link-send-asking ${hB}
/scenario chat
from a`);
    assertEqual(lastCall(sender, "send_message").status, "completed", "sent");
    assertEqual(a.recorder.ofType("permission", mark).length, 0, "no card in the sender (autoApprove is on by default)");
    await settled(api, b.sessionId, (s) => userMessages(s).some((m) => m.origin?.sessionId === a.sessionId), "the message in the target");

    // Turned off, Kiro's card shows again (and only Kiro's: confirm is never).
    await setSetting("agentLink.autoApprove", false);
    const turn = api.controller.prompt(`/scenario link-send-asking ${hB}
/scenario chat
again`, [], a.sessionId);
    const kiros = await waitFor(
      () => pendingOf(api, a.sessionId).find((p) => p.title === "Use kiro-acp-tabs/send_message"),
      15_000,
      "Kiro's own permission card",
    );
    api.permissions.resolve(kiros.requestId, "allow");
    await withTimeout(turn, 15_000, "the second turn");
    const again = await settled(api, a.sessionId, () => true, "the second turn to end");
    assertEqual(lastCall(again, "send_message").status, "completed", "sent after Allow");
  });
});
