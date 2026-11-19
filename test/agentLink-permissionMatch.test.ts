import { test } from "node:test";
import assert from "node:assert/strict";
import type * as acp from "@agentclientprotocol/sdk";
import { matchAgentLinkPermission } from "../src/agentLink/permissionMatch.js";

function request(toolCall: Record<string, unknown>, meta?: Record<string, unknown>): acp.RequestPermissionRequest {
  return {
    sessionId: "s",
    toolCall: { toolCallId: "t1", ...toolCall },
    options: [{ optionId: "allow", name: "Yes", kind: "allow_once" }],
    ...(meta ? { _meta: meta } : {}),
  } as acp.RequestPermissionRequest;
}

test("a request whose title, consent or raw input names the kiro-acp-tabs server matches", () => {
  assert.equal(matchAgentLinkPermission(request({ title: "Use kiro-acp-tabs/send_message" })).kind, "match");
  assert.equal(matchAgentLinkPermission(request({ title: "Running @kiro-acp-tabs/read_session" })).kind, "match");
  assert.equal(matchAgentLinkPermission(request({ title: "mcp__kiro_acp_tabs__wait_for_session" })).kind, "match", "sanitised name");
  assert.equal(matchAgentLinkPermission(request({ title: "KIRO-ACP-TABS: list_sessions" })).kind, "match", "case-insensitive");
  assert.equal(
    matchAgentLinkPermission(request({ title: "Tool call" }, { kiro: { consent: { capability: "mcp", resource: "kiro-acp-tabs/start_session" } } })).kind,
    "match",
    "consent resource",
  );
  assert.equal(
    matchAgentLinkPermission(request({ title: "Tool call", rawInput: { server: "kiro-acp-tabs", tool: "send_message" } })).kind,
    "match",
    "raw input",
  );
});

test("a bare request matches through the title of the tool call it refers to", () => {
  assert.equal(matchAgentLinkPermission(request({}), "kiro-acp-tabs/send_message").kind, "match");
  assert.equal(matchAgentLinkPermission(request({}), "Run npm test").kind, "none");
});

test("a tool name without the server is only a near miss; other requests do not match", () => {
  const near = matchAgentLinkPermission(request({ title: "send_message" }));
  assert.deepEqual(near, { kind: "near", text: "send_message" });
  assert.equal(matchAgentLinkPermission(request({ title: "other-server/send_message_now" })).kind, "none", "a word boundary");
  assert.equal(matchAgentLinkPermission(request({ title: "Edit src/app.ts" }, { kiro: { consent: { capability: "fs_write", resource: "/w/src/app.ts" } } })).kind, "none");
  assert.equal(matchAgentLinkPermission(request({ title: "kiro-acp-tab/send" })).kind, "none", "a similar but different server name");
  assert.equal(matchAgentLinkPermission(request({})).kind, "none");
});
