import { test } from "node:test";
import assert from "node:assert/strict";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpError, AUTH_REQUIRED_CODE, type SessionEvent, type SessionState } from "../src/acp/index.js";
import { chunkText, launch, makeServices, rejectFirst, toolUpdates, updatesOf, waitFor } from "./harness.js";

const text = (value: string): acp.ContentBlock[] => [{ type: "text", text: value }];

function latestState(events: SessionEvent[]): SessionState | undefined {
  const states = events.filter((e): e is Extract<SessionEvent, { type: "state" }> => e.type === "state");
  return states[states.length - 1]?.session;
}

test("initialize exchange exposes capabilities, agent info and Kiro extension methods", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    assert.equal(h.agent.status, "stopped");
    const info = await h.agent.start();
    assert.equal(h.agent.status, "ready");
    assert.equal(info.protocolVersion, 1);
    assert.equal(info.agentInfo?.name, "fake-kiro");
    assert.equal(info.agentCapabilities.promptCapabilities?.image, true);
    assert.deepEqual(info.kiroExtensionMethods, ["_kiro/session/context", "_kiro/account/getUsage"]);
    assert.deepEqual(info.authMethods, []);
    assert.deepEqual(
      h.changes.map((c) => c.status),
      ["starting", "ready"],
    );
    assert.equal(h.changes[1]?.agent, info);

    const sent = h.logger.traces.filter((t) => t.direction === "send");
    const received = h.logger.traces.filter((t) => t.direction === "recv");
    assert.equal(sent.length, 1);
    const init = JSON.parse(sent[0]!.payload) as { method: string; params: acp.InitializeRequest };
    assert.equal(init.method, "initialize");
    assert.equal(init.params.clientCapabilities?.terminal, true);
    assert.equal(init.params.clientCapabilities?.auth?.terminal, true);
    assert.equal(init.params.clientInfo?.name, "kiro-acp-vscode");
    assert.equal(init.params.clientInfo?.version, "0.1.0-test");
    assert.equal(received.length, 1);
    assert.ok(received[0]!.payload.includes("fake-kiro"));

    // start() is idempotent while running
    assert.equal(await h.agent.start(), info);
  } finally {
    await h.agent.stop();
  }
  assert.equal(h.agent.status, "stopped");
  assert.equal(h.changes[h.changes.length - 1]?.status, "stopped");
  await h.agent.stop(); // idempotent
});

test("signed-out agent: session/new failure maps to auth_required and terminal auth is delegated to the host", async () => {
  const h = launch({ args: ["--scenario", "chat", "--auth-required"] });
  try {
    const info = await h.agent.start();
    assert.equal(info.authMethods.length, 1);
    const method = info.authMethods[0]!;
    assert.equal(method.id, "kiro-login");
    assert.ok("type" in method && method.type === "terminal");

    await assert.rejects(
      () => h.agent.newSession(h.cwd),
      (error: unknown) => error instanceof AcpError && error.code === AUTH_REQUIRED_CODE,
    );
    assert.equal(h.agent.status, "auth_required");
    assert.equal(h.changes[h.changes.length - 1]?.status, "auth_required");
    assert.equal(h.changes[h.changes.length - 1]?.agent?.authMethods.length, 1);

    await h.agent.authenticate("kiro-login");
    assert.equal(h.services.terminalAuthRuns.length, 1);
    assert.equal(h.services.terminalAuthRuns[0]?.method.id, "kiro-login");
    assert.equal(h.services.terminalAuthRuns[0]?.executable, process.execPath);
    await assert.rejects(() => h.agent.authenticate("nope"), /Unknown auth method/);
  } finally {
    await h.agent.stop();
  }
});

test("streamed chat: events arrive in order and the turn finishes with the prompt response", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    assert.equal(session.cwd, h.cwd);
    assert.equal(session.modes?.currentModeId, "vibe");
    assert.deepEqual(session.configOptions?.map((o) => o.id), ["model", "effortLevel", "autoCompact"]);
    assert.equal(session.models, null);
    assert.deepEqual(session.meta, { kiro: { engine: "v3" } });
    assert.equal(h.events[0]?.type, "state");

    await waitFor(() => (latestState(h.events)?.availableCommands.length ?? 0) === 2, 5000, "commands update");
    assert.deepEqual(
      latestState(h.events)?.availableCommands.map((c) => c.name),
      ["plan", "compact"],
    );

    const before = h.events.length;
    const response = await h.agent.prompt(session.sessionId, text("hello"));
    assert.equal(response.stopReason, "end_turn");
    const turnEvents = h.events.slice(before).map((e) => e.type);
    assert.deepEqual(turnEvents, ["turn_started", "update", "update", "update", "turn_finished"]);
    assert.equal(chunkText(h.events), "The answer is 42.");
    const finished = h.events[h.events.length - 1];
    assert.ok(finished?.type === "turn_finished" && finished.stopReason === "end_turn");
    for (const event of h.events) {
      if (event.type === "update") assert.equal(event.sessionId, session.sessionId);
    }

    await waitFor(() => h.logger.lines.some((l) => l.level === "warn" && l.message.includes("fake-agent: chat scenario")), 5000, "stderr warn");
    assert.ok(h.logger.traces.some((t) => t.direction === "stderr" && t.payload === "fake-agent: chat scenario"));
    assert.ok(h.logger.traces.some((t) => t.direction === "send" && t.payload.includes("session/prompt")));
    assert.ok(h.logger.traces.some((t) => t.direction === "recv" && t.payload.includes("agent_message_chunk")));
  } finally {
    await h.agent.stop();
  }
});

test("refusal stop reason is reported", async () => {
  const h = launch({ args: ["--scenario", "refusal"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    const response = await h.agent.prompt(session.sessionId, text("do something bad"));
    assert.equal(response.stopReason, "refusal");
  } finally {
    await h.agent.stop();
  }
});

test("cancel interrupts a streaming turn with stopReason cancelled", async () => {
  const h = launch({ args: ["--scenario", "cancel"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    const pending = h.agent.prompt(session.sessionId, text("go"));
    await waitFor(() => updatesOf(h.events, "agent_message_chunk").length >= 3, 5000, "three chunks");
    await h.agent.cancel(session.sessionId);
    const response = await pending;
    assert.equal(response.stopReason, "cancelled");
    assert.ok(updatesOf(h.events, "agent_message_chunk").length < 40);
    const last = h.events[h.events.length - 1];
    assert.ok(last?.type === "turn_finished" && last.stopReason === "cancelled");
    assert.ok(h.logger.traces.some((t) => t.direction === "send" && t.payload.includes('"session/cancel"')));
  } finally {
    await h.agent.stop();
  }
});

test("cancel resolves a pending permission request as cancelled", async () => {
  const services = makeServices();
  let permissionSignal: AbortSignal | null = null;
  let hostResolve: ((r: acp.RequestPermissionResponse) => void) | null = null;
  services.decidePermission = (_request, signal) =>
    new Promise((resolve) => {
      permissionSignal = signal;
      hostResolve = resolve;
    });
  const h = launch({ args: ["--scenario", "permission-reject"], services });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    const pending = h.agent.prompt(session.sessionId, text("edit"));
    await waitFor(() => permissionSignal !== null, 5000, "permission request");
    assert.equal(permissionSignal!.aborted, false);
    await h.agent.cancel(session.sessionId);
    assert.equal(permissionSignal!.aborted, true);
    const response = await pending;
    assert.equal(response.stopReason, "cancelled");
    const updates = toolUpdates(h.events, "call-edit");
    const failed = updates.find((u) => u.status === "failed");
    assert.ok(failed, "tool call failed after cancel");
    assert.equal((failed._meta as { kiro: { failureReason: string } }).kiro.failureReason, "cancelled");
    // a late answer from the host is ignored
    hostResolve!({ outcome: { outcome: "selected", optionId: "accept" } });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!h.services.calls.some((c) => c.method === "fs/write_text_file"));
  } finally {
    await h.agent.stop();
  }
});

test("tour: fs, terminal and permission round-trips through ClientServices", async () => {
  const h = launch({ args: ["--scenario", "tour"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    const response = await h.agent.prompt(session.sessionId, text("tour"));
    assert.equal(response.stopReason, "end_turn");
    const transcript = chunkText(h.events);
    assert.ok(!transcript.includes("[fake-agent]"), `fake agent reported a problem: ${transcript}`);
    assert.equal(transcript, "Hello! I am the fake Kiro agent. Let me look around.All done.");
    assert.equal(chunkText(h.events, "agent_thought_chunk"), `Planning the tour of ${h.cwd}.`);

    const methods = h.services.calls.map((c) => c.method);
    assert.deepEqual(methods, [
      "_kiro/openExternalUrl",
      "fs/read_text_file",
      "terminal/create",
      "terminal/output",
      "terminal/wait_for_exit",
      "terminal/release",
      "session/request_permission",
      "fs/write_text_file",
    ]);
    assert.deepEqual(h.services.openedUrls, ["https://example.invalid/oauth"]);

    const read = h.services.calls.find((c) => c.method === "fs/read_text_file")?.params as acp.ReadTextFileRequest;
    assert.equal(read.path, `${h.cwd}/README.md`);
    assert.equal(read.sessionId, session.sessionId);
    assert.equal(read.limit, 20);

    const create = h.services.calls.find((c) => c.method === "terminal/create")?.params as acp.CreateTerminalRequest;
    assert.equal(create.command, "echo");
    assert.deepEqual(create.args, ["hello"]);
    for (const method of ["terminal/output", "terminal/wait_for_exit", "terminal/release"]) {
      const params = h.services.calls.find((c) => c.method === method)?.params as acp.TerminalOutputRequest;
      assert.equal(params.terminalId, "term-1");
    }
    const execUpdates = toolUpdates(h.events, "call-exec");
    const terminalContent = execUpdates.find((u) => u.content?.some((c) => c.type === "terminal"));
    assert.ok(terminalContent);
    assert.deepEqual(terminalContent.content, [{ type: "terminal", terminalId: "term-1" }]);
    assert.equal(execUpdates[execUpdates.length - 1]?.status, "completed");

    const permission = h.services.calls.find((c) => c.method === "session/request_permission")?.params as acp.RequestPermissionRequest;
    assert.equal(permission.toolCall.toolCallId, "call-edit");
    assert.deepEqual(
      permission.options.map((o) => o.kind),
      ["allow_once", "allow_always", "reject_once", "reject_always"],
    );
    const consent = (permission._meta as { kiro: { consent: { capability: string } } }).kiro.consent;
    assert.equal(consent.capability, "fs_write");

    const write = h.services.calls.find((c) => c.method === "fs/write_text_file")?.params as acp.WriteTextFileRequest;
    assert.equal(write.path, `${h.cwd}/hello.txt`);
    assert.equal(write.content, "hello from kiro\n");
    const editUpdates = toolUpdates(h.events, "call-edit");
    assert.deepEqual(editUpdates.map((u) => u.status), ["in_progress", "completed"]);

    const plans = updatesOf(h.events, "plan");
    assert.equal(plans.length, 2);
    assert.equal((plans[1] as acp.Plan).entries[0]?.status, "completed");

    const ext = h.events.filter((e): e is Extract<SessionEvent, { type: "extension_notification" }> => e.type === "extension_notification");
    assert.deepEqual(
      ext.map((e) => e.method),
      ["_kiro/mcp/status", "session/update"],
    );
    const unknownUpdate = ext[1]!.params as { update: { sessionUpdate: string } };
    assert.equal(unknownUpdate.update.sessionUpdate, "kiro_custom_update");
  } finally {
    await h.agent.stop();
  }
});

test("rejected permission fails the tool call with failureReason denied", async () => {
  const services = makeServices();
  services.decidePermission = async (request) => rejectFirst(request);
  const h = launch({ args: ["--scenario", "permission-reject"], services });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    const response = await h.agent.prompt(session.sessionId, text("edit"));
    assert.equal(response.stopReason, "end_turn");
    assert.ok(!h.services.calls.some((c) => c.method === "fs/write_text_file"));
    const failed = toolUpdates(h.events, "call-edit").find((u) => u.status === "failed");
    assert.ok(failed);
    assert.equal((failed._meta as { kiro: { failureReason: string } }).kiro.failureReason, "denied");
    assert.equal(chunkText(h.events), "Understood.");
  } finally {
    await h.agent.stop();
  }
});

test("switch_mode permission: approving switches the mode", async () => {
  const h = launch({ args: ["--scenario", "switch-mode"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    await h.agent.setMode(session.sessionId, "plan");
    await waitFor(() => latestState(h.events)?.modes?.currentModeId === "plan", 5000, "plan mode");
    const response = await h.agent.prompt(session.sessionId, text("make a plan"));
    assert.equal(response.stopReason, "end_turn");
    const permission = h.services.calls.find((c) => c.method === "session/request_permission")?.params as acp.RequestPermissionRequest;
    assert.equal(permission.toolCall.kind, "switch_mode");
    assert.equal(permission.toolCall.title, "Approve plan and start implementation");
    assert.equal(latestState(h.events)?.modes?.currentModeId, "vibe");
    assert.ok(chunkText(h.events).includes("Starting implementation."));
  } finally {
    await h.agent.stop();
  }
});

test("unknown request from the agent is answered with -32601", async () => {
  const h = launch({ args: ["--scenario", "bad-request"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    const response = await h.agent.prompt(session.sessionId, text("go"));
    assert.equal(response.stopReason, "end_turn");
    assert.equal(chunkText(h.events), "unknown request rejected with -32601");
    assert.ok(h.logger.lines.some((l) => l.level === "warn" && l.message.includes("_kiro/unknown/thing")));
    const reply = h.logger.traces.find((t) => t.direction === "send" && t.payload.includes("-32601"));
    assert.ok(reply, "error response traced");
  } finally {
    await h.agent.stop();
  }
});

test("set_mode, set_config_option and extension calls update SessionState (v3)", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);

    await h.agent.setMode(session.sessionId, "plan");
    await waitFor(() => latestState(h.events)?.modes?.currentModeId === "plan", 5000, "mode state");
    assert.equal(latestState(h.events)?.modes?.availableModes.length, 2);
    await assert.rejects(() => h.agent.setMode(session.sessionId, "bogus"), (e: unknown) => e instanceof AcpError && e.code === -32602);

    const options = await h.agent.setConfigOption(session.sessionId, "model", "claude-opus-4");
    assert.equal(options.find((o) => o.id === "model")?.currentValue, "claude-opus-4");
    assert.equal(latestState(h.events)?.configOptions?.find((o) => o.id === "model")?.currentValue, "claude-opus-4");

    const bools = await h.agent.setConfigOption(session.sessionId, "autoCompact", false);
    assert.equal(bools.find((o) => o.id === "autoCompact")?.currentValue, false);
    const sentBool = h.logger.traces.find(
      (t) => t.direction === "send" && t.payload.includes("session/set_config_option") && t.payload.includes("autoCompact"),
    );
    assert.ok(sentBool);
    assert.ok(sentBool.payload.includes('"type":"boolean"'));

    await assert.rejects(() => h.agent.setModel(session.sessionId, "claude-opus-4"), /did not advertise models/);

    const echoed = await h.agent.callExtension<{ ok: boolean; echoed: unknown }>("_kiro/session/context", { sessionId: session.sessionId });
    assert.equal(echoed.ok, true);
    assert.deepEqual(echoed.echoed, { sessionId: session.sessionId });
    await assert.rejects(
      () => h.agent.callExtension("_kiro/not/advertised", {}),
      (e: unknown) => e instanceof AcpError && e.code === -32601,
    );

    // prompting with a scenario selector works regardless of the launch scenario
    const response = await h.agent.prompt(session.sessionId, text("/scenario refusal"));
    assert.equal(response.stopReason, "refusal");
  } finally {
    await h.agent.stop();
  }
});

test("CLI v2: models on session/new, session/set_model and _kiro.dev/commands/available", async () => {
  const h = launch({ args: ["--scenario", "chat", "--engine", "v2"] });
  try {
    const info = await h.agent.start();
    assert.deepEqual(info.kiroExtensionMethods, []);
    const session = await h.agent.newSession(h.cwd);
    assert.equal(session.configOptions, null);
    assert.equal(session.models?.currentModelId, "claude-sonnet-4");
    assert.deepEqual(
      session.models?.availableModels.map((m) => m.modelId),
      ["claude-sonnet-4", "claude-opus-4"],
    );

    await waitFor(() => (latestState(h.events)?.availableCommands.length ?? 0) === 2, 5000, "v2 commands");
    assert.deepEqual(latestState(h.events)?.availableCommands, [
      { name: "help", description: "Show help" },
      { name: "context", description: "Manage context", input: { hint: "add <file>" } },
    ]);
    const synthetic = updatesOf(h.events, "available_commands_update");
    assert.equal(synthetic.length, 1);
    assert.ok(!h.events.some((e) => e.type === "extension_notification" && e.method === "_kiro.dev/commands/available"));

    await h.agent.setModel(session.sessionId, "claude-opus-4");
    assert.equal(latestState(h.events)?.models?.currentModelId, "claude-opus-4");
    await assert.rejects(() => h.agent.setModel(session.sessionId, "nope"), (e: unknown) => e instanceof AcpError && e.code === -32602);
    await assert.rejects(
      () => h.agent.callExtension("_kiro/session/context", {}),
      (e: unknown) => e instanceof AcpError && e.code === -32601,
    );
  } finally {
    await h.agent.stop();
  }
});

test("process exit mid-turn rejects the prompt and reports an error status", async () => {
  const h = launch({ args: ["--scenario", "crash"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    await assert.rejects(() => h.agent.prompt(session.sessionId, text("crash")), AcpError);
    await waitFor(() => h.agent.status === "error", 5000, "error status");
    const last = h.changes[h.changes.length - 1];
    assert.equal(last?.status, "error");
    assert.match(last?.message ?? "", /code 3/);
    assert.ok(h.events.some((e) => e.type === "turn_failed"));
    await assert.rejects(() => h.agent.newSession(h.cwd), /not running/);
  } finally {
    await h.agent.stop();
  }
  assert.equal(h.agent.status, "stopped");
});

test("stop() terminates the process cleanly and a missing executable is reported", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  await h.agent.start();
  await h.agent.stop();
  assert.equal(h.agent.status, "stopped");
  assert.deepEqual(
    h.changes.map((c) => c.status),
    ["starting", "ready", "stopped"],
  );

  const missing = launch({ command: "definitely-not-a-real-binary-xyz" });
  try {
    await assert.rejects(() => missing.agent.start(), AcpError);
    assert.equal(missing.agent.status, "error");
    assert.match(missing.changes[missing.changes.length - 1]?.message ?? "", /Failed to start/);
  } finally {
    await missing.agent.stop();
  }
});
