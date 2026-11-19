# Plan: One kiro-cli process per session

## Overview
- Today every chat tab and session shares one `kiro-cli acp` process (DECISIONS D19). On a signed-in machine (2026-11-19, 0.3.12) three tabs were prompted at once: one worked, the other two got nothing at all for 33 minutes ("thinking · no reply for 33 min", 1% context) — the extension sends each `session/prompt` at once (`src/acp/client.ts` `prompt`), so the process runs one turn at a time. `kiro-cli acp --help` has no concurrency option.
- The user decided: one process per session, so sessions in different tabs really run in parallel. It also unblocks the agent link (D30): with one process, `wait_for_session` from inside a turn can never see its target run.
- Approach: an `AgentPool` that implements the existing `KiroAgent` facade (`src/acp/types.ts`) over several `KiroAgentImpl` processes, so the controller keeps talking to one `KiroAgent`; session-scoped calls are routed to the process that owns the session; a pre-warmed spare process makes a new session as fast as today.

## Context (from discovery)
- `KiroAgent` (`src/acp/types.ts`): `start/stop`, `status`, `agent` (AgentInfo), `onConnectionChange`, `onSessionEvent`, `newSession`, `listSessions`, `loadSession`, `prompt`, `cancel`, `setMode`, `setConfigOption`, `setModel`, `authenticate`, `callExtension`. `createKiroAgent(options, services)` in `src/acp/client.ts`.
- `ChatController.startAgent` builds one agent with `createKiroAgent(...)`, subscribes to its connection and session events, and treats a connection `error`/`stopped` as "every session is gone" (`endAllSessions`). Restart / sign-in restore (D25) loads the live sessions back with `session/load`.
- Client services (fs, terminal, permissions) are shared and already keyed by session id; the agent-link server (D30) hands a per-session `mcpServers` entry to `session/new` / `session/load`.
- The fake agent (`test/fake-agent/agent.mjs`) is one process per spawn; its session ids differ per process (0.3.11). Unit tests drive it through `test/harness.ts`; e2e through `test/e2e/harness.ts`.

## Development Approach
- **Testing approach**: Regular (code first, then tests). The pool is vscode-free and unit-tested with real fake-agent processes.
- Package P1 (the pool) runs in a worktree in parallel with agent-link package D (which does not touch `src/acp/`); package P2 (controller wiring, settings, e2e, docs) runs after D is merged.
- Complete each task fully before moving to the next; all tests must pass before the next task.
- Update this plan when scope changes (➕ for discovered tasks, ⚠️ for blockers).

## Validation Commands
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

### Task 1: Pool contract and implementation (P1: `src/acp/pool.ts`, `src/acp/types.ts`, `test/agentPool.test.ts`)
- [x] `AgentPool implements KiroAgent`, built from a process factory (`() => KiroAgent`) and options `{ maxProcesses, logger }`; exported `createAgentPool(options, services, poolOptions)` next to `createKiroAgent`
- [x] `start()`: starts one process (the spare) and resolves with its `AgentInfo`; `agent` / `status` reflect the pool (ready while the spare or any process is ready; `auth_required` as soon as any process reports it; `error`/`stopped` only when the pool itself is stopped or the spare cannot start)
- [x] `newSession` / `loadSession`: take the ready spare (start one if none), bind the session id to it, and start the next spare in the background; at `maxProcesses` the session goes to the process with the fewest sessions (shared, logged); `maxProcesses = 1` behaves exactly like today's single process
- [x] session-scoped calls (`prompt`, `cancel`, `setMode`, `setConfigOption`, `setModel`, `callExtension` with a `sessionId` in params) go to the owning process; unknown session → `AcpError`
- [x] process-wide calls (`listSessions`, `authenticate`, `callExtension` without a session) go to the spare, else any ready process
- [x] events: session events of every process are forwarded; connection changes of the spare drive the pool's connection; a session process that exits or fails emits ➕ `SessionEvent { type: "process_exited"; sessionIds; message }` instead of taking the pool down
- [x] ➕ `KiroAgent.releaseSession?(sessionId)`: forget the binding and stop the process when it hosts no other session and is not the spare
- [x] `stop()`: stops every process; idempotent
- [x] log one line per spawn / stop / assignment (`[info] agent-pool: process 3 (pid …) for session …`)
- [x] tests with fake-agent processes: two sessions get two processes; prompts of two sessions run concurrently (both stream before either ends, e.g. the `slow` scenario); spare pre-warmed; `maxProcesses` sharing and `= 1`; release stops the process; a killed session process emits `process_exited` for its sessions only and the pool stays ready; `listSessions` / `authenticate` routing; `stop()`

### Task 2: Controller wiring (P2, after agent-link package D)
- [x] `ChatController.startAgent` creates the pool; setting `kiroAcp.agentProcesses.max` (default 8, 1–32; 1 = one shared process as before), applied at the next start / restart
- [x] `process_exited`: only the sessions of that process end; other sessions keep working and the connection stays ready. ⚠️ Changed from "`error` state, notice with Restart": each such session keeps its transcript and handle, its turn ends, queue dropped, permissions cancelled, terminals killed, agent-link token revoked, and one notice says the next message loads it again
- [x] ➕ transparent reload: the session's next turn (typed, queued or a peer message), option change or agent-asking slash command first `session/load`s it into a new process (replayed history dropped, new agent-link token bound to it); a failed load says so and the message is not sent
- [x] ➕ the exit notice replaces the turn's "Prompt failed": on Windows the prompt rejects ("ACP connection closed") *before* `process_exited` (P1 expected the opposite order), so the controller remembers the failure notice and the exit clears it (within 5 s, no turn since)
- [x] `closeSession` / `/clear` / restore failures call `releaseSession`; ➕ a release that lands while a load is in flight is repeated when the load ends; cancel / close of a session no process hosts sends nothing (no "Cancel failed")
- [x] sign-in restore (D25): every restored session gets its own process (parallel loads, four at a time, plan order and focus kept)
- [x] `/capabilities`: `Processes: N running (max M)` plus one line per process; ➕ `controller.agentProcesses()` / `agentProcessLimit()` for the tests
- [x] the agent-link `agentLinkUnavailable` check and `agentInfo` keep working with the pool's `agent`

### Task 3: E2E (P2)
- [x] F19 (`test/e2e/f19-processes.e2e.ts`, fake agent with `--serial-turns`): F19.1 two tabs prompted at once stream at the same time (and `/capabilities` lists the processes); F19.2 `kiroAcp.agentProcesses.max = 1` serializes them (and `session/list` pages through the live sessions again); F19.3 closing a session stops its process; F19.4 a killed process ends only its session, the other tab keeps working, the next message reloads `past-1` and answers (a fresh fake session says it cannot be loaded); F19.5 a mid-turn exit shows one notice, no "Prompt failed"; F19.6 a sign-in restores each session into its own process, in parallel (F14.2 unchanged)
- [x] agent link: F19.7 `wait_for_session` from a running turn sees its target run and finish; F19.8 a peer message reloads an exited session, which keeps its handle and gets a working token; F19.9 with `max = 1` the same wait times out (the single-process limit)
- [x] ➕ existing tests: all pass unchanged; only F11.2's comment changed (the listing process — the spare — no longer holds the live sessions, so pagination is covered by F19.2)

### Task 4: Docs (P2)
- [x] DECISIONS D31 (supersedes the "one process" part of D19, noted there): why, pool design, spare, sharing past the limit, failure isolation, transparent reload, parallel restore, memory cost, `max = 1` fallback; D30 addendum's known limit rewritten
- [x] README: settings row `kiroAcp.agentProcesses.max`; parallel sessions in the features table and "Tabs and sessions"; the agent-link known limit and the "sessions live as long as the process" line updated
- [x] protocol-notes: real-CLI checklist "Process per session (D31)" — three tabs in parallel; memory and start time per process; whether `session/list` from one process sees sessions created by another; `session/load` of a session live in another process; concurrent writes to Kiro's session store; exit and reload; sign-in; shared MCP servers; verification row 10
- [x] agent-link plan follow-up ticked

### Task 5: ⚠️ Real CLI check (user, signed-in machine)
- [ ] three tabs prompted at once all answer at once; record process memory and startup time
- [ ] the rest of the protocol-notes checklist "Process per session (D31)": `session/list` across processes, `session/load` of a session live elsewhere, concurrent writes to the session store, exit and reload, sign-in, shared MCP servers
