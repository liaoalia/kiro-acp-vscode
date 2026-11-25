/**
 * AgentPool (D31 (process per session)) against real fake-agent processes:
 * one process per session, the pre-warmed spare, sharing past
 * `maxProcesses`, routing, `process_exited`, release and stop.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type * as acp from "@agentclientprotocol/sdk";
import {
  AcpError,
  AgentPool,
  AUTH_REQUIRED_CODE,
  createAgentPool,
  FALLBACK_LOGIN_METHOD,
  KiroAgentImpl,
  type ConnectionStateChange,
  type PooledAgent,
  type SessionEvent,
} from "../src/acp/index.js";
import { FAKE_AGENT, makeLogger, makeServices, waitFor, type MockServices, type TestLogger } from "./harness.js";

const text = (value: string): acp.ContentBlock[] => [{ type: "text", text: value }];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every process agent any test made: stopped in `after`, so no fake agent outlives the run. */
const made: KiroAgentImpl[] = [];
after(async () => {
  await Promise.all(made.map((agent) => agent.stop()));
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Methods whose target process the tests check. */
const ROUTED = new Set([
  "newSession",
  "loadSession",
  "listSessions",
  "prompt",
  "cancel",
  "setMode",
  "setConfigOption",
  "setModel",
  "authenticate",
  "callExtension",
]);

interface RoutedCall {
  process: number;
  method: string;
}

/** The real agent, recording which pool process each routed call reached. */
function recordCalls(agent: KiroAgentImpl, processId: number, calls: RoutedCall[]): PooledAgent {
  return new Proxy(agent, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof property === "string" && ROUTED.has(property)) {
        return (...args: unknown[]) => {
          calls.push({ process: processId, method: property });
          return method.apply(target, args);
        };
      }
      return method.bind(target);
    },
  });
}

interface PoolHarness {
  pool: AgentPool;
  agents: KiroAgentImpl[];
  calls: RoutedCall[];
  services: MockServices;
  logger: TestLogger;
  events: SessionEvent[];
  changes: ConnectionStateChange[];
  cwd: string;
}

function launchPool(
  options: {
    args?: string[];
    maxProcesses?: number;
    command?: string;
    /** Wrap pool process N's agent (e.g. to slow one call down). */
    wrap?: (processId: number, agent: PooledAgent) => PooledAgent;
  } = {},
): PoolHarness {
  const services = makeServices();
  const logger = makeLogger(false);
  const cwd = process.cwd();
  const agents: KiroAgentImpl[] = [];
  const calls: RoutedCall[] = [];
  const pool = new AgentPool(
    (processId) => {
      const agent = new KiroAgentImpl(
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
      made.push(agent);
      agents.push(agent);
      const recorded = recordCalls(agent, processId, calls);
      return options.wrap ? options.wrap(processId, recorded) : recorded;
    },
    { maxProcesses: options.maxProcesses ?? 8, logger },
  );
  const events: SessionEvent[] = [];
  const changes: ConnectionStateChange[] = [];
  pool.onSessionEvent((event) => events.push(event));
  pool.onConnectionChange((change) => changes.push(change));
  return { pool, agents, calls, services, logger, events, changes, cwd };
}

function hostOf(pool: AgentPool, sessionId: string) {
  const host = pool.processes().find((p) => p.sessionIds.includes(sessionId));
  assert.ok(host, `no process hosts ${sessionId}`);
  return host;
}

async function readySpare(pool: AgentPool) {
  await waitFor(() => pool.processes().some((p) => p.spare && p.status === "ready"), 10_000, "a ready spare");
  const spare = pool.processes().find((p) => p.spare);
  assert.ok(spare);
  return spare;
}

function exits(events: SessionEvent[]): Array<Extract<SessionEvent, { type: "process_exited" }>> {
  return events.filter((e): e is Extract<SessionEvent, { type: "process_exited" }> => e.type === "process_exited");
}

const isUnknownSession = (error: unknown): boolean => error instanceof AcpError && /unknown session/.test(error.message);

test("createAgentPool: start() pre-warms a spare, a new session takes it and the next spare starts; stop() ends every process, idempotently", async () => {
  const services = makeServices();
  const logger = makeLogger(false);
  const cwd = process.cwd();
  const pool = createAgentPool(
    {
      command: process.execPath,
      args: [FAKE_AGENT, "acp", "--scenario", "chat"],
      cwd,
      env: process.env,
      logger,
      clientVersion: "0.1.0-test",
    },
    services,
    { maxProcesses: 4 },
  );
  const changes: ConnectionStateChange[] = [];
  const events: SessionEvent[] = [];
  pool.onConnectionChange((change) => changes.push(change));
  pool.onSessionEvent((event) => events.push(event));
  const pids = new Set<number>();
  const snapshot = () => {
    const list = pool.processes();
    for (const p of list) if (p.pid !== null) pids.add(p.pid);
    return list;
  };
  let sessionId = "";
  try {
    assert.equal(pool.status, "stopped");
    assert.equal(pool.maxProcesses, 4);
    await assert.rejects(() => pool.newSession(cwd), (e: unknown) => e instanceof AcpError && /not running/.test(e.message));

    const info = await pool.start();
    assert.equal(info.agentInfo?.name, "fake-kiro");
    assert.equal(pool.status, "ready");
    assert.equal(pool.agent, info);
    assert.deepEqual(changes.map((c) => c.status), ["starting", "ready"]);
    assert.equal(changes[1]?.agent, info);
    const [spare] = snapshot();
    assert.equal(snapshot().length, 1);
    assert.ok(spare?.spare && spare.status === "ready" && typeof spare.pid === "number");
    assert.equal(await pool.start(), info); // idempotent while running

    const session = await pool.newSession(cwd);
    sessionId = session.sessionId;
    assert.deepEqual(hostOf(pool, sessionId), { ...spare, spare: false, sessionIds: [sessionId] });
    const next = await readySpare(pool);
    assert.notEqual(next.pid, spare.pid);
    assert.equal(snapshot().length, 2);

    const response = await pool.prompt(sessionId, text("hello"));
    assert.equal(response.stopReason, "end_turn");
    assert.ok(events.some((e) => e.type === "update" && e.sessionId === sessionId && !e.replay));

    const messages = logger.lines.map((l) => l.message);
    assert.ok(messages.some((m) => /^agent-pool: process 1 started \(pid \d+\) as the spare$/.test(m)), messages.join("\n"));
    assert.ok(messages.includes(`agent-pool: session ${sessionId} -> process 1`));
    assert.ok(messages.some((m) => /^agent-pool: process 2 started \(pid \d+\) as the spare$/.test(m)));
    // Each process logs under its number (createAgentPool's per-process logger).
    assert.ok(messages.some((m) => m.startsWith("process 1: Agent ready: fake-kiro")));
    assert.ok(messages.some((m) => m.startsWith("process 2: Agent ready: fake-kiro")));
  } finally {
    await pool.stop();
  }
  assert.equal(pool.status, "stopped");
  assert.equal(changes.at(-1)?.status, "stopped");
  assert.deepEqual(pool.processes(), []);
  assert.equal(pids.size, 2);
  for (const pid of pids) assert.equal(isAlive(pid), false, `pid ${pid} still runs`);
  assert.ok(logger.lines.some((l) => l.message === "agent-pool: process 1 stopped (pool stopped)"));
  assert.ok(logger.lines.some((l) => l.message === "agent-pool: process 2 stopped (pool stopped)"));
  assert.deepEqual(exits(events), [], "processes the pool stops are not reported as exits");

  const count = changes.length;
  await pool.stop(); // idempotent
  assert.equal(changes.length, count);
  await assert.rejects(() => pool.newSession(cwd), AcpError);
  await assert.rejects(() => pool.prompt(sessionId, text("again")), isUnknownSession);
});

/**
 * Two sessions prompted at once with `--serial-turns` (one turn at a time per
 * process, like the real CLI). Returns the order in which each session
 * streamed its first chunk and finished.
 */
async function promptTwoAtOnce(maxProcesses: number) {
  const h = launchPool({ args: ["--scenario", "slow", "--serial-turns"], maxProcesses });
  try {
    await h.pool.start();
    const [a, b] = await Promise.all([h.pool.newSession(h.cwd), h.pool.newSession(h.cwd)]);
    const order: string[] = [];
    const streaming = new Set<string>();
    h.pool.onSessionEvent((event) => {
      const id = "sessionId" in event ? (event.sessionId === a.sessionId ? "a" : "b") : "?";
      if (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && !streaming.has(id)) {
        streaming.add(id);
        order.push(`${id} streams`);
      }
      if (event.type === "turn_finished") order.push(`${id} ends`);
    });
    const responses = await Promise.all([h.pool.prompt(a.sessionId, text("a")), h.pool.prompt(b.sessionId, text("b"))]);
    assert.deepEqual(responses.map((r) => r.stopReason), ["end_turn", "end_turn"]);
    return { order, hostA: hostOf(h.pool, a.sessionId), hostB: hostOf(h.pool, b.sessionId), a: a.sessionId, b: b.sessionId };
  } finally {
    await h.pool.stop();
  }
}

test("two sessions get two processes and stream at the same time; one shared process (maxProcesses = 1) runs their turns one after the other", async () => {
  const pooled = await promptTwoAtOnce(8);
  assert.notEqual(pooled.hostA.id, pooled.hostB.id);
  assert.notEqual(pooled.hostA.pid, pooled.hostB.pid);
  // The fake agent's session ids end in a per-process suffix: different OS processes made them.
  const suffix = (id: string): string => id.split("-").slice(2).join("-");
  assert.notEqual(suffix(pooled.a), suffix(pooled.b));
  assert.deepEqual(pooled.order.slice(0, 2).sort(), ["a streams", "b streams"], pooled.order.join(", "));

  const shared = await promptTwoAtOnce(1);
  assert.equal(shared.hostA.id, shared.hostB.id);
  assert.equal(suffix(shared.a), suffix(shared.b));
  assert.match(shared.order.join(", "), /^(a streams, a ends, b streams, b ends|b streams, b ends, a streams, a ends)$/);
});

test("past maxProcesses new sessions share the process with the fewest sessions, and their calls still reach it", async () => {
  const h = launchPool({ args: ["--scenario", "chat"], maxProcesses: 2 });
  try {
    await h.pool.start();
    const s1 = (await h.pool.newSession(h.cwd)).sessionId;
    await readySpare(h.pool);
    const s2 = (await h.pool.newSession(h.cwd)).sessionId;
    const s3 = (await h.pool.newSession(h.cwd)).sessionId;
    const s4 = (await h.pool.newSession(h.cwd)).sessionId;
    await delay(200); // a (wrong) third process would be starting by now
    const list = h.pool.processes();
    assert.deepEqual(
      list.map((p) => ({ id: p.id, spare: p.spare, sessionIds: p.sessionIds })),
      [
        { id: 1, spare: false, sessionIds: [s1, s3] },
        { id: 2, spare: false, sessionIds: [s2, s4] },
      ],
    );
    const messages = h.logger.lines.map((l) => l.message);
    assert.ok(messages.includes(`agent-pool: session ${s2} -> process 2`));
    assert.ok(messages.includes(`agent-pool: session ${s3} -> process 1 (shared: 2 process limit reached)`));
    assert.ok(messages.includes(`agent-pool: session ${s4} -> process 2 (shared: 2 process limit reached)`));

    h.calls.length = 0;
    for (const sessionId of [s3, s4]) {
      assert.equal((await h.pool.prompt(sessionId, text("hi"))).stopReason, "end_turn");
    }
    assert.deepEqual(h.calls, [
      { process: 1, method: "prompt" },
      { process: 2, method: "prompt" },
    ]);
  } finally {
    await h.pool.stop();
  }
});

test("maxProcesses = 1: one process hosts every session, no spare, and survives releasing them all", async () => {
  const h = launchPool({ args: ["--scenario", "chat"], maxProcesses: 1 });
  try {
    await h.pool.start();
    const pid = h.pool.processes()[0]?.pid;
    assert.ok(typeof pid === "number");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await h.pool.newSession(h.cwd)).sessionId);
    await delay(200);
    let list = h.pool.processes();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.pid, pid);
    assert.equal(list[0]?.spare, false);
    assert.deepEqual(list[0]?.sessionIds, ids);
    for (const id of ids) assert.equal((await h.pool.prompt(id, text("hi"))).stopReason, "end_turn");
    assert.ok(h.calls.every((c) => c.process === 1));
    assert.equal(h.agents.length, 1);

    // Closing every session keeps the one process (it is the spare again), as before D31.
    for (const id of ids) h.pool.releaseSession(id);
    list = h.pool.processes();
    assert.deepEqual(list.map((p) => ({ pid: p.pid, spare: p.spare, sessionIds: p.sessionIds })), [{ pid, spare: true, sessionIds: [] }]);
    const again = await h.pool.newSession(h.cwd);
    assert.equal(hostOf(h.pool, again.sessionId).pid, pid);
    assert.equal(h.agents.length, 1);
    assert.equal(h.pool.status, "ready");
  } finally {
    await h.pool.stop();
  }
});

test("releaseSession stops a process left without sessions; the other session and the spare stay", async () => {
  const h = launchPool({ args: ["--scenario", "chat"] });
  try {
    await h.pool.start();
    const s1 = (await h.pool.newSession(h.cwd)).sessionId;
    const s2 = (await h.pool.newSession(h.cwd)).sessionId;
    const spare = await readySpare(h.pool);
    const released = hostOf(h.pool, s1);
    assert.ok(typeof released.pid === "number");

    h.pool.releaseSession(s1);
    assert.ok(!h.pool.processes().some((p) => p.id === released.id));
    await waitFor(() => !isAlive(released.pid!), 10_000, "the released process to exit");
    await waitFor(
      () => h.logger.lines.some((l) => l.message === `agent-pool: process ${released.id} stopped (released)`),
      10_000,
      "the stop log line",
    );
    await assert.rejects(() => h.pool.prompt(s1, text("gone")), isUnknownSession);
    h.pool.releaseSession(s1); // no-ops
    h.pool.releaseSession("never-bound");

    assert.equal(h.pool.processes().find((p) => p.spare)?.id, spare.id);
    assert.equal((await h.pool.prompt(s2, text("still here"))).stopReason, "end_turn");
    assert.equal(h.pool.status, "ready");
    assert.deepEqual(exits(h.events), []);
  } finally {
    await h.pool.stop();
  }
});

test("a killed session process ends exactly its sessions (process_exited); the others keep working and the pool stays ready", async () => {
  const h = launchPool({ args: ["--scenario", "chat"], maxProcesses: 2 });
  try {
    await h.pool.start();
    const s1 = (await h.pool.newSession(h.cwd)).sessionId;
    const s2 = (await h.pool.newSession(h.cwd)).sessionId;
    const s3 = (await h.pool.newSession(h.cwd)).sessionId; // shares s1's process (limit 2)
    const victim = hostOf(h.pool, s1);
    assert.deepEqual(victim.sessionIds, [s1, s3]);
    assert.ok(typeof victim.pid === "number");
    const changeCount = h.changes.length;

    process.kill(victim.pid);
    await waitFor(() => exits(h.events).length > 0, 10_000, "process_exited");
    const [exited, ...more] = exits(h.events);
    assert.deepEqual(more, []);
    assert.deepEqual([...exited!.sessionIds].sort(), [s1, s3].sort());
    assert.match(exited!.message, /exited/);
    assert.ok(h.logger.lines.some((l) => l.level === "warn" && l.message.startsWith(`agent-pool: process ${victim.id} exited`)));

    assert.equal(h.pool.status, "ready");
    assert.equal(h.changes.length, changeCount, "no pool-level connection change");
    await assert.rejects(() => h.pool.prompt(s1, text("gone")), isUnknownSession);
    await assert.rejects(() => h.pool.prompt(s3, text("gone")), isUnknownSession);
    assert.equal((await h.pool.prompt(s2, text("still there?"))).stopReason, "end_turn");

    // The freed slot gets a new spare, and the next session takes it.
    const spare = await readySpare(h.pool);
    const s4 = (await h.pool.newSession(h.cwd)).sessionId;
    assert.equal(hostOf(h.pool, s4).id, spare.id);
    assert.equal((await h.pool.prompt(s4, text("hi"))).stopReason, "end_turn");
  } finally {
    await h.pool.stop();
  }
});

test("routing: listSessions and session-less extension calls go to the spare, session calls to the session's process, unknown sessions are refused", async () => {
  const h = launchPool({ args: ["--scenario", "chat"] });
  try {
    await h.pool.start();
    const s1 = (await h.pool.newSession(h.cwd)).sessionId;
    const spare = await readySpare(h.pool);
    const host = hostOf(h.pool, s1);
    h.calls.length = 0;

    // The spare hosts no live session: it lists the canned past sessions only.
    const listed = await h.pool.listSessions();
    assert.deepEqual(listed.sessions.map((s) => s.sessionId), ["past-1", "past-2"]);
    const usage = await h.pool.callExtension<{ ok: boolean }>("_kiro/account/getUsage", {});
    assert.equal(usage.ok, true);
    // Only the session's own process knows it (counts the calls per session).
    const context = await h.pool.callExtension<{ calls: number }>("_kiro/session/context", { sessionId: s1 });
    assert.equal(context.calls, 1);
    await h.pool.setMode(s1, "plan");
    const options = await h.pool.setConfigOption(s1, "model", "claude-opus-4");
    assert.ok(options.some((o) => o.id === "model" && o.currentValue === "claude-opus-4"));
    await h.pool.cancel(s1);
    assert.deepEqual(h.calls, [
      { process: spare.id, method: "listSessions" },
      { process: spare.id, method: "callExtension" },
      { process: host.id, method: "callExtension" },
      { process: host.id, method: "setMode" },
      { process: host.id, method: "setConfigOption" },
      { process: host.id, method: "cancel" },
    ]);

    h.calls.length = 0;
    await assert.rejects(() => h.pool.prompt("nope", text("x")), isUnknownSession);
    await assert.rejects(() => h.pool.cancel("nope"), isUnknownSession);
    await assert.rejects(() => h.pool.setMode("nope", "plan"), isUnknownSession);
    await assert.rejects(() => h.pool.setConfigOption("nope", "model", "claude-opus-4"), isUnknownSession);
    await assert.rejects(() => h.pool.setModel("nope", "claude-opus-4"), isUnknownSession);
    await assert.rejects(() => h.pool.callExtension("_kiro/session/context", { sessionId: "nope" }), isUnknownSession);
    assert.deepEqual(h.calls, []);
  } finally {
    await h.pool.stop();
  }
});

test("session/list pages follow their cursor to the process that issued it, even after the spare changed", async () => {
  const h = launchPool({ args: ["--scenario", "chat", "--list-page-size", "1"] });
  try {
    await h.pool.start();
    const issuer = await readySpare(h.pool);
    const first = await h.pool.listSessions();
    assert.deepEqual(first.sessions.map((s) => s.sessionId), ["past-1"]);
    assert.ok(first.nextCursor, "a second page");

    // A new session takes the spare (the issuer); a new spare starts.
    const s1 = (await h.pool.newSession(h.cwd)).sessionId;
    assert.equal(hostOf(h.pool, s1).id, issuer.id);
    const spare = await readySpare(h.pool);
    assert.notEqual(spare.id, issuer.id);

    h.calls.length = 0;
    const second = await h.pool.listSessions({ cursor: first.nextCursor });
    assert.ok(second.sessions.length > 0, "the issuer served the next page");
    assert.deepEqual(h.calls, [{ process: issuer.id, method: "listSessions" }]);
    // A listing from the start goes to the spare again.
    await h.pool.listSessions();
    assert.deepEqual(h.calls.at(-1), { process: spare.id, method: "listSessions" });
  } finally {
    await h.pool.stop();
  }
});

test("session/list: two listings holding the same cursor both get their next page", async () => {
  const h = launchPool({ args: ["--scenario", "chat", "--list-page-size", "1"] });
  try {
    await h.pool.start();
    const [a, b] = await Promise.all([h.pool.listSessions(), h.pool.listSessions()]);
    assert.ok(a.nextCursor && a.nextCursor === b.nextCursor, "the same cursor");
    const nextA = await h.pool.listSessions({ cursor: a.nextCursor });
    const nextB = await h.pool.listSessions({ cursor: b.nextCursor! });
    assert.deepEqual(nextA.sessions.map((s) => s.sessionId), ["past-2"]);
    assert.deepEqual(nextB.sessions.map((s) => s.sessionId), ["past-2"]);
  } finally {
    await h.pool.stop();
  }
});

test("loadSession: an older load of an id that lands after a newer one does not take the session back", async () => {
  // Process 1 (the spare) answers session/load late; process 2 (spawned for
  // the second load of the same id) answers first.
  const h = launchPool({
    args: ["--scenario", "chat"],
    wrap: (processId, agent) =>
      processId !== 1
        ? agent
        : new Proxy(agent, {
            get(target, property) {
              const value: unknown = Reflect.get(target, property, target);
              if (property !== "loadSession" || typeof value !== "function") return value;
              return async (...args: unknown[]) => {
                await delay(1500);
                return (value as (...a: unknown[]) => unknown).apply(target, args);
              };
            },
          }),
  });
  try {
    await h.pool.start();
    const older = h.pool.loadSession("past-1", h.cwd);
    await delay(50);
    const newer = await h.pool.loadSession("past-1", h.cwd);
    assert.equal(newer.sessionId, "past-1");
    const newerHost = hostOf(h.pool, "past-1");
    assert.notEqual(newerHost.id, 1, "the newer load ran in process 2");
    await older;
    assert.equal(hostOf(h.pool, "past-1").id, newerHost.id, "still bound to the newer load's process");
    assert.ok(
      h.pool.processes().every((p) => p.id !== 1 || !p.sessionIds.includes("past-1")),
      "the older load's process does not host it",
    );
    // The session still prompts in its process.
    h.calls.length = 0;
    await h.pool.prompt("past-1", text("hello"));
    assert.deepEqual(h.calls, [{ process: newerHost.id, method: "prompt" }]);
  } finally {
    await h.pool.stop();
  }
});

test("session/list: a cursor whose process is gone is refused with a clear error, not sent elsewhere", async () => {
  const h = launchPool({ args: ["--scenario", "chat", "--list-page-size", "1"] });
  try {
    await h.pool.start();
    const first = await h.pool.listSessions();
    assert.ok(first.nextCursor);
    const s1 = (await h.pool.newSession(h.cwd)).sessionId;
    await readySpare(h.pool);
    h.pool.releaseSession(s1); // the issuer hosts nothing and a spare exists: it is stopped
    await waitFor(() => !h.pool.processes().some((p) => p.sessionIds.includes(s1)), 10_000, "the issuer stopped");
    h.calls.length = 0;
    await assert.rejects(() => h.pool.listSessions({ cursor: first.nextCursor! }), /cursor expired/);
    assert.deepEqual(h.calls, [], "not sent to another process");
  } finally {
    await h.pool.stop();
  }
});

test("auth_required: signed out, the spare's refusal reaches the pool and the spare is kept; authenticate runs the login", async () => {
  const h = launchPool({ args: ["--scenario", "chat", "--auth-required"] });
  try {
    await h.pool.start();
    assert.equal(h.pool.status, "ready");
    await assert.rejects(
      () => h.pool.newSession(h.cwd),
      (error: unknown) => error instanceof AcpError && error.code === AUTH_REQUIRED_CODE,
    );
    assert.equal(h.pool.status, "auth_required");
    const change = h.changes.at(-1);
    assert.equal(change?.status, "auth_required");
    assert.deepEqual(change?.agent?.authMethods.map((m) => m.id), ["kiro-login"]);
    assert.equal(h.pool.agent, change?.agent);
    // The failed session/new gave the spare back: no new process per attempt.
    await assert.rejects(() => h.pool.newSession(h.cwd), AcpError);
    assert.deepEqual(h.pool.processes().map((p) => ({ id: p.id, spare: p.spare })), [{ id: 1, spare: true }]);
    assert.equal(h.agents.length, 1);

    await h.pool.authenticate("kiro-login");
    assert.deepEqual(h.services.terminalAuthRuns.map((r) => r.args), [[FAKE_AGENT, "acp", "--scenario", "chat", "--auth-required"]]);
  } finally {
    await h.pool.stop();
  }
});

test("auth_required from a session's process: authenticate goes to that process; the pool is ready again once it is gone", async () => {
  const h = launchPool({ args: ["--scenario", "chat"] });
  try {
    await h.pool.start();
    const s1 = (await h.pool.newSession(h.cwd)).sessionId;
    const spare = await readySpare(h.pool);
    const host = hostOf(h.pool, s1);

    await assert.rejects(() => h.pool.prompt(s1, text("/scenario auth-expired")), AcpError);
    assert.equal(h.pool.status, "auth_required");
    assert.match(h.changes.at(-1)?.message ?? "", /not logged in/);
    assert.deepEqual(h.pool.agent?.authMethods.map((m) => m.id), [FALLBACK_LOGIN_METHOD.id]);

    h.calls.length = 0;
    await h.pool.authenticate(FALLBACK_LOGIN_METHOD.id);
    assert.deepEqual(h.calls, [{ process: host.id, method: "authenticate" }]);
    assert.deepEqual(h.services.terminalAuthRuns.map((r) => r.args), [[]]);

    h.pool.releaseSession(s1);
    assert.equal(h.pool.status, "ready");
    assert.equal(h.changes.at(-1)?.status, "ready");
    assert.deepEqual(h.pool.agent?.authMethods, []);
    assert.equal(h.pool.processes().find((p) => p.spare)?.id, spare.id);
  } finally {
    await h.pool.stop();
  }
});

test("loadSession: replayed history is forwarded as replay, the session gets its own process, a reload stays there, a failed load gives the spare back", async () => {
  const h = launchPool({ args: ["--scenario", "chat"] });
  try {
    await h.pool.start();
    const state = await h.pool.loadSession("past-1", h.cwd);
    assert.equal(state.sessionId, "past-1");
    // The canned history (the command list is announced a little after the load answer).
    const replayed = h.events.filter(
      (e) => e.type === "update" && e.sessionId === "past-1" && e.update.sessionUpdate !== "available_commands_update",
    );
    assert.equal(replayed.length, 4);
    assert.ok(replayed.every((e) => e.type === "update" && e.replay === true));
    const host = hostOf(h.pool, "past-1");
    assert.equal(host.spare, false);
    assert.ok(h.logger.lines.some((l) => l.message === `agent-pool: session past-1 -> process ${host.id}`));

    const before = h.events.length;
    assert.equal((await h.pool.prompt("past-1", text("continue"))).stopReason, "end_turn");
    const live = h.events.slice(before).filter((e) => e.type === "update" && e.sessionId === "past-1");
    assert.ok(live.length > 0 && live.every((e) => e.type === "update" && e.replay !== true));

    const spare = await readySpare(h.pool);
    h.calls.length = 0;
    await h.pool.loadSession("past-1", h.cwd);
    assert.deepEqual(h.calls, [{ process: host.id, method: "loadSession" }]);

    await assert.rejects(() => h.pool.loadSession("missing", h.cwd), AcpError);
    assert.deepEqual(
      h.pool.processes().map((p) => ({ id: p.id, spare: p.spare })),
      [
        { id: host.id, spare: false },
        { id: spare.id, spare: true },
      ],
    );
    await assert.rejects(() => h.pool.prompt("missing", text("x")), isUnknownSession);
  } finally {
    await h.pool.stop();
  }
});

test("a spare that cannot start: start() rejects and the pool reports the failure as error", async () => {
  const h = launchPool({ command: "definitely-not-a-real-binary-xyz" });
  try {
    await assert.rejects(() => h.pool.start(), AcpError);
    assert.equal(h.pool.status, "error");
    assert.deepEqual(h.changes.map((c) => c.status), ["starting", "error"]);
    assert.match(h.changes[1]?.message ?? "", /Failed to start/);
    assert.deepEqual(h.pool.processes(), []);
    await assert.rejects(() => h.pool.newSession(h.cwd), (e: unknown) => e instanceof AcpError && /not running/.test(e.message));
  } finally {
    await h.pool.stop();
  }
  assert.equal(h.pool.status, "stopped");
});

test("stop() called while start() is still resolving the CLI leaves no process behind (KiroAgentImpl spawns after that await)", async () => {
  const h = launchPool({ args: ["--scenario", "chat"] });
  const starting = h.pool.start();
  starting.catch(() => undefined);
  await h.pool.stop();
  await assert.rejects(starting, AcpError);
  assert.equal(h.agents.length, 1);
  assert.equal(h.agents[0]?.pid, null, "the late child was stopped before stop() resolved");
  await delay(300);
  assert.equal(h.agents[0]?.pid, null);
  assert.equal(h.pool.status, "stopped");
  assert.deepEqual(h.changes.map((c) => c.status), ["starting", "stopped"]);
});

test("stop() right after a new session (next spare still starting) rejects the running turn and leaves no process behind", async () => {
  const h = launchPool({ args: ["--scenario", "slow"] });
  await h.pool.start();
  const session = await h.pool.newSession(h.cwd);
  const turn = h.pool.prompt(session.sessionId, text("long"));
  turn.catch(() => undefined);
  await h.pool.stop();
  await assert.rejects(turn, AcpError);
  assert.equal(h.agents.length, 2);
  for (const agent of h.agents) assert.equal(agent.pid, null, `process ${h.agents.indexOf(agent) + 1} still runs`);
  await delay(300); // a child spawned after stop() would show up by now
  for (const agent of h.agents) assert.equal(agent.pid, null);
  assert.equal(h.pool.status, "stopped");
  assert.deepEqual(exits(h.events), []);
});

test("requireSignIn: the pool follows the process it asks (the spare) to auth_required", async () => {
  const h = launchPool({ args: ["--scenario", "chat"] });
  try {
    await h.pool.start();
    await readySpare(h.pool);
    h.pool.requireSignIn("Kiro is not signed in.");
    assert.equal(h.pool.status, "auth_required");
    const change = h.changes[h.changes.length - 1];
    assert.equal(change?.status, "auth_required");
    assert.equal(change?.message, "Kiro is not signed in.");
  } finally {
    await h.pool.stop();
  }
});
