# Plan: Kiro ACP client extension for VS Code

## Overview
- A VS Code extension that spawns `kiro-cli acp` as a child process and talks ACP (JSON-RPC over stdio) through the official `@agentclientprotocol/sdk` TypeScript SDK.
- Goal: Claude Code-like UX on top of Kiro: streaming chat, tool cards, native diff review with accept/reject, live plan document, `@` file context, selection context, client-side fs/terminal, per-tool-kind permissions.
- The extension itself makes no network calls and has no telemetry; all network access happens inside kiro-cli, which inherits the environment (HTTPS_PROXY / HTTP_PROXY / NO_PROXY).

## Context (from discovery)
- ACP spec: https://agentclientprotocol.com (protocol v1). SDK: `@agentclientprotocol/sdk` 2.5.0 (Apache-2.0), v1 stable entrypoint, `client()` app API, `ndJsonStream(writable, readable)`.
- Kiro CLI 3.1.0 (Nov 2026) runs the V3 harness for `kiro-cli acp` by default on Windows/macOS; `--agent-engine=v2|v3` overrides. V3 uses `session/set_config_option` (configId `model`, `effortLevel`), modes via `session/set_mode`, Kiro extensions advertised in `agentCapabilities._meta.kiro.extensionMethods`, permission consent in `_meta.kiro.consent`.
- kiro-cli is NOT installed on this machine yet (native Windows installer: `irm https://cli.kiro.dev/install.ps1 | iex`, MSI to `C:\Program Files\Kiro-Cli\`). Real-CLI verification is blocked until it is installed and `kiro-cli login` has been run.
- Layers: `src/acp/` (process + connection + session, vscode-free), `src/features/` (fs, terminal, permissions, diff, plan, context), `src/ui/` (webview provider + message protocol), `src/webview/` (browser bundle). Contracts in `src/acp/types.ts` and `src/ui/protocol.ts`.

## Development Approach
- **Testing approach**: Regular (code first, then tests). Protocol layer is unit-tested against a fake ACP agent (`test/fake-agent/agent.mjs`) that replays recorded sessions, so tests need no Kiro login.
- Complete each task fully before moving to the next; small focused changes.
- Every task that changes code adds/updates tests; all tests must pass before the next task.
- Update this plan when scope changes (➕ for discovered tasks, ⚠️ for blockers).

## Validation Commands
- `npm run typecheck`
- `npm test`
- `npm run build`

## Implementation Steps

### Task 1: Project scaffold and contracts
- [x] package.json (secondary sidebar view container, commands, settings `kiroAcp.cliPath` / `kiroAcp.cliArgs`, keybinding), tsconfigs, esbuild bundling (extension CJS + webview IIFE)
- [x] `src/acp/types.ts` – public API of the ACP layer (ClientServices, KiroAgent, events)
- [x] `src/ui/protocol.ts` – extension ↔ webview message types
- [x] write docs/DECISIONS.md with the initial decisions
- [x] run `npm run typecheck` – must pass before task 2

### Task 2: ACP layer – process, connection, session (milestone 1 protocol part)
➕ Note: connection + session live in `src/acp/client.ts` (one class) and `src/acp/stream.ts`; `session/update` is intercepted at the stream level because the SDK's typed router rejects unknown update kinds and reorders notifications vs. responses.
- [x] `src/acp/process.ts`: resolve cliPath (PATH + platform default install dirs), spawn `kiro-cli acp <args>` with inherited env, stdio pipes, stderr to log, exit handling
- [x] `src/acp/connection.ts`: `client()` app with handlers for session/update, session/request_permission, fs/*, terminal/*, `_kiro/openExternalUrl`, fallback `*` → -32601; `initialize` with clientCapabilities (fs r/w, terminal, auth.terminal, `_meta.kiro.openExternalUrl`); capture agentCapabilities, authMethods, `_meta.kiro.extensionMethods`
- [x] `src/acp/session.ts`: newSession (cwd, mcpServers []), prompt (content blocks), cancel (notification + cancelled outcome for pending permissions), setMode, setConfigOption, setModel (if `models` advertised), per-session event emitter
- [x] `src/features/pure/transcript.ts`: pure reducer from SessionUpdate → UI transcript model (messages, tool calls incl. diff/terminal content, plan, modes, configOptions, available commands)
- [x] `test/fake-agent/agent.mjs` + `test/recordings/*.json`: fake agent speaking ACP over stdio via the SDK `agent()` API, scenario replay
- [x] write tests: initialize exchange, streaming chat, cancel → `cancelled`, permission round-trip, fs read/write round-trip, terminal round-trip, unknown method → error, transcript reducer
- [x] run tests – must pass before task 3

### Task 3: Chat webview (milestone 1 UI part)
- [x] `src/webview/main.ts` + `media/chat.css`: streaming markdown messages (marked + DOMPurify), tool call cards with status and content, cancel button, new session, mode/model/config pickers, auth banner with "Log in" button, context chips, `@` autocomplete popup
- [x] `src/ui/chatView.ts`: WebviewViewProvider with strict CSP + nonce, state snapshot on (re)load, bridges protocol messages to the ACP layer and features
- [x] `src/extension.ts`: activation, commands, context keys, output channel, settings
- [x] build with esbuild, typecheck webview tsconfig
- [x] run tests – must pass before task 4

### Task 4: Permissions + client fs/terminal services (milestone 2)
- [x] `src/features/permissions.ts`: pending request registry, per-session per-tool-kind policy (allow once / always allow this session / reject), cancel-all on turn cancel, webview + command resolution paths
- [x] `src/features/fs.ts`: read from open (dirty) buffers first, else disk; `line`/`limit` slicing; writes via WorkspaceEdit (create or replace) then save; path must be absolute and inside workspace roots (else ask)
- [x] `src/features/terminal.ts`: spawn command in child_process, mirror output into a visible VS Code Pseudoterminal, retain output with byte limit, output/wait_for_exit/kill/release semantics
- [x] write tests for the pure parts (permission policy, output ring buffer, line slicing)
- [x] run tests – must pass before task 5

### Task 5: Diff review (milestone 3)
- [x] `src/features/diff.ts`: in-memory FileSystemProvider for `kiro-proposed:` (editable) and TextDocumentContentProvider for `kiro-original:`; open `vscode.diff` when a tool call carries `type: "diff"` content; Accept/Reject in editor title and chat card resolve the pending permission; edited proposed text is what gets written (substitution in fs/write_text_file + post-completion reconciliation)
- [x] context keys `kiroAcp.diffPending`; close diff editors on resolution
- [x] write tests for the pure diff bookkeeping
- [x] run tests – must pass before task 6

### Task 6: File and selection context (milestone 4)
- [x] `src/features/context.ts`: active editor chip (removable, default on), selection chip `file.ts:12-40`, `@` file search via `workspace.findFiles`, content block builders (resource_link for files; embedded resource for selection when `embeddedContext` is advertised, else text block)
- [x] command + keybinding `kiroAcp.sendSelection`
- [x] write tests for content block builders
- [x] run tests – must pass before task 7

### Task 7: Plan tab (milestone 5)
- [x] `src/features/plan.ts`: `kiro-plan:` read-only markdown document updated live from `plan` updates; `kiroAcp.openPlan` command; approve/reject buttons when a `switch_mode`-kind permission request is pending (ACP-standard plan hand-off); document in protocol-notes what Kiro really exposes
- [x] write tests for plan → markdown rendering
- [x] run tests – must pass before task 8

### Task 8: Verify acceptance criteria
- [x] all 7 features wired end to end in the Extension Development Host against the fake agent (➕ automated with @vscode/test-electron in test/e2e: 14 tests, run by `npm run test:e2e` and the CI e2e job)
- [x] run full test suite, typecheck, build (77 unit tests)
- [ ] ⚠️ run against real `kiro-cli acp` (blocked until kiro-cli is installed + logged in); record the real `initialize` exchange in docs/protocol-notes.md

### Task 9: Packaging + docs (milestone 6)
- [x] `vsce package` produces a VSIX (`--no-dependencies`, bundled)
- [x] README: install (VSIX), settings, proxy setup, auth, troubleshooting, feature list with verification status
- [x] docs/protocol-notes.md and docs/DECISIONS.md complete (real-CLI sections remain marked [unverified] until kiro-cli is installed)

## Technical Details
- Transport: `spawn(cli, ["acp", ...cliArgs], { env: process.env, cwd: workspaceRoot, stdio: ["pipe","pipe","pipe"] })`; `ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout))`.
- Turn completion is settled only by the `session/prompt` response (never by a `turn_end` info update).
- Permission responses only ever return option ids supplied by the agent; the client-side "always allow this session" policy auto-selects the agent's `allow_once` (or `allow_always`) option.
- The webview never talks to the process; it only exchanges `src/ui/protocol.ts` messages with the extension host.

## Post-Completion
- Install Kiro CLI (`irm https://cli.kiro.dev/install.ps1 | iex`), run `kiro-cli login`, then exercise each feature against the real agent and update docs/protocol-notes.md with the recorded `initialize` exchange and any spec deviations.
- Manual UX pass on Linux and macOS (path resolution defaults, terminal behaviour).

### ➕ Task 16: Sign-in from the chat on expired tokens; no implicit active-file chip (0.3.4)
- [x] `isAuthRequiredError` + `FALLBACK_LOGIN_METHOD` (`src/acp/types.ts`); `markAuthRequired` on `session/new|load|prompt` failures (`src/acp/client.ts`)
- [x] `ChatController.login()` (default method or fallback) and `restart({ restoreSessions })`; `/login` slash command; `kiroAcp.login` command
- [x] no duplicate "Prompt failed" notice when the sign-in banner is shown
- [x] `kiroAcp.attachActiveFile` default `false` (package.json, context.ts, README)
- [x] fake agent: `login` subcommand exits 0; `/scenario auth-expired` rejects the prompt like the real CLI
- [x] tests: `test/acp-client.test.ts` (3 new), slash tests, `test/e2e/f14-login.e2e.ts`
- [x] docs: README (auth, settings, commands), protocol-notes (observed error), DECISIONS D25
- [x] ➕ 0.3.5: agent-advertised terminal auth args are appended to `kiro-cli acp …` (Kiro advertises `--login`; `kiro-cli --login` failed on the real CLI); fake agent advertises `--login` and accepts `acp --login`
- [x] ➕ 0.3.5: the login terminal runs the sign-in as its own process; exit 0 (or closing it) reconnects automatically, Reconnect button kept

### ➕ Task 17: Stop keeps the queue; Esc stops (0.3.6)
- [x] `endTurn` drops the queue only after an error; a cancelled turn drains it (`src/ui/chatController.ts`)
- [x] a `_session/steer` refusal that lands after the turn ended queues the message (sent as the next turn) instead of dropping it
- [x] Esc anywhere in the chat posts `cancel` while a turn runs (`src/webview/main.ts`); Stop buttons titled "Stop (Esc)"
- [x] e2e F12.3 / F12.5 rewritten for the new semantics
- [x] docs: README, DECISIONS D22
- [x] `/clear` replaces the session in its tab (the old one is forgotten locally); `/new` still adds one alongside (e2e F9.1)

### ➕ Task 18: Context and token usage in the header (0.3.6)
- [x] `src/features/pure/usage.ts`: `SessionUsage` + `applyUsageUpdate` for ACP `usage_update` (`used`/`size`/`cost`), Kiro `session_info_update` `context_usage` (`usagePercentage`) and `turn_completion` (`promptTurnSummaries` token fields, summed per session)
- [x] controller keeps `session.usage`, posts `{ type: "usage" }`, includes it in the `state` snapshot; logs the raw `turn_completion` meta once per session so its real shape can be recorded
- [x] webview: usage pill next to the status pill ("42% ctx · 12.3k tokens", tooltip with the numbers); reducer `usage`
- [x] fake agent `usage` scenario (`test/recordings/usage.json`) emits all three updates
- [x] tests: `test/features-usage.test.ts`, webview-state reducer, e2e F15
- [x] docs: README, protocol-notes (shapes to confirm on the real CLI), DECISIONS D26

## Follow-ups (from revmux rounds, not blocking)
- [ ] `src/features/diff.ts:405` — diff entries and permission selection are keyed by tool-call id only; add the session id so two sessions reusing an id can never resolve each other's proposal
- [ ] `src/ui/chatController.ts:1384` — automatic diff opening indexes the filtered diff list while card links use content indexes; use one indexing scheme
- [ ] protocol-notes: capture a raw `initialize`/`session/new` exchange with `scripts/record-acp.mjs` on a machine with kiro-cli (sections still marked [unverified])
