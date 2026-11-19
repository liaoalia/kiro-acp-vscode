/**
 * F19 — one kiro-cli process per session (D31). Every test restarts the
 * fake agent with `--serial-turns`, so each process runs one turn at a time
 * like the real CLI, and restores the settings (and restarts again) after:
 * sessions in different tabs stream at the same time, `agentProcesses.max = 1`
 * brings the shared process (and its waiting) back, closing a session stops
 * its process, a process that exits takes only its own sessions down and the
 * next message (a peer message too) loads the session into a new one, a
 * sign-in restores every session into a process of its own, and an
 * agent-link wait from inside a turn sees its target run (with one shared
 * process it can only time out).
 *
 * The fake keeps sessions in memory, per process: only the canned past
 * sessions (`past-1`, `past-2`), which every process knows, can be loaded
 * into a new process; a fresh session cannot, which F19.4 uses to check the
 * "cannot be loaded" path.
 */
import * as vscode from "vscode";

import {
  assert,
  assertEqual,
  ensureReady,
  messagesOf,
  sleep,
  test,
  textOf,
  waitFor,
  withTimeout,
} from "./harness.js";
import type { KiroAcpApi } from "../../src/extension.js";
import type { PoolProcessInfo } from "../../src/acp/index.js";
import type { ViewHandle } from "../../src/ui/chatController.js";
import type { ConnectionView, ToWebview, ToolCallView, UiState } from "../../src/ui/protocol.js";

// ---------------------------------------------------------------------------
// Settings, tabs, timing
// ---------------------------------------------------------------------------

/** Settings a workspace may not override (scope `machine`) are written to the user settings. */
const MACHINE_SCOPED = new Set(["agentLink.confirm", "agentLink.maxChain", "fs.allowedWriteRoots"]);

async function setSetting(key: string, value: unknown): Promise<void> {
  const target = MACHINE_SCOPED.has(key) ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
  await vscode.workspace.getConfiguration("kiroAcp").update(key, value, target);
}

/** A webview stand-in that keeps the time each message arrived. */
class TimedRecorder {
  readonly entries: Array<{ at: number; message: ToWebview }> = [];
  readonly poster = (message: ToWebview): void => {
    this.entries.push({ at: Date.now(), message });
  };

  mark(): number {
    return this.entries.length;
  }

  /** The first streamed agent chunk and the turn's end after `mark` (undefined until both arrived). */
  turnTimes(mark: number): { firstChunk: number; end: number } | undefined {
    const since = this.entries.slice(mark);
    const chunk = since.find((e) => e.message.type === "chunk" && e.message.role === "agent");
    const end = since.find((e) => e.message.type === "turn" && !e.message.active);
    return chunk && end ? { firstChunk: chunk.at, end: end.at } : undefined;
  }

  /** Every connection status posted after `mark`. */
  connections(mark: number): ConnectionView["status"][] {
    return this.entries
      .slice(mark)
      .flatMap((e) => (e.message.type === "connection" ? [e.message.connection.status] : []));
  }
}

interface Tab {
  view: ViewHandle;
  recorder: TimedRecorder;
  groupId: string;
  /** The session the tab was opened with. */
  sessionId: string;
}

interface ProcessContext {
  /** A view of a group of its own with a fresh session. */
  open(name: string): Promise<Tab>;
}

let groupSeq = 0;

/**
 * Restart the agent with `--serial-turns` (and the given `agentProcesses.max`
 * / agent link), run `body`, then close its tabs, restore the settings and
 * restart again.
 */
async function withSerialAgent(
  api: KiroAcpApi,
  settings: { max?: number; link?: boolean },
  body: (ctx: ProcessContext) => Promise<void>,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("kiroAcp");
  const prior = config.get<string[]>("cliArgs", []);
  await config.update("cliArgs", [...prior, "--serial-turns"], vscode.ConfigurationTarget.Workspace);
  if (settings.max !== undefined) await setSetting("agentProcesses.max", settings.max);
  if (settings.link) {
    await setSetting("agentLink.enabled", true);
    await setSetting("agentLink.confirm", "never");
  }
  const tabs: Tab[] = [];
  try {
    await withTimeout(api.controller.restart(), 30_000, "restart() with --serial-turns");
    await ensureReady(api);
    const open = async (name: string): Promise<Tab> => {
      const recorder = new TimedRecorder();
      const groupId = `f19-${name}-${++groupSeq}`;
      const view = api.controller.attachView(recorder.poster, { prefer: "fresh", groupId });
      const tab: Tab = { view, recorder, groupId, sessionId: "" };
      tabs.push(tab);
      const id = await withTimeout(api.controller.newSession(view), 15_000, `a session in ${groupId}`);
      assert(id, `a new session in ${groupId}`);
      tab.sessionId = id;
      return tab;
    };
    await body({ open });
  } finally {
    for (const tab of tabs) tab.view.dispose();
    for (const tab of tabs) await api.controller.closeGroup(tab.groupId);
    if (settings.link) {
      await setSetting("agentLink.confirm", undefined);
      await setSetting("agentLink.enabled", undefined);
    }
    if (settings.max !== undefined) await setSetting("agentProcesses.max", undefined);
    await config.update("cliArgs", prior, vscode.ConfigurationTarget.Workspace);
    await withTimeout(api.controller.restart(), 30_000, "restart() without --serial-turns");
    await ensureReady(api);
  }
}

/** The pool process hosting `sessionId`. */
function processOf(api: KiroAcpApi, sessionId: string): PoolProcessInfo {
  const found = api.controller.agentProcesses().find((p) => p.sessionIds.includes(sessionId));
  assert(found, `a process hosts ${sessionId}: ${JSON.stringify(api.controller.agentProcesses())}`);
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function agentText(state: UiState): string {
  return messagesOf(state)
    .filter((m) => m.role === "agent")
    .map(textOf)
    .join("\n");
}

function userTexts(state: UiState): string[] {
  return messagesOf(state)
    .filter((m) => m.role === "user")
    .map(textOf);
}

/**
 * Prompt both tabs with the `slow` scenario (20 chunks, about 2 s) at the
 * same time; returns how long the two turns streamed at the same time (ms,
 * negative when one only started after the other ended).
 */
async function slowTurnsOverlap(api: KiroAcpApi, a: Tab, b: Tab): Promise<number> {
  const markA = a.recorder.mark();
  const markB = b.recorder.mark();
  await withTimeout(
    Promise.all([
      api.controller.prompt("/scenario slow", [], a.sessionId),
      api.controller.prompt("/scenario slow", [], b.sessionId),
    ]),
    30_000,
    "both slow turns",
  );
  const ta = await waitFor(() => a.recorder.turnTimes(markA), 15_000, "tab A's streamed turn");
  const tb = await waitFor(() => b.recorder.turnTimes(markB), 15_000, "tab B's streamed turn");
  for (const tab of [a, b]) {
    assert(agentText(snapshot(api, tab.sessionId)).includes("slow 19"), `${tab.groupId} streamed its whole answer`);
  }
  return Math.min(ta.end, tb.end) - Math.max(ta.firstChunk, tb.firstChunk);
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

/** The fake agent's `kiro-acp-tabs/<tool>` cards in transcript order; the last one. */
function lastLinkCall(state: UiState, tool: string): ToolCallView {
  const title = `kiro-acp-tabs/${tool}`;
  const calls = state.items.flatMap((item) => {
    if (item.type !== "tool") return [];
    const call = state.toolCalls[item.toolCallId];
    return call && call.title === title ? [call] : [];
  });
  const call = calls[calls.length - 1];
  assert(call, `a ${tool} tool card: ${JSON.stringify(Object.values(state.toolCalls).map((c) => c.title))}`);
  return call;
}

/** The structured result the fake agent put into a tool card's `rawOutput`. */
function resultOf(call: ToolCallView): Record<string, unknown> {
  const raw = call.rawOutput as { structuredContent?: Record<string, unknown> } | undefined;
  assert(raw?.structuredContent, `${call.title} has a structured result: ${JSON.stringify(call.rawOutput)}`);
  return raw.structuredContent;
}

function handleOf(api: KiroAcpApi, sessionId: string): string {
  const self = api.controller.listSessions(sessionId).find((s) => s.self);
  assert(self, `session ${sessionId} is listed`);
  return self.handle;
}

const EXIT_NOTICE = /^Kiro's process for this session exited \(kiro-cli exited/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("F19.1 two tabs prompted at once stream at the same time, each session in a process of its own", async ({ api }) => {
  await withSerialAgent(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const pa = processOf(api, a.sessionId);
    const pb = processOf(api, b.sessionId);
    assert(pa.id !== pb.id, `two processes: ${pa.id}, ${pb.id}`);
    assertEqual(pa.sessionIds.length, 1, "tab A's process hosts only its session");
    assertEqual(pb.sessionIds.length, 1, "tab B's process hosts only its session");
    assert(pa.pid !== null && pb.pid !== null && pa.pid !== pb.pid, `two OS processes: ${pa.pid}, ${pb.pid}`);
    const spares = api.controller.agentProcesses().filter((p) => p.spare);
    assertEqual(spares.length, 1, "one spare process is warm for the next session");
    assertEqual(spares[0]!.sessionIds.length, 0, "the spare hosts no session");
    assertEqual(api.controller.agentProcessLimit(), 8, "the default limit");

    const overlap = await slowTurnsOverlap(api, a, b);
    assert(overlap > 1000, `both turns streamed at the same time (overlap ${overlap} ms)`);

    // `/capabilities` lists the processes, this session marked.
    const caps = await promptIn(api, a.sessionId, "/capabilities");
    const reply = textOf(messagesOf(caps).filter((m) => m.role === "agent").pop()!);
    const count = api.controller.agentProcesses().length;
    assert(reply.includes(`**Processes:** ${count} running (max 8, \`kiroAcp.agentProcesses.max\`)`), reply);
    const hA = handleOf(api, a.sessionId);
    const hB = handleOf(api, b.sessionId);
    assert(reply.includes(`- process ${pa.id} (pid ${pa.pid}): ${hA} (this session)`), reply);
    assert(reply.includes(`- process ${pb.id} (pid ${pb.pid}): ${hB}`), reply);
    assert(/- process \d+ \(pid \d+\): spare/.test(reply), reply);
  });
});

test("F19.2 kiroAcp.agentProcesses.max = 1: every session shares one process and their turns wait for each other", async ({ api }) => {
  await withSerialAgent(api, { max: 1 }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const processes = api.controller.agentProcesses();
    assertEqual(processes.length, 1, `one process: ${JSON.stringify(processes)}`);
    assert(
      processes[0]!.sessionIds.includes(a.sessionId) && processes[0]!.sessionIds.includes(b.sessionId),
      "it hosts both tabs' sessions",
    );
    assertEqual(api.controller.agentProcessLimit(), 1, "the limit from the setting");

    const overlap = await slowTurnsOverlap(api, a, b);
    assert(overlap < 300, `the second turn streamed only once the first ended (overlap ${overlap} ms)`);

    // The one process lists its live sessions first (newest first, two per
    // page): the canned past sessions are on a later `session/list` page.
    const past = await withTimeout(api.controller.listPastSessions(), 15_000, "listPastSessions()");
    const ids = past.map((e) => e.sessionId);
    assertEqual(ids.filter((id) => id === "past-1").length, 1, `past-1 listed once across pages (${ids.join(",")})`);
    assertEqual(ids.filter((id) => id === "past-2").length, 1, `past-2 listed once across pages (${ids.join(",")})`);
    assert(!ids.includes(a.sessionId) && !ids.includes(b.sessionId), "live sessions are not offered as past ones");
  });
});

test("F19.3 closing a session stops its process; the spare stays", async ({ api }) => {
  await withSerialAgent(api, {}, async ({ open }) => {
    const a = await open("a");
    const victim = processOf(api, a.sessionId);
    assert(!victim.spare && victim.pid !== null, `a process of its own: ${JSON.stringify(victim)}`);
    assert(isAlive(victim.pid), "its OS process runs");

    a.view.dispose();
    await withTimeout(api.controller.closeGroup(a.groupId), 15_000, "closing the tab's session");
    assert(!api.controller.sessionIds().includes(a.sessionId), "the session is gone");
    await waitFor(
      () => !api.controller.agentProcesses().some((p) => p.id === victim.id) || undefined,
      15_000,
      "its process to leave the pool",
    );
    await waitFor(() => !isAlive(victim.pid!) || undefined, 15_000, `pid ${victim.pid} to exit`);
    const spares = api.controller.agentProcesses().filter((p) => p.spare);
    assertEqual(spares.length, 1, "the spare is still there");
    assert(!api.controller.agentProcesses().some((p) => p.sessionIds.includes(a.sessionId)), "no process hosts the closed session");
  });
});

test("F19.4 a killed process ends only its session; the next message loads it into a new process (or says it cannot)", async ({ api }) => {
  await withSerialAgent(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    // A past session: every fake process knows it, so a new one can load it again.
    assertEqual(await withTimeout(api.controller.openPastSession("past-1", a.view), 15_000, "restore past-1"), "past-1", "past-1 opened in tab A");
    const before = await promptIn(api, "past-1", "/scenario chat\nbefore the kill");
    const usersBefore = userTexts(before);
    assertEqual(usersBefore.filter((t) => t.includes("Why is CI flaky?")).length, 1, "the replayed question once");
    const victim = processOf(api, "past-1");
    assert(victim.pid !== null && victim.sessionIds.length === 1, `past-1 alone in its process: ${JSON.stringify(victim)}`);
    const otherBefore = processOf(api, b.sessionId);
    const markA = a.recorder.mark();
    const markB = b.recorder.mark();

    process.kill(victim.pid);
    const notice = await waitFor(
      () => snapshot(api, "past-1").notices.find((n) => EXIT_NOTICE.test(n.text)),
      15_000,
      "the exit notice in past-1",
    );
    assertEqual(notice.severity, "warning", "an idle session's exit is a warning");
    assert(notice.text.endsWith("Your next message loads the session again in a new process."), notice.text);
    assert(!api.controller.agentProcesses().some((p) => p.id === victim.id), "the dead process left the pool");
    assertEqual(api.controller.snapshot().connection.status, "ready", "the connection stays ready");
    assertEqual(snapshot(api, "past-1").sessions.find((s) => s.id === "past-1")?.status, "idle", "past-1 is listed idle");
    assert(!snapshot(api, b.sessionId).notices.some((n) => EXIT_NOTICE.test(n.text)), "tab B got no notice");

    // The other session keeps working, in the same process as before.
    const other = await promptIn(api, b.sessionId, "/scenario chat");
    assert(agentText(other).includes("The answer is 42."), "tab B answers");
    assertEqual(processOf(api, b.sessionId).id, otherBefore.id, "tab B kept its process");

    // The next message to past-1 loads it into a new process and is answered.
    const after = await promptIn(api, "past-1", "/scenario chat\nafter the kill");
    const reloaded = processOf(api, "past-1");
    assert(reloaded.id !== victim.id, `past-1 is in a new process (${reloaded.id})`);
    const users = userTexts(after);
    assertEqual(users.length, usersBefore.length + 1, `one more user message, the replay was not added again (${JSON.stringify(users)})`);
    assertEqual(users.filter((t) => t.includes("Why is CI flaky?")).length, 1, "the replayed question still once");
    assert(agentText(after).split("The answer is 42.").length - 1 === 2, `answered after the reload: ${agentText(after)}`);
    assert(
      !after.notices.some((n) => n.text.startsWith("Prompt failed") || n.text.startsWith("Could not load")),
      `no failure notice: ${JSON.stringify(after.notices)}`,
    );
    for (const [tab, mark] of [[a, markA], [b, markB]] as const) {
      for (const status of tab.recorder.connections(mark)) assertEqual(status, "ready", `${tab.groupId}: connection posts while a process died`);
    }

    // A fresh session the new process does not know (the fake keeps live
    // sessions in memory only): its next message says it cannot be loaded.
    const fresh = await withTimeout(api.controller.newSession(b.view), 15_000, "a fresh session in tab B");
    assert(fresh, "a fresh session");
    await promptIn(api, fresh, "/scenario chat");
    const freshProcess = processOf(api, fresh);
    process.kill(freshProcess.pid!);
    await waitFor(() => snapshot(api, fresh).notices.find((n) => EXIT_NOTICE.test(n.text)), 15_000, "the exit notice");
    const failed = await promptIn(api, fresh, "/scenario chat\nlost");
    const cannot = failed.notices.find((n) => n.text.startsWith("Could not load this session into a new Kiro process"));
    assert(cannot, `the session says it cannot be loaded: ${JSON.stringify(failed.notices)}`);
    assert(cannot.text.includes("not found"), cannot.text);
    assert(!api.controller.agentProcesses().some((p) => p.sessionIds.includes(fresh)), "no process hosts it");
    assert(!failed.notices.some((n) => n.text.startsWith("Prompt failed")), "no 'Prompt failed' next to it");
  });
});

test("F19.5 a process that exits mid-turn: one notice in its session (no 'Prompt failed'); the turn next door finishes", async ({ api }) => {
  await withSerialAgent(api, {}, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const markB = b.recorder.mark();
    const slow = api.controller.prompt("/scenario slow", [], b.sessionId);
    await waitFor(() => b.recorder.entries.slice(markB).some((e) => e.message.type === "chunk") || undefined, 15_000, "tab B streaming");
    const crashed = await promptIn(api, a.sessionId, "/scenario crash");
    await sleep(300); // the order of the exit and the prompt failure varies: let both land
    const notices = snapshot(api, a.sessionId).notices;
    const exits = notices.filter((n) => EXIT_NOTICE.test(n.text));
    assertEqual(exits.length, 1, `one exit notice: ${JSON.stringify(notices)}`);
    assertEqual(exits[0]!.severity, "error", "a cut turn is an error");
    assert(exits[0]!.text.includes("kiro-cli exited with code 3") && exits[0]!.text.includes("and the turn ended"), exits[0]!.text);
    assert(!notices.some((n) => n.text.startsWith("Prompt failed")), `no 'Prompt failed' notice: ${JSON.stringify(notices)}`);
    assert(agentText(crashed).includes("about to crash"), "the turn's output before the crash stays");
    assertEqual(crashed.turnActive, false, "the turn ended");

    await withTimeout(slow, 15_000, "tab B's slow turn");
    const other = await waitFor(() => (snapshot(api, b.sessionId).turnActive ? undefined : snapshot(api, b.sessionId)), 15_000, "tab B's turn to end");
    assert(agentText(other).includes("slow 19"), "tab B's turn streamed to the end");
    assert(!other.notices.some((n) => EXIT_NOTICE.test(n.text) || n.text.startsWith("Prompt failed")), "tab B saw nothing of it");
    assertEqual(api.controller.snapshot().connection.status, "ready", "the connection stays ready");
  });
});

test("F19.6 a sign-in restores every session into a process of its own, loading them in parallel", async ({ api }) => {
  await withSerialAgent(api, {}, async ({ open }) => {
    const tab = await open("restore");
    for (const id of ["past-2", "past-1"]) {
      assertEqual(await withTimeout(api.controller.openPastSession(id, tab.view), 15_000, `restore ${id}`), id, `${id} opened`);
    }
    const output = captureOutput(api);
    try {
      await signInAgain(api);
    } finally {
      output.dispose();
    }
    assertEqual(api.controller.snapshot().connection.status, "ready", "reconnected");
    assertEqual(tab.view.sessionId, "past-1", "the tab shows past-1 again");
    const p1 = processOf(api, "past-1");
    const p2 = processOf(api, "past-2");
    assert(p1.id !== p2.id, `each restored session has a process of its own (${p1.id}, ${p2.id})`);
    assert(!p1.spare && !p2.spare, "neither is the spare");
    // Both loads start before either ends: `restoring` twice, then `restored`.
    const at = (text: string): number => output.lines.findIndex((l) => l.includes(text));
    const restoring = [at("session past-1 restoring"), at("session past-2 restoring")];
    const restored = [at("session past-1 restored"), at("session past-2 restored")];
    assert(restoring.every((i) => i >= 0) && restored.every((i) => i >= 0), `restore lines: ${JSON.stringify(output.lines.filter((l) => l.includes("restor")))}`);
    assert(Math.max(...restoring) < Math.min(...restored), `the loads ran in parallel: ${JSON.stringify(output.lines.filter((l) => l.includes("restor")))}`);
    const answered = await promptIn(api, "past-2", "/scenario chat");
    assert(agentText(answered).includes("The answer is 42."), "a restored session answers");
  });
});

test("F19.7 agent link: an orchestrator's wait from inside its turn sees the helper run and finish", async ({ api }) => {
  await withSerialAgent(api, { link: true }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hB = handleOf(api, b.sessionId);
    const sent = await promptIn(api, a.sessionId, `/scenario link-send-wait ${hB}\n/scenario peer-slow`);
    const waited = resultOf(lastLinkCall(sent, "wait_for_session"));
    assertEqual(waited.outcome, "idle", "the wait ended when the target finished");
    assertEqual(waited.lastAnswer, "Slow peer done.", "with the target's answer");

    const done = await promptIn(api, a.sessionId, "/scenario link-orchestrate sameTab\n/scenario peer-slow");
    const helper = (resultOf(lastLinkCall(done, "start_session")).session as { handle: string }).handle;
    assertEqual(resultOf(lastLinkCall(done, "wait_for_session")).outcome, "idle", "the orchestrator's wait ended idle");
    assert(agentText(done).includes(`Helper ${helper} answered: Slow peer done.`), agentText(done));
    const helperId = api.controller.listSessions(a.sessionId).find((s) => s.handle === helper)?.sessionId;
    assert(helperId, "the helper is listed");
    assert(processOf(api, helperId).id !== processOf(api, a.sessionId).id, "the helper ran in a process of its own");
  });
});

test("F19.8 agent link: a session whose process exited is loaded again by a message to it, keeps its handle and gets a working token", async ({ api }) => {
  await withSerialAgent(api, { link: true }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    assertEqual(await withTimeout(api.controller.openPastSession("past-1", b.view), 15_000, "restore past-1"), "past-1", "past-1 opened in tab B");
    const h1 = handleOf(api, "past-1");
    const victim = processOf(api, "past-1");
    process.kill(victim.pid!);
    await waitFor(() => snapshot(api, "past-1").notices.find((n) => EXIT_NOTICE.test(n.text)), 15_000, "the exit notice in past-1");
    assertEqual(api.controller.listSessions(a.sessionId).find((s) => s.handle === h1)?.status, "idle", "the agents see it idle");

    // A message from another agent loads it into a new process and runs there.
    const sent = await promptIn(api, a.sessionId, `/scenario link-send-wait ${h1}\n/scenario peer-slow`);
    const waited = resultOf(lastLinkCall(sent, "wait_for_session"));
    assertEqual(waited.outcome, "idle", "the wait ended when the reloaded session finished");
    assertEqual(waited.lastAnswer, "Slow peer done.", "with its answer");
    assert(processOf(api, "past-1").id !== victim.id, "past-1 runs in a new process");

    // Its own agent-link token was issued anew with the load, under the same handle.
    assertEqual(handleOf(api, "past-1"), h1, "past-1 keeps its handle");
    const listing = await promptIn(api, "past-1", "/scenario agent-link");
    const text = agentText(listing);
    assert(text.includes(`You are ${h1} "Investigate flaky CI"`), `the reloaded session calls the agent link as itself: ${text}`);
    assert(!text.includes("[fake-agent]"), `no fake-agent report: ${text}`);
  });
});

test("F19.9 agent link with max = 1: the same wait can only time out, its target runs after the turn (why D31)", async ({ api }) => {
  await withSerialAgent(api, { max: 1, link: true }, async ({ open }) => {
    const a = await open("a");
    const b = await open("b");
    const hB = handleOf(api, b.sessionId);
    const sent = await promptIn(api, a.sessionId, `/scenario link-send-wait ${hB} 2\n/scenario peer-slow`);
    assertEqual(resultOf(lastLinkCall(sent, "wait_for_session")).outcome, "timeout", "the target could not start while the sender's turn ran");
    const target = await waitFor(
      () => {
        const state = snapshot(api, b.sessionId);
        return !state.turnActive && agentText(state).includes("Slow peer done.") ? state : undefined;
      },
      20_000,
      "the target's turn once the sender's ended",
    );
    assert(agentText(target).includes("Slow peer done."), "the target answered after all");
  });
});
