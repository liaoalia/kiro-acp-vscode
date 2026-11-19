# Plan: Agent link — Kiro sessions in different tabs talk to each other

## Overview
- Let the Kiro agent in one chat tab / session see the other live sessions, read them, send them messages, wait for them and start new ones, the way agents in different agterm tabs talk through `agtermctl` (https://github.com/umputun/agterm, recipe `cookbook/two-agent-mailbox-chat`).
- agterm is a terminal: it types keystrokes or drops mail that a Claude Code hook picks up, and nobody knows when the other agent is done. We are the ACP client: we own every session, know exactly when a turn ends (`session/prompt` response) and can start a turn ourselves, so delivery and "done" are exact.
- Transport: the extension runs a small MCP server on loopback HTTP and hands it to every session through `session/new` / `session/load` `mcpServers`. Kiro CLI V3 advertises `mcpCapabilities: { http, sse }` (docs/protocol-notes.md). Each session gets its own bearer token, so every tool call says who is calling (agterm's `AGTERM_SESSION_ID`).
- Delivery of a message to another session reuses the existing prompt queue (D22): an idle target starts a turn at once, a busy one shows the message as *queued* and gets it when its turn ends. Messages are never steered into a running turn.
- Shipped in stages; stage 1 is a transport spike behind a setting that is off by default, so nothing changes for users until the real CLI has been checked.

## Context (from discovery)
- `KiroAgent.newSession(cwd, { mcpServers })` and `loadSession(id, cwd, { mcpServers })` already exist (`src/acp/client.ts`), always called with `[]` today. ACP v1 `McpServer` http variant: `{ type: "http", name, url, headers: HttpHeader[] }` (headers required in v1).
- `ChatController` (`src/ui/chatController.ts`) owns all sessions (`ChatSession`: `groupId` = tab, `title()`, `turnActive`, `queue`), creates them in `createSession()` → `newSessionWithHints()` and restores them in `loadInto()`; prompts go through `prompt()` → `runTurn()`, mid-turn through `promptDuringTurn()` → `enqueue()` / `drainQueue()`.
- Fake agent `test/fake-agent/agent.mjs` replays `test/recordings/*.json` step lists (`update`, `client_request`, `permission`, ...); unit tests drive it through `test/harness.ts`, e2e tests through `test/e2e/harness.ts` in a real VS Code.
- `kiro-cli` 3.2.1 is installed on this machine but signed out, and the user cannot sign in here: real-CLI checks are a separate, blocked step (⚠️) that the user runs on a signed-in machine.
- MCP Streamable HTTP (spec 2025-03-26 and later): client POSTs one JSON-RPC message; the server may answer a request with `Content-Type: application/json`, a notification with `202`; `GET` / `DELETE` may be `405`; `Mcp-Session-Id` is optional (we stay stateless).
- Do not answer an unknown token with `401`: an MCP client may start an OAuth discovery on 401 (Kiro has `_kiro.dev/mcp/oauth_request`). Use `403`.

## Development Approach
- **Testing approach**: Regular (code first, then tests). The MCP layer is vscode-free and unit-tested over real sockets; the fake agent acts as the MCP client for the end-to-end path, so no Kiro login is needed.
- Complete each task fully before moving to the next; every task that changes code adds/updates tests; all tests must pass before the next task.
- Parallel subagents by ownership: `src/agentLink/` (server) and `test/fake-agent/` (client) are written against the contract in `src/agentLink/types.ts` and touch disjoint files; wiring into `ChatController` comes after both.
- Update this plan when scope changes (➕ for discovered tasks, ⚠️ for blockers).

## Validation Commands
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Stage 1 — Transport spike (setting `kiroAcp.agentLink.enabled`, off by default)

### Task 1: Contracts
- [x] `src/agentLink/types.ts`: server name `kiro-acp-tabs`, `AgentLinkTool` (definition + handler), `CallerContext` (`sessionId`, `signal`), `ToolResult`, `LinkedSessionInfo`, `AgentLinkHost` (what the controller exposes: `listSessions(caller)`), `AgentLinkGrant` (token → `McpServer` entry, `bind(sessionId)`, `revoke()`), `AgentLinkLogger`
- [x] DECISIONS D30 draft: MCP over loopback HTTP instead of an agterm-style CLI in the terminal; per-session bearer token; 403 not 401; stateless; delivery through the D22 queue
- [x] `npm run typecheck` passes

### Task 2: MCP server over loopback HTTP (subagent A: `src/agentLink/protocol.ts`, `src/agentLink/server.ts`, `test/agentLink-*.test.ts`)
- [x] `protocol.ts` (pure): parse one JSON-RPC message, dispatch `initialize` (echo a supported `protocolVersion`, else the latest; `capabilities.tools`; `serverInfo`; `instructions`), `notifications/initialized`, `ping`, `tools/list`, `tools/call` (unknown tool → -32602, handler throw → `isError: true` result), anything else → -32601; batches → -32600
- [x] ➕ `resources/list`, `resources/templates/list`, `prompts/list` answer empty lists (some MCP clients list everything on connect, whatever the capabilities)
- [x] `server.ts`: `node:http` on `127.0.0.1:0`; only `POST /mcp`; `GET`/`DELETE` → 405; `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, any `Origin` header → 403; `Authorization: Bearer <token>` of a live grant, else 403; body over 1 MiB → 413; notifications → 202; a tool call is aborted (`signal`) when the client disconnects; `issue()` mints a 32-byte token (unbound until `bind`), `revokeSession()`, `stop()` closes sockets
- [x] an unbound grant may `initialize` / `tools/list`; its `tools/call` waits up to 10 s for `bind`, then fails with a tool error
- [x] every request logged once: `agent-link <session|unbound> <method>[ <tool>] -> <status>`; `initialize` adds `(client <name> <version>, protocol <requested> -> <negotiated>)`, client strings sanitized
- [x] tests: initialize/version negotiation, tools/list, tools/call ok / unknown tool / handler error, ping, unknown method, notification 202, 403 for missing/unknown/revoked token and foreign Host / Origin, 405, 413, unbound-then-bound call, abort on disconnect
- [x] `npm test` passes

### Task 3: Fake agent as MCP client (subagent B: `test/fake-agent/agent.mjs`, `test/recordings/agent-link.json`, `test/acp-client.test.ts`)
- [x] V3 advertises `mcpCapabilities: { http: true, sse: true }` (like the real CLI); `--no-mcp-http` drops `http`
- [x] `session/new` and `session/load` remember the session's `mcpServers`; `session/new` rejects an http entry when `http` is not advertised (-32602), like a strict agent
- [x] new step kind `mcp_call { server, tool, arguments, save?, expect?, expectError? }`: POSTs `initialize`, `notifications/initialized`, `tools/call` with the entry's headers (global `fetch`), wraps it in `tool_call` / `tool_call_update` (kind `other`, title `<server>/<tool>`, result text as content); `{{mcp.text}}` / `{{mcp.status}}` usable by later steps
- [x] recording `agent-link.json`: calls `kiro-acp-tabs/list_sessions` and says what it got
- [x] tests in `test/acp-client.test.ts`: `mcpServers` are forwarded on `session/new` and `session/load`; an `mcp_call` against a stub HTTP server in the test reports the stub's text; a missing server name reports an error; 403 and cancel
- [x] `npm test` passes

### Task 4: Wiring into the extension (`src/agentLink/tools.ts`, `src/ui/chatController.ts`, `src/extension.ts`, `package.json`)
- [x] tool `list_sessions` (read-only annotation): every live session with a short handle, title, tab, status (`working` | `idle` | `needs_input` | `restoring`), `self: true` for the caller
- [x] `ChatController` implements `AgentLinkHost`; the server starts lazily when the setting is on and the agent advertises `mcpCapabilities.http`, and is stopped on dispose / setting off
- [x] `createSession`: issue a grant, pass its entry to `session/new` (with the remembered-hints path too), `bind` after the response; if `session/new` with the server fails, retry without it and log a warning (like the hints retry)
- [x] `loadInto` (past sessions and sign-in restore): grant bound up front, passed to `session/load`
- [x] grants revoked when a session closes, on `/clear`, restart and agent exit
- [x] `/capabilities` shows `Agent link: off (<why>) | on — 127.0.0.1:<port>, N sessions linked`; `[info] agent-link ...` lines in the Kiro ACP output channel
- [x] setting `kiroAcp.agentLink.enabled` (default `false`) in `package.json`; tab names from `ChatPanelManager.titleOfGroup` ("Kiro Chat 2", "Sidebar")
- [x] `npm test` passes

### Task 5: E2E
- [x] `test/e2e/f17-agent-link.e2e.ts`: setting on, two tabs, `/scenario agent-link` in tab 1 lists the session of tab 2 (title, tab) and itself (`self`); turning the setting off cuts a linked session off and new sessions get no server; `--no-mcp-http`: no server is offered
- [x] ➕ found by F17.2: after the setting was turned off and on again, `ensureAgentLink` kept handing out the stopped server (its "starting" promise was never cleared); fixed
- [x] `npm run test:e2e` passes (72/72)

### Task 6: Docs
- [x] README: setting row; "no network calls" sentence says the extension makes no outbound calls and, with agent link on, listens on 127.0.0.1 for kiro-cli only
- [x] docs/protocol-notes.md: "Agent link" section with the checklist of Task 7
- [x] DECISIONS D30 final

### Task 7: ⚠️ Real CLI check (blocked: kiro-cli is signed out on this machine; run on a signed-in machine)
- [x] ➕ release Stage 1 as 0.3.12 (setting still off by default) so the signed-in machine can install it from GitHub Releases; no revmux round for Stage 1 yet
- [ ] with the setting on, ask Kiro to "list the other sessions with the kiro-acp-tabs tool"; record in protocol-notes: does V3 connect at all, when (at `session/new` or on first use), does each session call with its own token (no de-duplication by server name across sessions), the permission request it sends for an MCP tool (kind, options, `_meta.kiro.consent`), how the tool is named in `tool_call` titles, what `_kiro/mcp/status` reports
- [ ] go / no-go: if V3 ignores client-supplied http servers, ➕ add a stdio relay (`dist/agentLinkRelay.js`, run with VS Code's Node via `ELECTRON_RUN_AS_NODE=1`, URL + token in `env`) in front of the same server; if it de-duplicates by name, ➕ make the server name per session

## Stage 2 — Messages between sessions

### Task 8: Handles and reading
- [ ] stable short handles per session (`s1`, `s2`, … in creation order, kept across sign-in restore), shown in `list_sessions` and as a hover in the session list
- [ ] tool `read_session { session, last? }`: plain-text tail of a transcript (user / agent messages, tool call titles and status), size-capped; pure renderer in `src/features/pure/transcriptText.ts` with tests

### Task 9: `send_message`
- [ ] tool `send_message { to, text }`: the target gets a user turn framed as a message from another agent session (sender handle + title, a reminder that it is not the user's instruction and how to answer with `send_message`); idle → turn starts now, busy → `queued` badge, sent when its turn ends; never `_session/steer`
- [ ] errors as tool results: unknown / closed / restoring target, sending to oneself, empty text, text over 32 KiB
- [ ] UI: such a user bubble shows "from «title»" (new `MessageOrigin` in `src/ui/protocol.ts`), clicking it switches to the sender session
- [ ] unit + e2e: idle target starts a turn; busy target queues and gets it after; reply comes back to the sender

## Stage 3 — Safety and limits

### Task 10: Loops, rate, consent
- [ ] chain counter: a turn started by a peer message carries the chain depth; `send_message` from it is refused past `kiroAcp.agentLink.maxChain` (default 6) with a notice in both sessions
- [ ] rate limit per sender (e.g. 10 messages / minute)
- [ ] `kiroAcp.agentLink.confirm`: `firstPerPair` (default) / `always` / `never` — a confirmation card in the sender's chat before the first message to a session
- [ ] command `Kiro: Pause Agent Messages` (also in `/capabilities`): drops queued peer messages and refuses new ones until resumed
- [ ] tests for each rule

## Stage 4 — Orchestration

### Task 11: Wait and spawn
- [ ] tool `wait_for_session { session, timeoutSeconds? }`: returns when the target's turn ends (status + last answer tail) or it needs the user; capped timeout; aborted when the caller's HTTP request closes (Stop in the caller)
- [ ] ➕ `revoke()` / `revokeSession()` abort the tool calls still running for that grant (today only `stop()` and a client disconnect do), so closing the caller's session ends its waits
- [ ] tool `start_session { prompt, where: "newTab" | "sameTab" }`: creates a session, sends the prompt as a peer message, returns its handle
- [ ] e2e: orchestrator starts a helper, waits for it, reads its answer

## Stage 5 — Real CLI, release

### Task 12: Verify and ship
- [ ] ⚠️ every tool against a signed-in kiro-cli; tune tool descriptions / server `instructions` until Kiro uses them unprompted; record in protocol-notes
- [ ] README section "Agents talking to each other" (with a suggested steering text); decide whether `kiroAcp.agentLink.enabled` becomes `true` by default
- [ ] version bump, revmux review rounds, release tag
