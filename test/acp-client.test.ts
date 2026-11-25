import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  AcpError,
  AUTH_REQUIRED_CODE,
  FALLBACK_LOGIN_METHOD,
  isAuthRequiredError,
  KiroAgentImpl,
  type SessionEvent,
  type SessionState,
} from "../src/acp/index.js";
import { framePeerMessage } from "../src/agentLink/peerMessage.js";
import { chunkText, FAKE_AGENT, launch, makeServices, rejectFirst, toolUpdates, updatesOf, waitFor } from "./harness.js";

const text = (value: string): acp.ContentBlock[] => [{ type: "text", text: value }];

function getSession(h: { agent: unknown }, sessionId: string): SessionState | null {
  assert.ok(h.agent instanceof KiroAgentImpl);
  return h.agent.getSession(sessionId);
}

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
    const advertised = h.services.terminalAuthRuns[0]!;
    assert.equal(advertised.method.id, "kiro-login");
    assert.equal(advertised.command, process.execPath);
    // The method's args extend the configured invocation: `<cli> acp … --login`.
    assert.deepEqual(advertised.args, [FAKE_AGENT, "acp", "--scenario", "chat", "--auth-required"]);
    assert.ok("args" in advertised.method);
    assert.deepEqual(advertised.method.args, ["--login"]);
    await assert.rejects(() => h.agent.authenticate("nope"), /Unknown auth method/);
  } finally {
    await h.agent.stop();
  }
});

test("isAuthRequiredError recognises the auth code and Kiro's signed-out messages", () => {
  assert.equal(isAuthRequiredError({ code: AUTH_REQUIRED_CODE, message: "nope" }), true);
  assert.equal(
    isAuthRequiredError({
      code: -32603,
      message: "Auth refresh callback failed: Internal error: You are not logged in. Please log in with `kiro-cli login`.",
    }),
    true,
  );
  assert.equal(isAuthRequiredError({ code: -32603, message: "authentication required" }), true);
  assert.equal(isAuthRequiredError({ code: -32603, message: "Internal error: model unavailable" }), false);
  assert.equal(isAuthRequiredError({ message: "session not found" }), false);
});

test("expired token: a prompt rejected as signed out maps to auth_required with the terminal login fallback", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    const info = await h.agent.start();
    assert.deepEqual(info.authMethods, []);
    const session = await h.agent.newSession(h.cwd);
    assert.equal(h.agent.status, "ready");

    await assert.rejects(
      () => h.agent.prompt(session.sessionId, text("/scenario auth-expired")),
      (error: unknown) => error instanceof AcpError && /not logged in/.test(error.message),
    );
    assert.equal(h.agent.status, "auth_required");
    const change = h.changes[h.changes.length - 1];
    assert.equal(change?.status, "auth_required");
    assert.match(change?.message ?? "", /kiro-cli login/);
    assert.deepEqual(
      change?.agent?.authMethods.map((m) => m.id),
      [FALLBACK_LOGIN_METHOD.id],
    );
    assert.ok(h.events.some((e) => e.type === "turn_failed" && e.sessionId === session.sessionId));

    // The fallback runs `<cliPath> login` through the host's terminal auth.
    await h.agent.authenticate(FALLBACK_LOGIN_METHOD.id);
    assert.equal(h.services.terminalAuthRuns.length, 1);
    const run = h.services.terminalAuthRuns[0]!;
    assert.equal(run.method.id, "kiro-cli-login");
    assert.ok("args" in run.method);
    assert.deepEqual(run.method.args, ["login"]);
    assert.equal(run.command, process.execPath);
    // The fallback is standalone: `<cli> login`, not `<cli> acp … login`.
    assert.deepEqual(run.args, []);
  } finally {
    await h.agent.stop();
  }
});

test("refresh-only agent auth methods: authenticate falls back to the terminal login and only it is offered", async () => {
  const h = launch({ args: ["--scenario", "chat", "--auth-agent-methods"] });
  try {
    const info = await h.agent.start();
    assert.deepEqual(
      info.authMethods.map((m) => m.id),
      ["aws-builder-id", "aws-iam-identity-center"],
    );
    // Kiro rejects `authenticate` as "not logged in": `kiro-cli login` runs instead.
    await h.agent.authenticate("aws-builder-id");
    assert.equal(h.services.terminalAuthRuns.length, 1);
    const run = h.services.terminalAuthRuns[0]!;
    assert.equal(run.method.id, FALLBACK_LOGIN_METHOD.id);
    assert.deepEqual(run.args, []);

    await assert.rejects(() => h.agent.newSession(h.cwd));
    assert.equal(h.agent.status, "auth_required");
    // Signed out: only the terminal login is offered, not the refresh-only methods.
    assert.deepEqual(
      h.changes[h.changes.length - 1]?.agent?.authMethods.map((m) => m.id),
      [FALLBACK_LOGIN_METHOD.id],
    );
  } finally {
    await h.agent.stop();
  }
});

test("the terminal login fallback is accepted even while the agent is signed in (/login)", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    await h.agent.start();
    await h.agent.authenticate(FALLBACK_LOGIN_METHOD.id);
    assert.equal(h.services.terminalAuthRuns.length, 1);
    assert.equal(h.agent.status, "ready");
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

/** A 1×1 PNG. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("image blocks reach the agent in order; an image-only prompt runs the images recording; --no-image hides the capability", async () => {
  const bytes = Buffer.from(PNG_1PX, "base64").length;
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);

    let before = h.events.length;
    const response = await h.agent.prompt(session.sessionId, [
      { type: "text", text: "/scenario images what is this?" },
      { type: "image", mimeType: "image/png", data: PNG_1PX, uri: "file:///tmp/my%20shot.png" },
      { type: "resource_link", uri: "file:///tmp/notes.md", name: "notes.md" },
    ]);
    assert.equal(response.stopReason, "end_turn");
    assert.equal(
      chunkText(h.events.slice(before)),
      `Received 1 image(s): image/png ${bytes} B my shot.png; blocks: text,image,resource_link.`,
    );

    before = h.events.length;
    await h.agent.prompt(session.sessionId, [
      { type: "image", mimeType: "image/png", data: PNG_1PX },
      { type: "image", mimeType: "image/png", data: PNG_1PX },
    ]);
    assert.equal(
      chunkText(h.events.slice(before)),
      `Received 2 image(s): image/png ${bytes} B, image/png ${bytes} B; blocks: image,image.`,
    );
  } finally {
    await h.agent.stop();
  }

  const noImage = launch({ args: ["--scenario", "chat", "--no-image"] });
  try {
    const info = await noImage.agent.start();
    assert.equal(info.agentCapabilities.promptCapabilities?.image, undefined);
    assert.equal(info.agentCapabilities.promptCapabilities?.embeddedContext, true);
  } finally {
    await noImage.agent.stop();
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

test("session/list: rejected when not advertised (v2), canned sessions with cwd filter (v3)", async () => {
  const v2 = launch({ args: ["--scenario", "chat", "--engine", "v2"] });
  try {
    const info = await v2.agent.start();
    assert.equal(info.agentCapabilities.loadSession, false);
    assert.equal(info.agentCapabilities.sessionCapabilities?.list, undefined);
    await assert.rejects(
      () => v2.agent.listSessions(),
      (e: unknown) => e instanceof AcpError && /did not advertise session\/list/.test(e.message),
    );
    await assert.rejects(
      () => v2.agent.loadSession("past-1", v2.cwd),
      (e: unknown) => e instanceof AcpError && /did not advertise session\/load/.test(e.message),
    );
    assert.ok(!v2.logger.traces.some((t) => t.direction === "send" && t.payload.includes("session/list")));
  } finally {
    await v2.agent.stop();
  }

  const h = launch({ args: ["--scenario", "chat"] });
  try {
    const info = await h.agent.start();
    assert.equal(info.agentCapabilities.loadSession, true);
    assert.deepEqual(info.agentCapabilities.sessionCapabilities?.list, {});

    const all = await h.agent.listSessions();
    assert.equal(all.nextCursor, null);
    assert.deepEqual(
      all.sessions.map((s) => [s.sessionId, s.title]),
      [
        ["past-1", "Investigate flaky CI"],
        ["past-2", "Add retry to fetch"],
      ],
    );
    for (const entry of all.sessions) {
      assert.equal(entry.cwd, h.cwd);
      assert.match(entry.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    }

    // live sessions join the list, newest first; the cwd filter matches exactly.
    // Three matches exceed the fake agent's page size (2): the first page
    // carries a cursor, which listSessions() passes through for the second.
    const session = await h.agent.newSession(h.cwd);
    const withLive = await h.agent.listSessions({ cwd: h.cwd });
    assert.deepEqual(
      withLive.sessions.map((s) => s.sessionId),
      [session.sessionId, "past-1"],
    );
    assert.equal(typeof withLive.nextCursor, "string");
    const secondPage = await h.agent.listSessions({ cwd: h.cwd, cursor: withLive.nextCursor! });
    assert.deepEqual(
      secondPage.sessions.map((s) => s.sessionId),
      ["past-2"],
    );
    assert.equal(secondPage.nextCursor, null);
    const elsewhere = await h.agent.listSessions({ cwd: `${h.cwd}-elsewhere` });
    assert.deepEqual(elsewhere.sessions, []);
    assert.equal(elsewhere.nextCursor, null);
    const sentLists = h.logger.traces.filter((t) => t.direction === "send" && t.payload.includes('"session/list"'));
    assert.equal(sentLists.length, 4);
    const secondRequest = JSON.parse(sentLists[2]!.payload) as { params: acp.ListSessionsRequest };
    assert.equal(secondRequest.params.cursor, withLive.nextCursor);
    assert.equal(secondRequest.params.cwd, h.cwd);
    assert.ok(!sentLists[1]!.payload.includes('"cursor"'), "the first page is requested without a cursor");
    assert.ok(sentLists[3]!.payload.includes("-elsewhere"));
  } finally {
    await h.agent.stop();
  }
});

test("session/load replays history with replay: true, then prompts stream live", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    await h.agent.start();
    assert.equal(getSession(h, "past-1"), null);

    const state = await h.agent.loadSession("past-1", h.cwd);
    assert.equal(state.sessionId, "past-1");
    assert.equal(state.cwd, h.cwd);
    assert.equal(state.modes?.currentModeId, "vibe");
    assert.deepEqual(state.configOptions?.map((o) => o.id), ["model", "effortLevel", "autoCompact"]);
    assert.equal(state.models, null);
    assert.equal(getSession(h, "past-1"), state);

    const sent = h.logger.traces.find((t) => t.direction === "send" && t.payload.includes('"session/load"'));
    assert.ok(sent);
    const loadRequest = JSON.parse(sent.payload) as { params: acp.LoadSessionRequest };
    assert.equal(loadRequest.params.sessionId, "past-1");
    assert.equal(loadRequest.params.cwd, h.cwd);
    assert.deepEqual(loadRequest.params.mcpServers, []);

    // everything before the `state` event is replayed history, flagged as such
    const stateIndex = h.events.findIndex((e) => e.type === "state");
    assert.ok(stateIndex >= 4, `expected replayed updates before the state event, got ${stateIndex}`);
    assert.equal(h.events[stateIndex]?.type === "state" && h.events[stateIndex].session.sessionId, "past-1");
    const replayed = h.events
      .slice(0, stateIndex)
      .filter((e): e is Extract<SessionEvent, { type: "update" }> => e.type === "update");
    assert.equal(replayed.length, stateIndex);
    for (const event of replayed) {
      assert.equal(event.sessionId, "past-1");
      assert.equal(event.replay, true);
      const meta = (event.update as { _meta?: { kiro?: { replay?: boolean } } })._meta;
      assert.equal(meta?.kiro?.replay, true);
    }
    const user = replayed.find((e) => e.update.sessionUpdate === "user_message_chunk")?.update;
    assert.ok(user && user.sessionUpdate === "user_message_chunk");
    assert.equal(user.messageId, "u-past-1-1");
    assert.equal(user.content.type === "text" ? user.content.text : "", "Why is CI flaky?");
    const agentChunk = replayed.find((e) => e.update.sessionUpdate === "agent_message_chunk")?.update;
    assert.ok(agentChunk && agentChunk.sessionUpdate === "agent_message_chunk");
    assert.equal(agentChunk.messageId, "a-past-1-1");
    const toolCall = replayed.find((e) => e.update.sessionUpdate === "tool_call")?.update;
    assert.ok(toolCall && toolCall.sessionUpdate === "tool_call");
    assert.equal(toolCall.kind, "read");
    assert.equal(toolCall.status, "completed");
    assert.equal(chunkText(h.events), "Let me look at .github/workflows/ci.yml. The test job has no retry and the network step times out.");

    // the post-load commands update is routed to the loaded session and is not a replay
    await waitFor(() => (latestState(h.events)?.availableCommands.length ?? 0) === 2, 5000, "commands after load");
    const commandsEvent = h.events.find(
      (e): e is Extract<SessionEvent, { type: "update" }> => e.type === "update" && e.update.sessionUpdate === "available_commands_update",
    );
    assert.ok(commandsEvent);
    assert.equal(commandsEvent.replay, undefined);
    assert.equal(getSession(h, "past-1")?.availableCommands.length, 2);

    // a prompt on the loaded session streams normally, without the replay flag
    const before = h.events.length;
    const response = await h.agent.prompt("past-1", text("and now?"));
    assert.equal(response.stopReason, "end_turn");
    const turn = h.events.slice(before);
    assert.deepEqual(turn.map((e) => e.type), ["turn_started", "update", "update", "update", "turn_finished"]);
    for (const event of turn) {
      if (event.type === "update") {
        assert.equal(event.sessionId, "past-1");
        assert.equal(event.replay, undefined);
      }
    }
    assert.equal(chunkText(turn), "The answer is 42.");

    // the prompt was appended to the session history (it is now the newest session)
    const listed = await h.agent.listSessions();
    assert.equal(listed.sessions[0]?.sessionId, "past-1");
    assert.equal(listed.sessions[0]?.title, "Investigate flaky CI");
  } finally {
    await h.agent.stop();
  }
});

test("session/load of an unknown id rejects and leaves no session registered", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    await h.agent.start();
    await assert.rejects(
      () => h.agent.loadSession("nope", h.cwd),
      (e: unknown) => e instanceof AcpError && e.code === -32002,
    );
    assert.equal(getSession(h, "nope"), null);
    assert.ok(!h.events.some((e) => e.type === "state"));
    assert.ok(!h.events.some((e) => e.type === "update"));
    // prompting a never-loaded past session fails at the agent as well
    await assert.rejects(() => h.agent.prompt("past-2", text("hi")), AcpError);
    assert.equal(getSession(h, "past-2"), null);
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

test("_session/steer (fake agent): injected into the running turn on v3, -32602 without a turn, -32601 on v2", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    await h.agent.start();
    const session = await h.agent.newSession(h.cwd);
    // Not advertised (the real CLI did not advertise it either); the client does not gate on the list.
    await assert.rejects(
      () => h.agent.callExtension("_session/steer", { sessionId: session.sessionId, prompt: text("nothing runs") }),
      (e: unknown) => e instanceof AcpError && e.code === -32602,
    );

    const turn = h.agent.prompt(session.sessionId, text("/scenario slow"));
    await waitFor(() => chunkText(h.events).includes("slow 1 "), 5000, "the slow turn to stream");
    const steered = await h.agent.callExtension<Record<string, unknown>>("_session/steer", {
      sessionId: session.sessionId,
      prompt: text("hi there"),
    });
    assert.deepEqual(steered, {});
    await waitFor(() => chunkText(h.events).includes("Steered: hi there"), 5000, "the steered answer");
    const infos = updatesOf(h.events, "session_info_update") as Array<{ _meta?: { kiro?: { kind?: string } } }>;
    assert.ok(infos.some((u) => u._meta?.kiro?.kind === "steering_injected"), "steering_injected was reported");
    assert.ok(!h.events.some((e) => e.type === "turn_finished"), "the steered answer arrived inside the turn");
    const response = await turn;
    assert.equal(response.stopReason, "end_turn");
  } finally {
    await h.agent.stop();
  }

  const v2 = launch({ args: ["--scenario", "chat", "--engine", "v2"] });
  try {
    await v2.agent.start();
    const session = await v2.agent.newSession(v2.cwd);
    await assert.rejects(
      () => v2.agent.callExtension("_session/steer", { sessionId: session.sessionId, prompt: text("x") }),
      (e: unknown) => e instanceof AcpError && e.code === -32601,
    );
  } finally {
    await v2.agent.stop();
  }
});

// ---------------------------------------------------------------------------
// Agent link (D30): mcpServers reach the fake agent, which acts as the MCP client
// ---------------------------------------------------------------------------

interface StubRequest {
  method: string;
  authorization: string | undefined;
  protocolVersion: string | undefined;
  accept: string | undefined;
  contentType: string | undefined;
  params: unknown;
}

interface StubMcp {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

/**
 * A minimal MCP Streamable HTTP server on 127.0.0.1: `initialize`, 202 for
 * notifications, `tools/call` answering `text`. A request without
 * `Authorization: Bearer <token>` gets 403. `sse` answers `tools/call` as an
 * event stream; `hangToolsCall` never answers it.
 */
async function startStubMcp(options: { token: string; text?: string; sse?: boolean; hangToolsCall?: boolean }): Promise<StubMcp> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { id?: number; method?: string; params?: unknown };
      requests.push({
        method: message.method ?? "?",
        authorization: req.headers.authorization,
        protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
        accept: req.headers.accept,
        contentType: req.headers["content-type"],
        params: message.params,
      });
      if (req.method !== "POST" || req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden");
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result: unknown, sse = false): void => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        if (sse) res.writeHead(200, { "Content-Type": "text/event-stream" }).end(`event: message\ndata: ${payload}\n\n`);
        else res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
      };
      if (message.method === "initialize") {
        const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        reply({ protocolVersion: requested ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0.0.0" } });
      } else if (message.method === "tools/call") {
        if (options.hangToolsCall) return;
        reply({ content: [{ type: "text", text: options.text ?? "stub sessions" }] }, options.sse);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function linkEntry(url: string, token: string, name = "kiro-acp-tabs", type: "http" | "sse" = "http"): acp.McpServer {
  return { type, name, url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] };
}

/** The `tool_call` the fake agent opened for an `mcp_call` (title `<server>/<tool>`). */
function mcpToolCall(events: SessionEvent[], title = "kiro-acp-tabs/list_sessions"): acp.ToolCall & { sessionUpdate: "tool_call" } {
  const call = updatesOf(events, "tool_call").find(
    (u): u is acp.ToolCall & { sessionUpdate: "tool_call" } => u.sessionUpdate === "tool_call" && u.title === title,
  );
  assert.ok(call, `no tool_call titled ${title}`);
  return call;
}

function contentText(update: acp.ToolCallUpdate | undefined): string {
  return (update?.content ?? []).map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : "")).join("");
}

function stderrLines(h: { logger: { traces: Array<{ direction: string; payload: string }> } }): string[] {
  return h.logger.traces.filter((t) => t.direction === "stderr").map((t) => t.payload);
}

describe("agent link: mcpServers and the fake agent's mcp_call", () => {
  test("V3 advertises mcpCapabilities http and sse; --no-mcp-http drops http and session/new refuses an http server; v2 advertises none", async () => {
    const h = launch({ args: ["--scenario", "chat"] });
    try {
      const info = await h.agent.start();
      assert.deepEqual(info.agentCapabilities.mcpCapabilities, { http: true, sse: true });
    } finally {
      await h.agent.stop();
    }

    const strict = launch({ args: ["--scenario", "chat", "--no-mcp-http"] });
    try {
      const info = await strict.agent.start();
      assert.notEqual(info.agentCapabilities.mcpCapabilities?.http, true);
      assert.equal(info.agentCapabilities.mcpCapabilities?.sse, true);
      await assert.rejects(
        () => strict.agent.newSession(strict.cwd, { mcpServers: [linkEntry("http://127.0.0.1:9/mcp", "tok-strict")] }),
        (e: unknown) => e instanceof AcpError && e.code === -32602 && /kiro-acp-tabs/.test(e.message),
      );
      // The refusal is not an auth problem, and the client can retry without the server.
      assert.equal(strict.agent.status, "ready");
      const session = await strict.agent.newSession(strict.cwd);
      assert.ok(session.sessionId);
      assert.ok(!stderrLines(strict).some((l) => l.includes("tok-strict")), "header values are never logged");
    } finally {
      await strict.agent.stop();
    }

    const v2 = launch({ args: ["--scenario", "chat", "--engine", "v2"] });
    try {
      const info = await v2.agent.start();
      assert.equal(info.agentCapabilities.mcpCapabilities, undefined);
    } finally {
      await v2.agent.stop();
    }
  });

  test("session/new forwards mcpServers: /scenario agent-link calls the stub with the session's bearer token", async () => {
    const token = "tok-new-session";
    const stub = await startStubMcp({ token });
    const h = launch({ args: ["--scenario", "chat"] });
    try {
      await h.agent.start();
      const session = await h.agent.newSession(h.cwd, { mcpServers: [linkEntry(stub.url, token)] });

      const sent = h.logger.traces.find((t) => t.direction === "send" && t.payload.includes('"session/new"'));
      assert.ok(sent);
      const newRequest = JSON.parse(sent.payload) as { params: acp.NewSessionRequest };
      assert.deepEqual(newRequest.params.mcpServers, [linkEntry(stub.url, token)]);
      await waitFor(
        () => stderrLines(h).some((l) => l.includes(`session/new ${session.sessionId} mcpServers: kiro-acp-tabs (http ${stub.url})`)),
        5000,
        "the agent to log the received server",
      );

      const response = await h.agent.prompt(session.sessionId, text("/scenario agent-link"));
      assert.equal(response.stopReason, "end_turn");
      const transcript = chunkText(h.events);
      assert.ok(!transcript.includes("[fake-agent]"), `fake agent reported a problem: ${transcript}`);
      assert.equal(transcript, "Let me list the other sessions. Sessions: stub sessions");

      const call = mcpToolCall(h.events);
      assert.equal(call.kind, "other");
      assert.equal(call.status, "in_progress");
      assert.deepEqual(call.rawInput, {});
      const updates = toolUpdates(h.events, call.toolCallId);
      const last = updates[updates.length - 1];
      assert.equal(last?.status, "completed");
      assert.equal(contentText(last), "stub sessions");
      assert.deepEqual(last?.rawOutput, { content: [{ type: "text", text: "stub sessions" }] });

      // initialize → notifications/initialized → tools/call, every one with the session's token.
      assert.deepEqual(
        stub.requests.map((r) => r.method),
        ["initialize", "notifications/initialized", "tools/call"],
      );
      for (const request of stub.requests) {
        assert.equal(request.authorization, `Bearer ${token}`);
        assert.equal(request.contentType, "application/json");
        assert.match(request.accept ?? "", /application\/json/);
        assert.match(request.accept ?? "", /text\/event-stream/);
      }
      const init = stub.requests[0]!.params as { protocolVersion: string; clientInfo: { name: string } };
      assert.equal(init.protocolVersion, "2025-06-18");
      assert.equal(init.clientInfo.name, "fake-kiro");
      assert.equal(stub.requests[2]!.protocolVersion, "2025-06-18");
      assert.deepEqual(stub.requests[2]!.params, { name: "list_sessions", arguments: {} });
      assert.ok(!stderrLines(h).some((l) => l.includes(token)), "header values are never logged");
    } finally {
      await h.agent.stop();
      await stub.close();
    }
  });

  test("session/load forwards mcpServers; an event-stream answer is read too", async () => {
    const token = "tok-loaded-session";
    const stub = await startStubMcp({ token, text: "stub sessions over sse", sse: true });
    const h = launch({ args: ["--scenario", "chat"] });
    try {
      await h.agent.start();
      await h.agent.loadSession("past-1", h.cwd, { mcpServers: [linkEntry(stub.url, token)] });
      const sent = h.logger.traces.find((t) => t.direction === "send" && t.payload.includes('"session/load"'));
      assert.ok(sent);
      assert.deepEqual((JSON.parse(sent.payload) as { params: acp.LoadSessionRequest }).params.mcpServers, [linkEntry(stub.url, token)]);
      await waitFor(
        () => stderrLines(h).some((l) => l.includes(`session/load past-1 mcpServers: kiro-acp-tabs (http ${stub.url})`)),
        5000,
        "the agent to log the loaded server",
      );

      const before = h.events.length;
      const response = await h.agent.prompt("past-1", text("/scenario agent-link"));
      assert.equal(response.stopReason, "end_turn");
      const turn = h.events.slice(before);
      assert.equal(chunkText(turn), "Let me list the other sessions. Sessions: stub sessions over sse");
      const call = mcpToolCall(turn);
      assert.equal(toolUpdates(turn, call.toolCallId).at(-1)?.status, "completed");
      assert.ok(stub.requests.length === 3 && stub.requests.every((r) => r.authorization === `Bearer ${token}`));
    } finally {
      await h.agent.stop();
      await stub.close();
    }
  });

  test("a 403 from the server fails the tool call and the fake agent reports it", async () => {
    const stub = await startStubMcp({ token: "tok-live" });
    const h = launch({ args: ["--scenario", "chat"] });
    try {
      await h.agent.start();
      const session = await h.agent.newSession(h.cwd, { mcpServers: [linkEntry(stub.url, "tok-revoked")] });
      const response = await h.agent.prompt(session.sessionId, text("/scenario agent-link"));
      assert.equal(response.stopReason, "end_turn");

      const call = mcpToolCall(h.events);
      const last = toolUpdates(h.events, call.toolCallId).at(-1);
      assert.equal(last?.status, "failed");
      assert.equal(contentText(last), "HTTP 403 at initialize: forbidden");
      assert.deepEqual(last?.rawOutput, { error: { message: "forbidden", status: 403 } });
      const transcript = chunkText(h.events);
      assert.ok(
        transcript.includes("[fake-agent] mcp_call kiro-acp-tabs/list_sessions failed: HTTP 403 at initialize: forbidden"),
        transcript,
      );
      // The error text is what later steps see.
      assert.ok(transcript.endsWith("Sessions: HTTP 403 at initialize: forbidden"), transcript);
      assert.deepEqual(
        stub.requests.map((r) => r.method),
        ["initialize"],
      );
    } finally {
      await h.agent.stop();
      await stub.close();
    }
  });

  test("a server name the session was not given is reported and nothing is called", async () => {
    const token = "tok-elsewhere";
    const stub = await startStubMcp({ token });
    const h = launch({ args: ["--scenario", "chat"] });
    try {
      await h.agent.start();
      // An sse entry with the right name and an http entry with another name: neither matches.
      const session = await h.agent.newSession(h.cwd, {
        mcpServers: [linkEntry(stub.url, token, "kiro-acp-tabs", "sse"), linkEntry(stub.url, token, "other-server")],
      });
      const response = await h.agent.prompt(session.sessionId, text("/scenario agent-link"));
      assert.equal(response.stopReason, "end_turn");
      const transcript = chunkText(h.events);
      assert.ok(
        transcript.includes("[fake-agent] mcp_call kiro-acp-tabs/list_sessions: no http MCP server named 'kiro-acp-tabs' in this session"),
        transcript,
      );
      assert.equal(updatesOf(h.events, "tool_call").length, 0);
      assert.equal(stub.requests.length, 0);

      // A session without any servers reports the same.
      const bare = await h.agent.newSession(h.cwd);
      const before = h.events.length;
      await h.agent.prompt(bare.sessionId, text("/scenario agent-link"));
      assert.match(chunkText(h.events.slice(before)), /\[fake-agent\] mcp_call kiro-acp-tabs\/list_sessions: no http MCP server named 'kiro-acp-tabs' in this session \(servers: none\)/);
    } finally {
      await h.agent.stop();
      await stub.close();
    }
  });

  test("the selector line gives args and rest; a framed peer message runs the scenario named in its body", async () => {
    const token = "tok-args";
    const stub = await startStubMcp({ token, text: "Delivered" });
    const h = launch({ args: ["--scenario", "chat"] });
    try {
      await h.agent.start();
      const session = await h.agent.newSession(h.cwd, { mcpServers: [linkEntry(stub.url, token)] });
      const toolCalls = (): unknown[] => stub.requests.filter((r) => r.method === "tools/call").map((r) => r.params);

      // `arg1` is the first word after the scenario name, `rest` everything after the selector line.
      let before = h.events.length;
      await h.agent.prompt(session.sessionId, text("/scenario link-send S2\n/scenario peer-echo\nHello **there**"));
      assert.deepEqual(toolCalls().at(-1), {
        name: "send_message",
        arguments: { to: "S2", text: "/scenario peer-echo\nHello **there**" },
      });
      assert.equal(chunkText(h.events.slice(before)), "send_message completed: Delivered");

      // A numeric word is a number; a missing one is null (a whole-string placeholder drops out).
      await h.agent.prompt(session.sessionId, text("/scenario link-read s3 5"));
      assert.deepEqual(toolCalls().at(-1), { name: "read_session", arguments: { session: "s3", last: 5 } });
      await h.agent.prompt(session.sessionId, text("/scenario link-read s3"));
      assert.deepEqual(toolCalls().at(-1), { name: "read_session", arguments: { session: "s3", last: null } });

      // A framed message names its scenario anywhere in its body; the agent sees the whole frame.
      const framed = framePeerMessage({ handle: "s7", title: "Sender", tab: "Kiro Chat 1" }, "Please look.\n/scenario peer-echo\nThanks", 3);
      before = h.events.length;
      await h.agent.prompt(session.sessionId, text(framed));
      assert.equal(chunkText(h.events.slice(before)), `Received from s7 (depth 3):\n${framed}`);

      // The peer's handle answers back; a plain prompt with the selector further down runs the launch scenario.
      const reply = framePeerMessage({ handle: "s9", title: "Asker", tab: "Sidebar" }, "/scenario peer-reply", 1);
      await h.agent.prompt(session.sessionId, text(reply));
      assert.deepEqual(toolCalls().at(-1), {
        name: "send_message",
        arguments: { to: "s9", text: "/scenario peer-echo\nReply to s9" },
      });
      before = h.events.length;
      await h.agent.prompt(session.sessionId, text("hello\n/scenario peer-echo"));
      assert.equal(chunkText(h.events.slice(before)), "The answer is 42.");
    } finally {
      await h.agent.stop();
      await stub.close();
    }
  });

  test("session/cancel aborts a pending mcp_call", async () => {
    const token = "tok-hang";
    const stub = await startStubMcp({ token, hangToolsCall: true });
    const h = launch({ args: ["--scenario", "chat"] });
    try {
      await h.agent.start();
      const session = await h.agent.newSession(h.cwd, { mcpServers: [linkEntry(stub.url, token)] });
      const pending = h.agent.prompt(session.sessionId, text("/scenario agent-link"));
      await waitFor(() => stub.requests.some((r) => r.method === "tools/call"), 5000, "the tools/call request");
      await h.agent.cancel(session.sessionId);
      const response = await pending;
      assert.equal(response.stopReason, "cancelled");
      const call = mcpToolCall(h.events);
      const last = toolUpdates(h.events, call.toolCallId).at(-1);
      assert.equal(last?.status, "failed");
      assert.equal((last?._meta as { kiro: { failureReason: string } }).kiro.failureReason, "cancelled");
      assert.ok(!chunkText(h.events).includes("[fake-agent]"), "a cancelled call is not reported");
    } finally {
      await h.agent.stop();
      await stub.close();
    }
  });
});

test("signed out like kiro-cli 3.2.1 (shared sign-in state): initialize offers its terminal login and no session/load; requireSignIn switches to auth_required", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-auth-"));
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ signedIn: false }));
  const previous = process.env.KIRO_FAKE_AUTH_FILE;
  process.env.KIRO_FAKE_AUTH_FILE = file;
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    const info = await h.agent.start();
    assert.equal(info.agentCapabilities.loadSession, false);
    assert.deepEqual(
      info.authMethods.map((m) => m.id),
      ["kiro-login-terminal"],
    );
    assert.equal(h.agent.status, "ready", "initialize alone does not say signed out");

    h.agent.requireSignIn("Kiro is not signed in.");
    assert.equal(h.agent.status, "auth_required");
    const change = h.changes[h.changes.length - 1];
    assert.equal(change?.status, "auth_required");
    assert.equal(change?.message, "Kiro is not signed in.");
    assert.deepEqual(
      h.agent.agent?.authMethods.map((m) => m.id),
      ["kiro-login-terminal"],
      "the agent's terminal method is the one offered",
    );
    const count = h.changes.length;
    h.agent.requireSignIn("again");
    assert.equal(h.changes.length, count, "no second change while already asking for a sign-in");
  } finally {
    await h.agent.stop();
    if (previous === undefined) delete process.env.KIRO_FAKE_AUTH_FILE;
    else process.env.KIRO_FAKE_AUTH_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requireSignIn leaves a signed-in agent that is not ready alone, and a ready one asks for the sign-in", async () => {
  const h = launch({ args: ["--scenario", "chat"] });
  try {
    h.agent.requireSignIn("not started");
    assert.equal(h.agent.status, "stopped", "nothing to switch before start()");
    await h.agent.start();
    h.agent.requireSignIn("signed out");
    assert.equal(h.agent.status, "auth_required");
  } finally {
    await h.agent.stop();
  }
});
