import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchMcpMessage,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  LOG_FIELD_MAX_CHARS,
  negotiateProtocolVersion,
  sanitizeForLog,
  type McpDispatchContext,
  type McpDispatchResult,
} from "../src/agentLink/protocol.js";
import {
  LATEST_MCP_PROTOCOL_VERSION,
  type AgentLinkTool,
  type CallerContext,
  type ToolResult,
} from "../src/agentLink/types.js";

const echo: AgentLinkTool = {
  definition: {
    name: "echo",
    description: "Echo the arguments and the caller",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  call: (args, caller) => ({
    content: [{ type: "text", text: JSON.stringify({ args, sessionId: caller.sessionId }) }],
  }),
};

const asyncBoom: AgentLinkTool = {
  definition: { name: "async_boom", description: "Rejects", inputSchema: { type: "object" } },
  call: async () => {
    throw new Error("async boom");
  },
};

const syncBoom: AgentLinkTool = {
  definition: { name: "sync_boom", description: "Throws synchronously", inputSchema: { type: "object" } },
  call: () => {
    throw new Error("sync boom");
  },
};

const noContent: AgentLinkTool = {
  definition: { name: "no_content", description: "Returns no content array", inputSchema: { type: "object" } },
  call: () => ({ structuredContent: { ok: true } }) as unknown as ToolResult,
};

const tools = [echo, asyncBoom, syncBoom, noContent];

function context(overrides: Partial<McpDispatchContext> = {}): McpDispatchContext & { callers: number } {
  const ctx = {
    callers: 0,
    tools,
    serverInfo: { name: "kiro-acp-tabs", title: "Tabs", version: "9.9.9" },
    instructions: "Use these tools to talk to other tabs.",
    resolveCaller(): Promise<CallerContext> {
      ctx.callers += 1;
      return Promise.resolve({ sessionId: "s-1", signal: new AbortController().signal });
    },
    ...overrides,
  };
  return ctx;
}

type Response = Extract<McpDispatchResult, { kind: "response" }>;

function response(result: McpDispatchResult): Response {
  assert.equal(result.kind, "response");
  return result as Response;
}

function resultOf(result: McpDispatchResult): Record<string, unknown> {
  const body = response(result).body;
  assert.ok("result" in body, `expected a result, got ${JSON.stringify(body)}`);
  return body.result as Record<string, unknown>;
}

function errorOf(result: McpDispatchResult): { id: unknown; code: number; message: string } {
  const body = response(result).body;
  assert.ok("error" in body, `expected an error, got ${JSON.stringify(body)}`);
  return { id: body.id, code: body.error.code, message: body.error.message };
}

const request = (id: string | number, method: string, params?: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

test("initialize echoes a supported protocol version and describes the server", async () => {
  const result = await dispatchMcpMessage(
    request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "kiro-cli", version: "3.2.1" },
    }),
    context(),
  );
  const res = response(result);
  assert.equal(res.status, 200);
  assert.equal(res.method, "initialize");
  assert.deepEqual(res.body, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "kiro-acp-tabs", title: "Tabs", version: "9.9.9" },
      instructions: "Use these tools to talk to other tabs.",
    },
  });
  assert.equal(res.detail, "client kiro-cli 3.2.1, protocol 2025-06-18 -> 2025-06-18");
});

test("initialize offers the latest version for an unknown or missing one and omits absent instructions", async () => {
  const unknown = resultOf(
    await dispatchMcpMessage(request(1, "initialize", { protocolVersion: "1999-01-01" }), context()),
  );
  assert.equal(unknown.protocolVersion, LATEST_MCP_PROTOCOL_VERSION);

  const missing = await dispatchMcpMessage(request(2, "initialize"), context({ instructions: undefined }));
  assert.equal(resultOf(missing).protocolVersion, LATEST_MCP_PROTOCOL_VERSION);
  assert.equal("instructions" in resultOf(missing), false);
  assert.equal(response(missing).detail, `client ? ?, protocol ? -> ${LATEST_MCP_PROTOCOL_VERSION}`);

  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateProtocolVersion(42), LATEST_MCP_PROTOCOL_VERSION);
});

test("initialize detail sanitizes what the client sent", async () => {
  const ls = String.fromCharCode(0x2028);
  const result = await dispatchMcpMessage(
    request(1, "initialize", {
      protocolVersion: `2025-06-18\nagent-link s-9 tools/call fake -> 200`,
      clientInfo: { name: `evil\r\n\u0000client${ls}x`, version: "v".repeat(500) },
    }),
    context(),
  );
  const detail = response(result).detail;
  assert.ok(detail !== undefined);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(detail), detail);
  assert.ok(!detail.includes(ls), detail);
  assert.ok(detail.startsWith("client evil client x "), detail);
  assert.ok(detail.includes(`${"v".repeat(LOG_FIELD_MAX_CHARS)}…,`), detail);
  assert.ok(!detail.includes("v".repeat(LOG_FIELD_MAX_CHARS + 1)), detail);
  assert.ok(detail.endsWith(`protocol 2025-06-18 agent-link s-9 tools/call fake -> 200 -> ${LATEST_MCP_PROTOCOL_VERSION}`));

  // Non-string fields show as "?".
  const odd = await dispatchMcpMessage(
    request(2, "initialize", { protocolVersion: 7, clientInfo: { name: { x: 1 }, version: "\n\n" } }),
    context(),
  );
  assert.equal(response(odd).detail, `client ? ?, protocol ? -> ${LATEST_MCP_PROTOCOL_VERSION}`);
});

test("sanitizeForLog collapses control characters and caps by code points", () => {
  assert.equal(sanitizeForLog("a\r\nb\tc\u001b[31md"), "a b c [31md");
  assert.equal(sanitizeForLog(`x${String.fromCharCode(0x2029)}y\u0085z`), "x y z");
  assert.equal(sanitizeForLog("  padded\n"), "padded");
  assert.equal(sanitizeForLog("abcdef", 3), "abc…");
  // A surrogate pair counts as one character and is never split.
  assert.equal(sanitizeForLog("😀😀😀", 2), "😀😀…");
  assert.equal(sanitizeForLog("x".repeat(LOG_FIELD_MAX_CHARS)), "x".repeat(LOG_FIELD_MAX_CHARS));
});

test("ping answers an empty result and keeps a string id", async () => {
  const res = response(await dispatchMcpMessage(request("abc", "ping"), context()));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { jsonrpc: "2.0", id: "abc", result: {} });
});

test("tools/list returns every definition and ignores a cursor", async () => {
  const result = resultOf(await dispatchMcpMessage(request(3, "tools/list", { cursor: "next" }), context()));
  assert.deepEqual(
    result.tools,
    tools.map((t) => t.definition),
  );
  assert.equal("nextCursor" in result, false);
});

test("tools/call runs the tool with its arguments and the resolved caller", async () => {
  const ctx = context();
  const result = await dispatchMcpMessage(
    request(4, "tools/call", { name: "echo", arguments: { text: "hi" } }),
    ctx,
  );
  const res = response(result);
  assert.equal(res.method, "tools/call");
  assert.equal(res.tool, "echo");
  assert.deepEqual(resultOf(result), {
    content: [{ type: "text", text: JSON.stringify({ args: { text: "hi" }, sessionId: "s-1" }) }],
  });
  assert.equal(ctx.callers, 1);
});

test("tools/call without arguments (or null) passes an empty object", async () => {
  for (const params of [{ name: "echo" }, { name: "echo", arguments: null }]) {
    const result = resultOf(await dispatchMcpMessage(request(5, "tools/call", params), context()));
    const content = result.content as Array<{ text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), { args: {}, sessionId: "s-1" });
  }
});

test("tools/call refuses an unknown tool and bad arguments with -32602 without resolving the caller", async () => {
  const ctx = context();
  const unknown = await dispatchMcpMessage(request(6, "tools/call", { name: "nope" }), ctx);
  assert.deepEqual(errorOf(unknown), { id: 6, code: JSONRPC_INVALID_PARAMS, message: "Unknown tool: nope" });
  assert.equal(response(unknown).status, 200);
  assert.equal(response(unknown).tool, "nope");

  for (const args of [[1, 2], "text", 3, true]) {
    const bad = await dispatchMcpMessage(request(7, "tools/call", { name: "echo", arguments: args }), ctx);
    assert.equal(errorOf(bad).code, JSONRPC_INVALID_PARAMS);
    assert.equal(errorOf(bad).id, 7);
  }
  for (const params of [undefined, {}, { name: 5 }, ["echo"]]) {
    const bad = await dispatchMcpMessage(request(8, "tools/call", params), ctx);
    assert.equal(errorOf(bad).code, JSONRPC_INVALID_PARAMS);
  }
  assert.equal(ctx.callers, 0);
});

test("a throwing tool (sync or async) becomes an isError result", async () => {
  for (const [name, message] of [
    ["async_boom", "async boom"],
    ["sync_boom", "sync boom"],
  ] as const) {
    const result = await dispatchMcpMessage(request(9, "tools/call", { name }), context());
    assert.equal(response(result).status, 200);
    assert.deepEqual(resultOf(result), { content: [{ type: "text", text: message }], isError: true });
  }
});

test("a rejected caller becomes an isError result and the tool does not run", async () => {
  let ran = false;
  const guarded: AgentLinkTool = {
    definition: { name: "guarded", description: "", inputSchema: { type: "object" } },
    call: () => {
      ran = true;
      return { content: [] };
    },
  };
  const result = await dispatchMcpMessage(
    request(10, "tools/call", { name: "guarded" }),
    context({ tools: [guarded], resolveCaller: () => Promise.reject(new Error("this session is not ready yet")) }),
  );
  assert.deepEqual(resultOf(result), {
    content: [{ type: "text", text: "this session is not ready yet" }],
    isError: true,
  });
  assert.equal(ran, false);
});

test("a tool result without a content array gets an empty one", async () => {
  const result = resultOf(await dispatchMcpMessage(request(11, "tools/call", { name: "no_content" }), context()));
  assert.deepEqual(result, { structuredContent: { ok: true }, content: [] });
});

test("an unknown method is -32601 with the request id", async () => {
  const result = await dispatchMcpMessage(request(12, "completion/complete"), context());
  assert.equal(response(result).status, 200);
  assert.equal(response(result).method, "completion/complete");
  assert.deepEqual(errorOf(result), {
    id: 12,
    code: JSONRPC_METHOD_NOT_FOUND,
    message: "Method not found: completion/complete",
  });
});

test("resources and prompts are listed empty for clients that ask without the capability", async () => {
  assert.deepEqual(resultOf(await dispatchMcpMessage(request(13, "resources/list"), context())), { resources: [] });
  assert.deepEqual(resultOf(await dispatchMcpMessage(request(14, "resources/templates/list"), context())), {
    resourceTemplates: [],
  });
  assert.deepEqual(resultOf(await dispatchMcpMessage(request(15, "prompts/list"), context())), { prompts: [] });
});

test("notifications and client responses are accepted without a body", async () => {
  assert.deepEqual(await dispatchMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, context()), {
    kind: "accepted",
    method: "notifications/initialized",
  });
  assert.deepEqual(
    await dispatchMcpMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }, context()),
    { kind: "accepted", method: "notifications/cancelled" },
  );
  // A notification named like a request is still a notification (no id, no reply).
  const ctx = context();
  assert.deepEqual(await dispatchMcpMessage({ jsonrpc: "2.0", method: "tools/call", params: { name: "echo" } }, ctx), {
    kind: "accepted",
    method: "tools/call",
  });
  assert.equal(ctx.callers, 0);
  assert.deepEqual(await dispatchMcpMessage({ jsonrpc: "2.0", id: 5, result: {} }, context()), { kind: "accepted" });
  assert.deepEqual(
    await dispatchMcpMessage({ jsonrpc: "2.0", id: "x", error: { code: -1, message: "no" } }, context()),
    { kind: "accepted" },
  );
});

test("anything that is not one JSON-RPC 2.0 message is -32600 with id null and status 400", async () => {
  const cases: unknown[] = [
    [request(1, "ping"), request(2, "ping")],
    [],
    null,
    "ping",
    42,
    { id: 1, method: "ping" },
    { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", id: 1, method: 7 },
    { jsonrpc: "2.0", id: 1, method: "" },
    { jsonrpc: "2.0", id: null, method: "ping" },
    { jsonrpc: "2.0", id: { a: 1 }, method: "ping" },
    { jsonrpc: "2.0", id: true, method: "ping" },
  ];
  for (const message of cases) {
    const result = await dispatchMcpMessage(message, context());
    const res = response(result);
    assert.equal(res.status, 400, JSON.stringify(message));
    assert.equal(res.method, undefined);
    assert.deepEqual(errorOf(result).id, null);
    assert.equal(errorOf(result).code, JSONRPC_INVALID_REQUEST, JSON.stringify(message));
  }
});
