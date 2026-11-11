/**
 * Shared helpers for the ACP tests: fake-agent launcher, ClientServices mock,
 * event collectors and polling helpers. Not a test file itself.
 */
import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  createKiroAgent,
  type ClientServices,
  type ConnectionStateChange,
  type KiroAgent,
  type ProtocolLogger,
  type SessionEvent,
} from "../src/acp/index.js";

/** out/test → repo root → test/fake-agent/agent.mjs */
export const FAKE_AGENT = path.resolve(__dirname, "../../test/fake-agent/agent.mjs");

export interface RecordedCall {
  method: string;
  params: unknown;
}

export type PermissionDecider = (
  request: acp.RequestPermissionRequest,
  signal: AbortSignal,
) => Promise<acp.RequestPermissionResponse>;

export interface MockServices extends ClientServices {
  calls: RecordedCall[];
  /** Replace to control permission answers; default picks the first allow_* option. */
  decidePermission: PermissionDecider;
  openedUrls: string[];
  terminalAuthRuns: Array<{ method: acp.AuthMethod; command: string; args: string[] }>;
}

export function allowFirst(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  const option = request.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
  if (!option) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

export function rejectFirst(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  const option = request.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
  if (!option) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

export function makeServices(): MockServices {
  const calls: RecordedCall[] = [];
  const services: MockServices = {
    calls,
    openedUrls: [],
    terminalAuthRuns: [],
    decidePermission: async (request) => allowFirst(request),
    async requestPermission(request, signal) {
      calls.push({ method: "session/request_permission", params: request });
      return services.decidePermission(request, signal);
    },
    async readTextFile(request) {
      calls.push({ method: "fs/read_text_file", params: request });
      return { content: `fake contents of ${request.path}` };
    },
    async writeTextFile(request) {
      calls.push({ method: "fs/write_text_file", params: request });
      return {};
    },
    async createTerminal(request) {
      calls.push({ method: "terminal/create", params: request });
      return { terminalId: "term-1" };
    },
    async terminalOutput(request) {
      calls.push({ method: "terminal/output", params: request });
      return { output: "hello\n", truncated: false, exitStatus: { exitCode: 0, signal: null } };
    },
    async waitForTerminalExit(request) {
      calls.push({ method: "terminal/wait_for_exit", params: request });
      return { exitCode: 0, signal: null };
    },
    async killTerminal(request) {
      calls.push({ method: "terminal/kill", params: request });
      return {};
    },
    async releaseTerminal(request) {
      calls.push({ method: "terminal/release", params: request });
      return {};
    },
    async openExternalUrl(url) {
      calls.push({ method: "_kiro/openExternalUrl", params: { url } });
      services.openedUrls.push(url);
    },
    async runTerminalAuth(method, invocation) {
      services.terminalAuthRuns.push({ method, command: invocation.command, args: [...invocation.args] });
    },
  };
  return services;
}

export interface TestLogger extends ProtocolLogger {
  lines: Array<{ level: "info" | "warn" | "error"; message: string }>;
  traces: Array<{ direction: "send" | "recv" | "stderr"; payload: string }>;
}

export function makeLogger(withTrace = true): TestLogger {
  const logger: TestLogger = {
    lines: [],
    traces: [],
    info: (message) => logger.lines.push({ level: "info", message }),
    warn: (message) => logger.lines.push({ level: "warn", message }),
    error: (message) => logger.lines.push({ level: "error", message }),
  };
  if (withTrace) {
    logger.trace = (direction, payload) => logger.traces.push({ direction, payload });
  }
  return logger;
}

export interface Harness {
  agent: KiroAgent;
  services: MockServices;
  logger: TestLogger;
  events: SessionEvent[];
  changes: ConnectionStateChange[];
  cwd: string;
}

export function launch(options: {
  args?: string[];
  services?: MockServices;
  trace?: boolean;
  cwd?: string;
  command?: string;
} = {}): Harness {
  const services = options.services ?? makeServices();
  const logger = makeLogger(options.trace ?? true);
  const cwd = options.cwd ?? process.cwd();
  const agent = createKiroAgent(
    {
      command: options.command ?? process.execPath,
      args: [FAKE_AGENT, "acp", ...(options.args ?? [])],
      cwd,
      env: process.env,
      logger,
      clientVersion: "0.1.0-test",
    },
    services,
  );
  const events: SessionEvent[] = [];
  const changes: ConnectionStateChange[] = [];
  agent.onSessionEvent((event) => events.push(event));
  agent.onConnectionChange((change) => changes.push(change));
  return { agent, services, logger, events, changes, cwd };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function updatesOf(events: SessionEvent[], sessionUpdate?: string): acp.SessionUpdate[] {
  return events
    .filter((e): e is Extract<SessionEvent, { type: "update" }> => e.type === "update")
    .map((e) => e.update)
    .filter((u) => sessionUpdate === undefined || u.sessionUpdate === sessionUpdate);
}

export function chunkText(events: SessionEvent[], kind = "agent_message_chunk"): string {
  return updatesOf(events, kind)
    .map((u) => {
      if (u.sessionUpdate !== "agent_message_chunk" && u.sessionUpdate !== "agent_thought_chunk" && u.sessionUpdate !== "user_message_chunk") {
        return "";
      }
      return u.content.type === "text" ? u.content.text : "";
    })
    .join("");
}

export function toolUpdates(events: SessionEvent[], toolCallId: string): acp.ToolCallUpdate[] {
  return updatesOf(events, "tool_call_update")
    .filter((u): u is acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" } => u.sessionUpdate === "tool_call_update")
    .filter((u) => u.toolCallId === toolCallId);
}
