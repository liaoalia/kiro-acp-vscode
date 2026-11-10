# Decisions

Cheap-to-reverse choices made without asking. Each entry: what, why, how to change.

## D1. SDK entrypoint: `@agentclientprotocol/sdk` v1 stable, `client()` app API
Kiro negotiates ACP protocol version 1 for both its v2 and V3 engines. The SDK's
default import is stable v1; the legacy `ClientSideConnection` class was removed
in SDK 2.x, so the fluent `client().onRequest(...).connect(stream)` API is used.
Unstable v1 fields Kiro may send (e.g. `models` on `session/new`) are read from
the raw response `_meta`/extra fields defensively instead of importing
`/unstable`.

## D2. Bundling: esbuild → single CommonJS `dist/extension.js`
VS Code loads extension entrypoints as CommonJS. The SDK is ESM-only, so it is
bundled (esbuild `format: cjs`, `platform: node`, `external: ["vscode"]`).
The webview is a separate IIFE bundle (`dist/webview.js`). Tests compile with
`tsc` to `out/` and run on `node --test`; Node ≥ 22 can `require()` the ESM
SDK because it has no top-level await.

## D3. Process launch
`spawn(cliPath, ["acp", ...cliArgs], { env: process.env, cwd: workspaceRoot })`
with `shell: false` and `windowsHide: true`. A bare `cliPath` is searched on
PATH and then in platform defaults (`C:\Program Files\Kiro-Cli\kiro-cli.exe`,
`~/.local/bin/kiro-cli`, `/usr/local/bin/kiro-cli`, `/opt/homebrew/bin/kiro-cli`)
because VS Code often does not inherit the login shell PATH.

## D4. No engine flag by default
`kiroAcp.cliArgs` defaults to `[]`; Kiro CLI ≥ 3.0 picks the V3 harness for
`acp` on Windows/macOS. Users on v2 can set `["--agent-engine=v2"]`. The client
gates every optional behaviour on advertised capabilities, never on the engine.

## D5. Turn completion
A prompt turn ends only when `session/prompt` returns. Kiro's `session_info_update`
with `_meta.kiro.kind: "turn_end"` is ignored for completion (per Kiro's V3
migration guide).

## D6. Permissions
Only the options supplied by the agent are shown. "Always allow for this
session" is a client-side policy keyed by `(sessionId, toolKind)` that
auto-selects the agent's `allow_once` option (or `allow_always` if that is the
only allow option) for subsequent requests. Reject policies mirror this with
`reject_once`. The policy is cleared on new session / restart.

## D7. Diff accept with edits
The proposed side of the diff editor is an editable in-memory document
(`kiro-proposed:` FileSystemProvider). On Accept, the client records
`{ path, agentText, userText }`; if the agent then calls `fs/write_text_file`
for that path with exactly `agentText`, the client writes `userText` instead.
If the agent wrote directly to disk (file equals `agentText` when the tool call
reaches `completed`), the client applies `userText` via a WorkspaceEdit. This is
best-effort: an agent that rewrites the file differently is left alone.

## D8. fs/write_text_file semantics
Writes go through `WorkspaceEdit` (replace whole document, or `createFile`
with contents) and are then saved to disk so that subsequent agent commands
see the file. The edit stays in the editor's undo stack.

## D9. Terminals
Agent terminals are real child processes started by the extension
(`child_process.spawn` with `shell: true` so compound commands work). Output
is retained up to `outputByteLimit` (default 1 MiB), truncating from the start
on a character boundary, and served to the agent (`terminal/output`,
`wait_for_exit`) and to the chat card per `terminalId`. `release` kills a
still-running process; the retained output survives for the card.
Terminal ids are unique per extension-host run (`term-<random run id>-<n>`)
and every lookup for the UI (`snapshot`, `showTerminal`) is checked against
the session that created the terminal, so an id replayed from an earlier run
or another session never shows a different session's command output.

How that output is mirrored into VS Code is a setting, `kiroAcp.terminal.mode`,
read on every `terminal/create` (`src/features/pure/terminalPresentation.ts`):

- `shared` (default): one `Pseudoterminal` per ACP session, named
  `Kiro · <short session id>`, created lazily and revealed (`preserveFocus`)
  only on the session's first command; later commands never re-show it. Each
  command writes a bold/dim header `$ <command line>   [<cwd>]`, its output,
  and a dim `[exit code N]` footer. Commands still run concurrently with their
  own ids and buffers; a command started while another is running has its
  lines prefixed with `[term-N]`. Keystrokes go to the most recently started
  running child. Closing the tab kills the session's running commands; the
  next command recreates the terminal. The chat card's "Show terminal" reveals
  the session terminal. Rationale: a working session used to leave dozens of
  `Kiro: <command>` tabs.
- `perCommand`: the previous behaviour, one `Kiro: <command>` terminal per
  command, shown on creation; the tab stays open after release.
- `hidden`: no VS Code terminal; output is only in the chat card and
  `showTerminal` reports that there is nothing to show.

`disposeAll()` kills every child and closes the shared terminals.

## D10. Selection context encoding
ACP has no line-range field. A selection is sent as an embedded `resource`
block (`uri: file:///path#L12-L40`, `text: <selected text>`) when the agent
advertises `promptCapabilities.embeddedContext`; otherwise as a `text` block
containing a fenced snippet labelled `path:12-40`. `@` files and the active
file are sent as `resource_link` blocks (always allowed by the spec).

## D11. Plan approval
ACP has no plan-approval method. Kiro's planner is a session mode; the
hand-off to execution is expected to arrive as a `session/request_permission`
whose tool call has `kind: "switch_mode"`. When such a request is pending, the
plan tab shows Approve/Reject which answer that request. If the real CLI uses a
different mechanism this is recorded in `docs/protocol-notes.md`.

## D12. Webview rendering
Markdown is rendered with `marked` and sanitised with `DOMPurify` under a
strict CSP (`default-src 'none'`, nonce-scoped script, no remote resources).
Vanilla TypeScript, no UI framework, to keep the dependency surface small.

## D13. User messages are echoed locally
The chat shows the user's prompt (text plus one resource chip per attached
file/selection) immediately from the extension side with a local
`messageId` (`user-N`). *Live* `user_message_chunk` updates are ignored so an
agent that echoes the prompt does not produce a duplicate. The rule applies
to live updates only: user chunks replayed by `session/load` (`replay: true`
on the `SessionEvent`, i.e. in flight during the load or marked
`_meta.kiro.replay: true`) are rendered, and the first of them becomes the
fallback title of the restored session (see D21).

## D14. Compiled artifacts are not committed
`dist/` and `*.vsix` stay out of git. GitHub Actions builds and tests on
Linux/Windows/macOS, uploads the VSIX as a build artifact on every push to
`main`, and attaches it to a GitHub Release for `v*` tags.

## D15. Diff editor lifecycle is defensive by design
Two VS Code behaviours were observed in the extension-host tests and shape
`DiffManager`: (1) the `vscode.diff` command can resolve before its tab is
listed in `window.tabGroups`, and (2) an agent may re-use a tool-call id in a
later turn while the previous cleanup is still running. Therefore every open
gets a generation segment in its URI, `openDiff` registers state before its
first `await` and aborts if the call was finalized meanwhile, cleanup retries
closing for a short grace period, a `tabGroups.onDidChangeTabs` listener closes
any proposal tab whose entry is gone, and the controller never opens a diff for
a tool call that has already ended. Do not simplify these away: the flake was
~1 in 5 runs locally and consistent on Linux CI.

## D16. Chat lives in the editor area by default; pickers are hidden by default
The user asked for the chat to open where they work rather than in a side
panel, and for the mode/model/option pickers not to take space until needed.
The same webview is therefore hosted two ways: a `WebviewPanel`
(`kiroAcp.chatPanel`, restored after reload via a serializer) that
`Kiro: Focus Chat` opens in the active editor group when
`kiroAcp.chatLocation` is `editor` (default), and the original `WebviewView`
in the secondary side bar. `ChatController` fans messages out to every
attached webview, so both can be open at once. The pickers sit behind a ⚙
toggle in the header; the host default comes from
`kiroAcp.showSettingsByDefault` and the user's toggle is persisted per
webview with `setState`.

## D17. Wide-layout chat mirrors a familiar editor-tab chat shape
In the editor tab (≥ 640px) the webview uses a centred 880px column, a thin
title bar (brand + status left, icon buttons right), an empty state with an
original pixel mascot and a code-style tagline, and a single rounded
composer card: chips, textarea, then a toolbar with `+` (attach file = `@`),
`/` (commands), the current model pill on the left, the mode pill and the
send/stop button on the right. Below 640px (secondary sidebar) the compact
layout stays. The reference for the arrangement was a screenshot the user
supplied; all code, icons, mascot and copy are original to this project.

## D18. Slash commands are routed on the client
Kiro CLI V3 removed server-side slash command execution over ACP (the
migration guide maps each command to client behaviour, a standard method or
an advertised extension). `src/features/pure/slashCommands.ts` therefore
routes `/clear`, `/new`, `/cancel`, `/restart`, `/help` locally; `/usage`,
`/context`, `/compact` to `_kiro/account/getUsage`, `_kiro/session/context`,
`_kiro/session/compact` only when advertised in
`agentCapabilities._meta.kiro.extensionMethods`; `/model`, `/effort`,
`/mode` (`/agent`) to `session/set_config_option` / `session/set_mode`
using only advertised values; `/plan [text]` switches to a mode whose id or
name contains "plan" and then sends the text. Commands the agent itself
advertises (`available_commands_update`) are forwarded as prompt text;
anything else gets an "Unknown command" reply. Built-ins are merged into the
`/` popup after the agent's own commands. Results of extension calls are
shown as a local agent message (JSON pretty-printed) because their payload
shapes are not documented.

## D19. One agent process, many sessions, many views
ACP allows several sessions per process, so the extension keeps one
`kiro-cli acp` process and a map of `ChatSession` states (transcript, turn,
notices, opened diffs, title). Every webview (editor tab or sidebar) is a
*view* with its own displayed session; incremental messages go only to views
showing that session, while `connection`/`sessions`/`chips` go everywhere.
The controller also tracks a *focused* session (last used) for commands,
the plan document and the e2e API. New tabs prefer a fresh idle session; the
sidebar starts on the focused session (when that session may belong to its
group, see D20) and then keeps its own (revealing it focuses its session).
Closing a session cancels its turn and permissions; agent exit marks all
sessions `error`. Session titles come from the first prompt (≤ 40 chars)
until the agent reports one via `session_info_update`.

## D20. Sessions are grouped by tab; closing a tab ends its sessions
With several chat tabs open, every tab listed every session of the process,
which read as "the same chat four times". Each editor tab (WebviewPanel) is
therefore a session *group* (a fresh id per tab, also per restored tab), the
sidebar is the `sidebar` group, and sessions created without a view (the
auto-created first session, the API, tests) live in `default`. A grouped
view lists only the sessions of its group (`UiState.sessions`, the
`sessions` updates and their dedupe key are computed per group) and only
switches within it; `newSession` / `/clear` create in the sender's group;
a new tab takes a spare idle session of its own group or of `default`
(adopting it) and otherwise creates one. Plain `attach()` views have no group
and see everything, which keeps the test harness semantics. Closing a tab
closes every session of its group: their turns are cancelled, their pending
permissions rejected and the sessions dropped — a closed tab is gone, not
parked. Tabs are numbered (`Kiro Chat 1`, `Kiro Chat 2`, ...); a restored
tab keeps its saved title. When a permission request arrives while no chat
view is attached, the host opens a tab (or the sidebar) on *that* session
rather than a fresh one; the tab is still a group of its own and the session
moves into it (it does not join the session's old `sidebar` / `default`
group, so closing the tab later ends only the sessions it showed). A session
created for a tab that was closed while `session/new` was in flight is closed
as soon as it arrives, so no session lingers in a group nothing lists.

## D21. Past sessions are restored with `session/list` + `session/load`
When the agent advertises `loadSession` and `sessionCapabilities.list`
(`ConnectionView.canBrowseSessions`), the chat header shows a history button
and `Kiro: Open Past Session…` is available (palette, sidebar title). Both
call `ChatController.browsePastSessions(view?)`: `session/list` is filtered
by the workspace cwd (the first workspace folder) and only falls back to the
unfiltered list when nothing matches; sessions already live in this process
are excluded; the rest are offered in a QuickPick (title or id, relative
`updatedAt`, cwd). `openPastSession(sessionId, view?)` creates a *fresh*
`ChatSession` for that id in the requesting view's group (else the focused
view's, else `default`), displays and focuses it, shows a "Restoring
session…" notice and calls `session/load` with the workspace cwd. The
history the agent replays before answering is applied to that transcript
exactly like live updates — including the user chunks, which D13 only
suppresses for live turns — except that replayed tool calls open or reconcile
no diff editors, and their terminal content is never resolved against this
run's live terminals (the card keeps the replayed output, with no exit code;
see D9). The returned modes/config options/models are merged, the
title is the agent's (`session/list` title, later `session_info_update`) with
the first replayed user message as fallback, and the views showing the
session get a fresh `state` snapshot. If the load fails the placeholder
session is dropped, the view goes back to its previous session and a warning
notice says why. A restored session is an ordinary session afterwards
(prompts, permissions, close); closing it only forgets it locally — the
extension never calls `session/delete`, so the agent's history stays.
