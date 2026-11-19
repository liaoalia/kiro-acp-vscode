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
- [ ] `AgentPool implements KiroAgent`, built from a process factory (`() => KiroAgent`) and options `{ maxProcesses, logger }`; exported `createAgentPool(options, services, poolOptions)` next to `createKiroAgent`
- [ ] `start()`: starts one process (the spare) and resolves with its `AgentInfo`; `agent` / `status` reflect the pool (ready while the spare or any process is ready; `auth_required` as soon as any process reports it; `error`/`stopped` only when the pool itself is stopped or the spare cannot start)
- [ ] `newSession` / `loadSession`: take the ready spare (start one if none), bind the session id to it, and start the next spare in the background; at `maxProcesses` the session goes to the process with the fewest sessions (shared, logged); `maxProcesses = 1` behaves exactly like today's single process
- [ ] session-scoped calls (`prompt`, `cancel`, `setMode`, `setConfigOption`, `setModel`, `callExtension` with a `sessionId` in params) go to the owning process; unknown session → `AcpError`
- [ ] process-wide calls (`listSessions`, `authenticate`, `callExtension` without a session) go to the spare, else any ready process
- [ ] events: session events of every process are forwarded; connection changes of the spare drive the pool's connection; a session process that exits or fails emits ➕ `SessionEvent { type: "process_exited"; sessionIds; message }` instead of taking the pool down
- [ ] ➕ `KiroAgent.releaseSession?(sessionId)`: forget the binding and stop the process when it hosts no other session and is not the spare
- [ ] `stop()`: stops every process; idempotent
- [ ] log one line per spawn / stop / assignment (`[info] agent-pool: process 3 (pid …) for session …`)
- [ ] tests with fake-agent processes: two sessions get two processes; prompts of two sessions run concurrently (both stream before either ends, e.g. the `slow` scenario); spare pre-warmed; `maxProcesses` sharing and `= 1`; release stops the process; a killed session process emits `process_exited` for its sessions only and the pool stays ready; `listSessions` / `authenticate` routing; `stop()`

### Task 2: Controller wiring (P2, after agent-link package D)
- [ ] `ChatController.startAgent` creates the pool; setting `kiroAcp.agentProcesses.max` (default 8, minimum 1; 1 = one shared process as before), applied at the next start / restart
- [ ] `process_exited`: only the sessions of that process end (`error` state, notice with Restart); other sessions keep working; restart reloads them as today
- [ ] `closeSession` / `/clear` / restore failures call `releaseSession`
- [ ] sign-in restore (D25): every restored session gets its own process (parallel loads)
- [ ] `/capabilities`: `Processes: N running (max M)`
- [ ] the agent-link `agentLinkUnavailable` check and `agentInfo` keep working with the pool's `agent`

### Task 3: E2E (P2)
- [ ] F19: two tabs prompted at once both stream at the same time; closing a session stops its process; killing one session's process leaves the other session working; `kiroAcp.agentProcesses.max = 1` keeps the old shared behaviour; sign-in restore still restores every session (F14.2 unchanged)
- [ ] agent link: `wait_for_session` from a running turn sees its target run and finish (the scenario that a single process cannot do)

### Task 4: Docs (P2)
- [ ] DECISIONS D31 (supersedes the "one process" part of D19): why, pool design, spare, sharing past the limit, failure isolation, memory cost
- [ ] README: settings row `kiroAcp.agentProcesses.max`; a sentence on parallel sessions
- [ ] protocol-notes: real-CLI checklist — two tabs run in parallel; memory per process; whether `session/list` from one process sees sessions created by another; concurrent writes to Kiro's session store

### Task 5: ⚠️ Real CLI check (user, signed-in machine)
- [ ] three tabs prompted at once all answer at once; record process memory and startup time
