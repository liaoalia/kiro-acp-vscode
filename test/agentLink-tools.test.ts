import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLinkTools, formatSessionList } from "../src/agentLink/tools.js";
import type { AgentLinkHost, LinkedSessionInfo, ToolResult } from "../src/agentLink/types.js";

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
