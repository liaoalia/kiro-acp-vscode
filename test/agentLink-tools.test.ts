import { test } from "node:test";
import assert from "node:assert/strict";
import { PEER_MESSAGE_PREFIX } from "../src/agentLink/peerMessage.js";
import { AGENT_LINK_INSTRUCTIONS, createAgentLinkTools, formatSessionList, formatWaitResult } from "../src/agentLink/tools.js";
import {
  AgentLinkError,
  READ_SESSION_DEFAULT_ITEMS,
  READ_SESSION_MAX_ITEMS,
  WAIT_DEFAULT_SECONDS,
  WAIT_MAX_SECONDS,
  type AgentLinkErrorCode,
  type AgentLinkHost,
  type AgentLinkTool,
  type LinkedSessionInfo,
  type PeerDelivery,
  type StartWhere,
  type ToolResult,
  type WaitResult,
} from "../src/agentLink/types.js";

const sessions: LinkedSessionInfo[] = [
  { handle: "s3", sessionId: "sess-3", title: "Fix the login bug", tab: "Kiro Chat 2", status: "working", self: false },
  { handle: "s1", sessionId: "sess-1", title: "New session", tab: "Kiro Chat 1", status: "idle", self: true },
  { handle: "s2", sessionId: "sess-2", title: "Review \"parser\"", tab: "Sidebar", status: "needs_input", self: false },
];

test("formatSessionList puts the caller first, then the others in order", () => {
  const text = formatSessionList(sessions);
  assert.equal(
    text,
    [
      'You are s1 "New session" · tab "Kiro Chat 1" · idle.',
      "Other sessions (2):",
      '- s3 "Fix the login bug" · tab "Kiro Chat 2" · working',
      '- s2 "Review \\"parser\\"" · tab "Sidebar" · waiting for the user',
    ].join("\n"),
  );
});

test("formatSessionList says when there is nobody else, or when the caller is not listed", () => {
  assert.equal(
    formatSessionList([sessions[1]!]),
    'You are s1 "New session" · tab "Kiro Chat 1" · idle.\nThere are no other sessions.',
  );
  assert.match(formatSessionList([sessions[0]!]), /^Your own session is not listed/);
});

/** Host methods a test does not exercise. */
const unusedHost: AgentLinkHost = {
  listSessions: () => assert.fail("listSessions not expected"),
  readSession: () => assert.fail("readSession not expected"),
  sendMessage: () => assert.fail("sendMessage not expected"),
  waitForSession: () => assert.fail("waitForSession not expected"),
  startSession: () => assert.fail("startSession not expected"),
};

test("list_sessions asks the host for the caller's view and returns text plus structured content", async () => {
  const asked: string[] = [];
  const host: AgentLinkHost = {
    ...unusedHost,
    listSessions(caller) {
      asked.push(caller);
      return sessions;
    },
  };
  const tools = createAgentLinkTools(host);
  const tool = tools.find((t) => t.definition.name === "list_sessions");
  assert.ok(tool, "list_sessions is offered");
  assert.equal(tool.definition.annotations?.readOnlyHint, true);
  assert.equal(tool.definition.inputSchema.type, "object");

  const result: ToolResult = await tool.call({}, { sessionId: "sess-1", signal: new AbortController().signal });
  assert.deepEqual(asked, ["sess-1"]);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0]?.type, "text");
  assert.match(result.content[0]!.text, /^You are s1/);
  const structured = result.structuredContent as { sessions: Array<Record<string, unknown>> };
  assert.equal(structured.sessions.length, 3);
  // Agents address sessions by handle; the ACP session id stays inside the extension.
  assert.deepEqual(structured.sessions[1], { handle: "s1", title: "New session", tab: "Kiro Chat 1", status: "idle", self: true });
});

// ---------------------------------------------------------------------------
// Stages 2–4: read_session, send_message, wait_for_session, start_session
// ---------------------------------------------------------------------------

const caller = { sessionId: "sess-1", signal: new AbortController().signal };
const s3 = sessions[0]!;
const s3View = { handle: "s3", title: "Fix the login bug", tab: "Kiro Chat 2", status: "working", self: false };

function toolOf(host: AgentLinkHost, name: string): AgentLinkTool {
  const tool = createAgentLinkTools(host).find((t) => t.definition.name === name);
  assert.ok(tool, `${name} is offered`);
  return tool;
}

function textOf(result: ToolResult): string {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  return result.content[0]!.text;
}

/** Calls `name` with each of `cases` and expects an `invalid_argument` result matching its pattern; the host is never asked. */
async function expectInvalid(name: string, cases: Array<[Record<string, unknown>, RegExp]>): Promise<void> {
  const tool = toolOf(unusedHost, name);
  for (const [args, pattern] of cases) {
    const result = await tool.call(args, caller);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.deepEqual(result.structuredContent, { error: "invalid_argument" }, `${name} ${JSON.stringify(args)}`);
    assert.match(textOf(result), pattern, `${name} ${JSON.stringify(args)}`);
  }
}

/** Every host method throws (or rejects with) `error`. */
function failingHost(error: unknown, async: boolean): AgentLinkHost {
  const fail = (): never => {
    throw error;
  };
  const reject = (): Promise<never> => (async ? Promise.reject(error) : fail());
  return {
    listSessions: fail,
    readSession: fail,
    sendMessage: reject,
    waitForSession: reject,
    startSession: reject,
  };
}

const validArgs: Record<string, Record<string, unknown>> = {
  read_session: { session: "s3" },
  send_message: { to: "s3", text: "hello" },
  wait_for_session: { session: "s3" },
  start_session: { prompt: "do it" },
};

test("every tool has an object schema without additional properties, a description and annotations", () => {
  const tools = createAgentLinkTools(unusedHost);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    ["list_sessions", "read_session", "send_message", "wait_for_session", "start_session"],
  );
  for (const { definition } of tools) {
    assert.equal(definition.inputSchema.type, "object", definition.name);
    assert.equal(definition.inputSchema.additionalProperties, false, definition.name);
    assert.ok(definition.description.length > 80, definition.name);
    assert.ok(definition.title, definition.name);
    assert.equal(definition.annotations?.openWorldHint, false, definition.name);
    for (const required of definition.inputSchema.required ?? []) {
      assert.ok(definition.inputSchema.properties?.[required], `${definition.name}.${required}`);
    }
  }
  const byName = new Map(tools.map((t) => [t.definition.name, t.definition]));
  assert.equal(byName.get("read_session")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("wait_for_session")!.annotations?.readOnlyHint, true);
  for (const name of ["send_message", "start_session"]) {
    assert.equal(byName.get(name)!.annotations?.readOnlyHint, false, name);
    assert.equal(byName.get(name)!.annotations?.destructiveHint, false, name);
  }
  assert.deepEqual(byName.get("read_session")!.inputSchema.required, ["session"]);
  assert.deepEqual(byName.get("send_message")!.inputSchema.required, ["to", "text"]);
  assert.deepEqual(byName.get("wait_for_session")!.inputSchema.required, ["session"]);
  assert.deepEqual(byName.get("start_session")!.inputSchema.required, ["prompt"]);
  assert.deepEqual((byName.get("start_session")!.inputSchema.properties!.where as { enum: string[] }).enum, ["newTab", "sameTab"]);
  assert.equal(
    (byName.get("read_session")!.inputSchema.properties!.last as { maximum: number }).maximum,
    READ_SESSION_MAX_ITEMS,
  );
  assert.equal(
    (byName.get("wait_for_session")!.inputSchema.properties!.timeoutSeconds as { maximum: number }).maximum,
    WAIT_MAX_SECONDS,
  );
});

test("the server instructions name every tool and the etiquette", () => {
  for (const name of ["list_sessions", "read_session", "send_message", "wait_for_session", "start_session"]) {
    assert.ok(AGENT_LINK_INSTRUCTIONS.includes(`\`${name}\``), name);
  }
  assert.ok(AGENT_LINK_INSTRUCTIONS.includes(PEER_MESSAGE_PREFIX));
  assert.match(AGENT_LINK_INSTRUCTIONS, /not from your user/);
  assert.match(AGENT_LINK_INSTRUCTIONS, /only when an answer is actually needed/);
  assert.match(AGENT_LINK_INSTRUCTIONS, /loops/);
});

// read_session ---------------------------------------------------------------

test("read_session asks the host with the default `last` and renders a header plus the text", async () => {
  const asked: Array<[string, string, number]> = [];
  const host: AgentLinkHost = {
    ...unusedHost,
    readSession(callerId, target, last) {
      asked.push([callerId, target, last]);
      return { session: s3, text: "user: hi\n\nagent: hello", items: 2, truncated: false };
    },
  };
  const result = await toolOf(host, "read_session").call({ session: "s3" }, caller);
  assert.deepEqual(asked, [["sess-1", "s3", READ_SESSION_DEFAULT_ITEMS]]);
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), 's3 "Fix the login bug" · tab "Kiro Chat 2" · working\n\nuser: hi\n\nagent: hello');
  assert.deepEqual(result.structuredContent, {
    session: s3View,
    items: 2,
    truncated: false,
    text: "user: hi\n\nagent: hello",
  });
});

test("read_session passes `last`, notes truncation and marks the caller's own session", async () => {
  const asked: number[] = [];
  const self = sessions[1]!;
  const host: AgentLinkHost = {
    ...unusedHost,
    readSession(_callerId, _target, last) {
      asked.push(last);
      return { session: self, text: "agent: done", items: 1, truncated: true };
    },
  };
  const tool = toolOf(host, "read_session");
  const result = await tool.call({ session: "s1", last: 1 }, caller);
  await tool.call({ session: "s1", last: READ_SESSION_MAX_ITEMS }, caller);
  await tool.call({ session: "s1", last: null }, caller);
  assert.deepEqual(asked, [1, READ_SESSION_MAX_ITEMS, READ_SESSION_DEFAULT_ITEMS]);
  assert.equal(
    textOf(result),
    's1 "New session" · tab "Kiro Chat 1" · idle (your own session)\n(older messages left out)\n\nagent: done',
  );
  assert.equal((result.structuredContent as { truncated: boolean }).truncated, true);
});

test("read_session refuses malformed arguments without asking the host", async () => {
  await expectInvalid("read_session", [
    [{}, /`session` is required/],
    [{ session: null }, /`session` is required/],
    [{ session: 3 }, /`session` must be a string/],
    [{ session: "s3", last: 0 }, /`last` must be a whole number from 1 to 200/],
    [{ session: "s3", last: READ_SESSION_MAX_ITEMS + 1 }, /`last` must be a whole number/],
    [{ session: "s3", last: 2.5 }, /`last` must be a whole number/],
    [{ session: "s3", last: "5" }, /`last` must be a whole number/],
    [{ session: "s3", last: Number.NaN }, /`last` must be a whole number/],
    [{ session: "s3", sessionId: "x" }, /Unknown argument `sessionId`; the arguments are `session`, `last`/],
  ]);
});

// send_message ---------------------------------------------------------------

test("send_message delivers through the host with the caller's signal and reports the delivery", async () => {
  const asked: Array<[string, string, string, AbortSignal]> = [];
  let delivery: PeerDelivery = "started";
  const host: AgentLinkHost = {
    ...unusedHost,
    async sendMessage(callerId, target, text, signal) {
      asked.push([callerId, target, text, signal]);
      return { to: s3, delivery };
    },
  };
  const tool = toolOf(host, "send_message");
  const started = await tool.call({ to: "s3", text: "  Please review.  " }, caller);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]!.slice(0, 3), ["sess-1", "s3", "  Please review.  "]);
  assert.equal(asked[0]![3], caller.signal);
  assert.equal(started.isError, undefined);
  assert.match(textOf(started), /^Delivered to s3 "Fix the login bug" \(tab "Kiro Chat 2"\): it started working on it now\./);
  assert.match(textOf(started), /wait_for_session \(session: "s3"\)/);
  assert.deepEqual(started.structuredContent, { to: s3View, delivery: "started" });

  delivery = "queued";
  const queued = await tool.call({ to: "s3", text: "and this" }, caller);
  assert.match(textOf(queued), /it is busy and gets it when its current turn ends\./);
  assert.deepEqual(queued.structuredContent, { to: s3View, delivery: "queued" });
});

test("send_message leaves empty and long text to the host", async () => {
  const texts: string[] = [];
  const host: AgentLinkHost = {
    ...unusedHost,
    async sendMessage(_callerId, _target, text) {
      texts.push(text);
      throw new AgentLinkError(text.trim() === "" ? "empty_text" : "too_long", "refused by the host");
    },
  };
  const tool = toolOf(host, "send_message");
  const empty = await tool.call({ to: "s3", text: "   " }, caller);
  assert.deepEqual(empty.structuredContent, { error: "empty_text" });
  const long = await tool.call({ to: "s3", text: "x".repeat(40_000) }, caller);
  assert.deepEqual(long.structuredContent, { error: "too_long" });
  assert.equal(texts.length, 2);
});

test("send_message refuses malformed arguments without asking the host", async () => {
  await expectInvalid("send_message", [
    [{ text: "hi" }, /`to` is required/],
    [{ to: "s3" }, /`text` is required/],
    [{ to: ["s3"], text: "hi" }, /`to` must be a string/],
    [{ to: "s3", text: { body: "hi" } }, /`text` must be a string/],
    [{ to: "s3", text: "hi", urgent: true }, /Unknown argument `urgent`/],
  ]);
});

// wait_for_session -----------------------------------------------------------

test("wait_for_session converts seconds to milliseconds, passes the signal and reports each outcome", async () => {
  const asked: Array<[string, string, number, AbortSignal]> = [];
  let next: WaitResult = { session: { ...s3, status: "idle" }, outcome: "idle", lastAnswer: "Fixed: the token is refreshed." };
  const host: AgentLinkHost = {
    ...unusedHost,
    async waitForSession(callerId, target, timeoutMs, signal) {
      asked.push([callerId, target, timeoutMs, signal]);
      return next;
    },
  };
  const tool = toolOf(host, "wait_for_session");

  const idle = await tool.call({ session: "s3" }, caller);
  assert.deepEqual(asked[0]!.slice(0, 3), ["sess-1", "s3", WAIT_DEFAULT_SECONDS * 1000]);
  assert.equal(asked[0]![3], caller.signal);
  assert.equal(
    textOf(idle),
    's3 "Fix the login bug" has finished its turn and is idle.\n\nIts last answer:\nFixed: the token is refreshed.',
  );
  assert.deepEqual(idle.structuredContent, {
    outcome: "idle",
    session: { ...s3View, status: "idle" },
    lastAnswer: "Fixed: the token is refreshed.",
  });

  next = { session: { ...s3, status: "idle" }, outcome: "idle", lastAnswer: null };
  assert.equal(
    textOf(await tool.call({ session: "s3" }, caller)),
    's3 "Fix the login bug" has finished its turn and is idle.\nIt left no answer text.',
  );

  next = { session: { ...s3, status: "needs_input" }, outcome: "needs_input", lastAnswer: "I need to run npm." };
  const needs = await tool.call({ session: "s3", timeoutSeconds: 30 }, caller);
  assert.equal(asked[2]![2], 30_000);
  assert.match(textOf(needs), /^s3 "Fix the login bug" is waiting for its user \(a permission request\)/);
  assert.match(textOf(needs), /Its last answer:\nI need to run npm\.$/);

  next = { session: s3, outcome: "timeout", lastAnswer: null };
  const timeout = await tool.call({ session: "s3", timeoutSeconds: 1.5 }, caller);
  assert.equal(asked[3]![2], 1500);
  assert.equal(
    textOf(timeout),
    's3 "Fix the login bug" is still working after 1.5 s. Call wait_for_session again to keep waiting.',
  );
  assert.equal((timeout.structuredContent as { outcome: string }).outcome, "timeout");

  next = { session: null, outcome: "closed", lastAnswer: "partial" };
  const closed = await tool.call({ session: "s3", timeoutSeconds: WAIT_MAX_SECONDS }, caller);
  assert.equal(asked[4]![2], WAIT_MAX_SECONDS * 1000);
  assert.equal(textOf(closed), 'Session "s3" was closed.\n\nIts last answer:\npartial');
  assert.deepEqual(closed.structuredContent, { outcome: "closed", session: null, lastAnswer: "partial" });
});

test("formatWaitResult is pure and names a closed session by the argument", () => {
  assert.equal(formatWaitResult({ session: null, outcome: "closed", lastAnswer: null }, "S9", 120), 'Session "S9" was closed.');
});

test("wait_for_session refuses malformed arguments without asking the host", async () => {
  await expectInvalid("wait_for_session", [
    [{}, /`session` is required/],
    [{ session: false }, /`session` must be a string/],
    [{ session: "s3", timeoutSeconds: 0 }, /`timeoutSeconds` must be a number from 1 to 600 \(default 120\)/],
    [{ session: "s3", timeoutSeconds: 0.5 }, /`timeoutSeconds` must be a number/],
    [{ session: "s3", timeoutSeconds: WAIT_MAX_SECONDS + 1 }, /`timeoutSeconds` must be a number/],
    [{ session: "s3", timeoutSeconds: "60" }, /`timeoutSeconds` must be a number/],
    [{ session: "s3", timeoutSeconds: Number.POSITIVE_INFINITY }, /`timeoutSeconds` must be a number/],
    [{ session: "s3", timeout: 60 }, /Unknown argument `timeout`/],
  ]);
});

// start_session --------------------------------------------------------------

test("start_session defaults to a new tab, passes the signal and names the new session", async () => {
  const s4: LinkedSessionInfo = {
    handle: "s4",
    sessionId: "sess-4",
    title: "New session",
    tab: "Kiro Chat 3",
    status: "working",
    self: false,
  };
  const asked: Array<[string, string, StartWhere, AbortSignal]> = [];
  const host: AgentLinkHost = {
    ...unusedHost,
    async startSession(callerId, prompt, where, signal) {
      asked.push([callerId, prompt, where, signal]);
      return { session: where === "sameTab" ? { ...s4, tab: "Kiro Chat 1" } : s4, delivery: "started" };
    },
  };
  const tool = toolOf(host, "start_session");
  const result = await tool.call({ prompt: "Write the tests for auth.ts" }, caller);
  assert.deepEqual(asked[0]!.slice(0, 3), ["sess-1", "Write the tests for auth.ts", "newTab"]);
  assert.equal(asked[0]![3], caller.signal);
  assert.match(
    textOf(result),
    /^Started s4 "New session" in tab "Kiro Chat 3" and sent it your prompt: it started working on it now\. /,
  );
  assert.match(textOf(result), /wait_for_session \(session: "s4"\)/);
  assert.deepEqual(result.structuredContent, {
    session: { handle: "s4", title: "New session", tab: "Kiro Chat 3", status: "working", self: false },
    delivery: "started",
  });

  const same = await tool.call({ prompt: "p", where: "sameTab" }, caller);
  assert.equal(asked[1]![2], "sameTab");
  assert.match(textOf(same), /in tab "Kiro Chat 1"/);
  await tool.call({ prompt: "p", where: null }, caller);
  assert.equal(asked[2]![2], "newTab");
});

test("start_session refuses malformed arguments without asking the host", async () => {
  await expectInvalid("start_session", [
    [{}, /`prompt` is required/],
    [{ prompt: 1 }, /`prompt` must be a string/],
    [{ prompt: "p", where: "newWindow" }, /`where` must be "newTab" or "sameTab" \(default "newTab"\)/],
    [{ prompt: "p", where: "NEWTAB" }, /`where` must be/],
    [{ prompt: "p", title: "x" }, /Unknown argument `title`; the arguments are `prompt`, `where`/],
  ]);
});

// Host errors -----------------------------------------------------------------

test("an AgentLinkError of the host (thrown or rejected) becomes an isError result with its code", async () => {
  for (const async of [false, true]) {
    const host = failingHost(new AgentLinkError("unknown_session", 'No session "s9" is open.'), async);
    for (const [name, args] of Object.entries(validArgs)) {
      const result = await toolOf(host, name).call(args, caller);
      assert.equal(result.isError, true, name);
      assert.equal(textOf(result), 'No session "s9" is open.', name);
      assert.deepEqual(result.structuredContent, { error: "unknown_session" }, name);
    }
  }
  const codes: AgentLinkErrorCode[] = ["self", "chain_limit", "rate_limited", "paused", "declined", "not_ready", "restoring", "closed"];
  for (const code of codes) {
    const tool = toolOf(failingHost(new AgentLinkError(code, `refused: ${code}`), true), "send_message");
    const result = await tool.call(validArgs.send_message!, caller);
    assert.deepEqual(result.structuredContent, { error: code });
    assert.equal(textOf(result), `refused: ${code}`);
  }
});

test("other host errors propagate (protocol.ts turns them into isError results)", async () => {
  for (const async of [false, true]) {
    const host = failingHost(new Error("the host broke"), async);
    for (const [name, args] of Object.entries(validArgs)) {
      await assert.rejects(async () => toolOf(host, name).call(args, caller), /the host broke/, name);
    }
  }
});
