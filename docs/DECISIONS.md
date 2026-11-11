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

## D22. Prompts typed during a turn are steered, else queued
The composer stays enabled while a turn runs (`UiState.acceptsPromptsDuringTurn`
is always `true`). Plain text sent mid-turn is echoed at once with a delivery
badge and handled one of two ways:

- **Steering.** The host calls the Kiro V3 extension method `_session/steer`
  with `{ sessionId, prompt: ContentBlock[] }` (the same blocks a
  `session/prompt` would carry, chips included) and badges the message
  `steering`. The badge clears when the session reports a
  `session_info_update` whose `_meta.kiro.kind` is `steering_injected` (the
  agent took the text into the running turn) or `steering_cleared` (it dropped
  it), or at the latest when the turn ends — the extension cannot tell which
  of several steered messages an update refers to, so all of them clear
  together. The reply to a steered prompt arrives inside the running turn as
  ordinary chunks; nothing else changes about the turn.
- **Queue fallback.** When the steer call fails (any `AcpError`: `-32601`
  method not found on CLI v2 or an agent without the method, `-32602` when the
  agent sees no turn, …) the message is re-badged `queued`, kept in the
  session's queue (`{ text, chips, messageId }` plus the prompt blocks built
  when it was typed) and `steerUnsupported` is remembered for that session so
  later mid-turn prompts queue directly instead of retrying. When the turn
  ends with any stop reason, `cancelled` included, the first queued prompt
  starts the next turn as a normal `session/prompt` (its badge clears, the
  message is not echoed again); the next queued one follows after that turn.
  Stop / `/cancel` ends the current answer only: the user queued those
  messages deliberately and expects them to run (changed 2026-11-11; until
  0.3.5 a cancel dropped the queue). A turn that failed or lost its agent,
  and closing the session (`/clear`, the tab's close), drop the whole queue:
  every badge clears and an info notice says "N queued message(s)
  discarded". Nothing is sent that the user did not see go.
- **Turn generation.** Each session counts turn starts and ends
  (`ChatSession.turnGeneration`, bumped in `runTurn` and `endTurn`). The
  steer call captures the generation before it goes out; its refusal marks
  `steerUnsupported` only when the generation is unchanged and the turn is
  still active. A refusal that lands after the turn ended — Stop, `/cancel`,
  an error, or a normal end while the agent was slow to answer — says
  nothing about steering support, so it leaves `steerUnsupported` alone; the
  message is still undelivered and the user typed it, so it is queued like
  any other (`enqueue` on an idle session drains at once: it becomes the
  next turn). A refusal for a session closed meanwhile (`/clear`) is
  ignored. (Until 0.3.5 such a message was dropped with the notice "Message
  not sent: the turn ended before it was delivered.")

Badge semantics in one line: `steering` = the agent has it, not yet acted on;
`queued` = still on the client, will go when the turn ends; no badge =
delivered (or discarded, in which case a notice said so).

Slash commands bypass the gate: `parseSlash`/`runSlash` run before the
turn-active check, so `/cancel`, `/help`, `/mode …`, `/usage` work while the
agent streams, and `/clear` mid-turn cancels the running turn and then opens
the new session. Only the "session is restoring" refusal (D21) still applies
to everything. Agent-advertised commands (`forward` routing) are prompt text
and are steered/queued like any other text. A pending permission request
does not block steering either — the steer request goes out while the
permission waits.

Caveat: neither the request shape nor the method name of `_session/steer`
has been confirmed against the real CLI — the parameters mirror
`session/prompt` as a guess, and the V3 capabilities recorded on 2026-11-10
(docs/protocol-notes.md) do not advertise `_session/steer` at all, so the
first real attempt may well land in the queue fallback. Every attempt is
logged to the **Kiro ACP** output channel as `[info] steer <sessionId>:
_session/steer {…}` followed by `accepted …` or `failed (<code>): …`; read
those lines to learn what the CLI expects, then fix `STEER_METHOD` / the
params in `src/ui/chatController.ts` (`promptDuringTurn`). The fake agent
implements the guessed shape (v3 only; v2 answers -32601).

## D23. Permission policies have three scopes and resolve the kind themselves
The real Kiro CLI V3 sends `session/request_permission.toolCall` *without*
`kind` (it carries only `toolCallId`, `title`, `status`, `content`), offers
only Allow / Deny / Always deny for `fs_write`, and attaches
`_meta.kiro.consent { capability, resource, persistableConsent }`. Keyed on
the request alone, the client policy (D6) therefore landed on `other` and
read "Always allow other this session". Two changes:

- **Kind resolution.** `PermissionManager.request()` takes the kind as
  `req.toolCall.kind ?? resolveKind(req.sessionId, toolCallId) ?? "other"`,
  where `resolveKind` (constructor option, wired in `extension.ts`) looks the
  tool call up in the transcript of the request's session only
  (`ChatController.toolCallKind(sessionId, toolCallId)`): the `tool_call`
  update that precedes the request always carries the kind, and tool call
  ids are only unique within a session (the fake agent reuses `call-nokind`
  for an edit and for an execute; a lookup across sessions would take the
  other session's kind and apply the wrong kind policy).
- **Scopes.** Policies are remembered per session under a key of one of
  three scopes (`src/features/pure/permissionPolicy.ts`): `kind:<kind>`,
  `cap:<capability>` (the consent capability) and
  `res:<capability>\u0000<resource>` — the consent resource qualified by the
  capability (empty when the request carries none), so "allow all changes
  to deploy.sh" (`fs_write`) never answers a `shell` request whose resource
  is the same path, and an `fs_read` rule never answers an `fs_write`. The
  resource is kept verbatim unless the subject is a file-system one — the
  capability is `fs_read`/`fs_write`, or without a capability the tool kind
  is `read`/`edit`/`delete`/`move` (`isFsResource`) — in which case an
  absolute path is normalised with `normalizeFsPath` so `a/../b.txt` and
  `b.txt` match; a shell command such as `/bin/echo x/../rm -rf target` is
  never collapsed. `decide()` consults resource, then capability, then kind
  — the most specific rule wins. `setPolicy(requestId, decision, scope =
  "kind")` records one; `clearPolicies(sessionId)` drops all scopes of a
  session. Every pending request carries the policies worth offering in
  `PermissionView.policies` with ready-made labels: always the kind ("Allow
  all edits this session"; nouns per kind, `other` → "actions of this
  kind"), the capability when present and different from the kind ("Allow
  all fs_write this session"), and the resource, worded by the capability
  (else the kind): "Allow all changes to <basename> this session" for
  `fs_write`/`edit`, "Allow reading <basename> this session" for
  `fs_read`/`read`, `Allow "<command>" every time this session` for
  `shell`/`execute`, and "Allow <capability> on <basename|resource> this
  session" for anything else. The webview sends `permissionAlways { scope }`;
  the default stays `kind`.

Why client-side: Kiro's own "Always deny" is a `reject_always` option and
its persistent consent (`_meta.kiro.consent { scope: "workspace", … }` on the
response) is not understood by this client (see protocol-notes), while an
"allow everything of this sort for the rest of the session" is exactly what
users want in a chat and needs no agreement from the agent — the policy
simply picks the agent's own `allow_once` option for later requests. Nothing
is persisted; a new session or restart starts clean (D6). To change the
precedence or add a scope, edit `SCOPE_PRECEDENCE` / `policyKey` in the pure
module and extend `PermissionScope` in `src/ui/protocol.ts`.

## D24. Mode, model and config options are remembered across sessions
Every new session started with the agent's defaults, so users re-picked the
same model (and mode) after each `/clear`. With `kiroAcp.rememberSessionOptions`
(default `true`), every change made through the pickers or the slash
commands (`setMode` / `/mode`, `setConfigOption` / `/model`, `/effort` …,
`setModel`) is written to `context.workspaceState` under
`kiroAcp.sessionOptions` as `{ modeId?, modelId?, configOptions: { id: value } }`
(per workspace, not per session). `/plan`'s implicit switch to the planner
mode is not remembered — it is a side effect of the command, not a choice.

They are applied on `session/new` only (`createSession`; never on
`session/load`, which restores the session's own state):

1. `_meta.kiro { modeId, modelId }` goes on the `session/new` request when
   remembered (`modelId` falls back to the remembered `model` config option),
   because Kiro V3 accepts these there. An agent may ignore `_meta`; should it
   reject the request, it is retried once without the hints so a stale id
   never blocks session creation.
2. Once the session state is known, each remembered config option is sent
   with `session/set_config_option` **only if** the agent advertises that
   option id, the value is one of its advertised values (or a boolean for a
   boolean option) and the current value differs; the mode with
   `session/set_mode` only if the id is advertised and differs; the v2 model
   with `session/set_model` likewise. Nothing the agent does not advertise is
   ever sent, so a model remembered from another account or CLI version is
   simply skipped. What was applied and what was skipped is logged to the
   **Kiro ACP** channel (`[info] session <id>: remembered options applied: …`).

`ChatController.rememberedSessionOptions()` / `forgetSessionOptions()` and
the command `Kiro: Forget Remembered Session Options` expose the store; the
`/capabilities` reply ends with "Remembered for new sessions: …". With the
setting off nothing is recorded or applied (the stored values stay until
forgotten). The fake agent ignores `_meta.kiro` on `session/new`, so the
e2e suite (F13) exercises the post-create `set_config_option` / `set_mode`
path; whether the real CLI honours the hints is unverified.

## D25. Sign-in is offered from any "not logged in" failure, with a terminal fallback
The real CLI does not advertise `authMethods` while a cached token exists; it
accepts `initialize` and `session/new` and only rejects `session/prompt` with
"Auth refresh callback failed: … You are not logged in. Please log in with
`kiro-cli login`" (see protocol-notes). Waiting for a `session/new` failure
with a non-empty `authMethods` (the previous rule) therefore left the user
with a red "Prompt failed" notice and no way to sign in from the chat.

Now any `session/new`, `session/load` or `session/prompt` failure that is an
auth error by code (`-32000`) **or by message** (`isAuthRequiredError`)
switches the connection to `auth_required`. When the agent offered no method,
the client offers `FALLBACK_LOGIN_METHOD` (`id: kiro-cli-login`, terminal,
`args: ["login"]`), which the existing terminal-auth path runs as
`<cliPath> login` in a VS Code terminal; the user confirms with **Reconnect**.
The fallback is accepted by `authenticate()` even while signed in, so
`/login` and the `Kiro: Log In` command work at any time (e.g. to switch
accounts). A prompt rejected this way logs to the output channel instead of
adding a notice: the sign-in banner already shows the agent's message and the
button.

After the terminal login the agent is respawned (`restart({ restoreSessions:
true })`): the sessions the chat views were displaying are loaded back with
`session/load` into the same views (D21), so signing in does not lose the
conversation; a session that cannot be restored falls back to a fresh one.
Whether the running process could instead pick up the new token without a
restart is unverified; the spec says to reconnect.

Independently, `kiroAcp.attachActiveFile` now defaults to `false`: the
implicit active-file chip surprised users (the file they happened to have
open was sent with every prompt). Files are attached explicitly with `@` or
**Send Selection**; the setting still enables the old behaviour.

**Addendum (0.3.5):** an agent-advertised terminal method's `args` are
appended to the *configured agent invocation* (`<cliPath> acp [cliArgs…]`),
as the ACP spec says. Kiro advertises `args: ["--login"]`, which is the
sign-in flag of the `acp` subcommand; 0.3.4 ran `kiro-cli --login` (executable
plus args) and the CLI rejected it. `runTerminalAuth` now receives the whole
invocation; only the extension's own fallback runs standalone (`kiro-cli
login`), because that is the command Kiro's error message names.

The sign-in process is the terminal's own process (`shellPath`/`shellArgs`,
a `.cmd` launcher wrapped in `cmd.exe`), not a line typed into a shell, so
its exit is observable: `onDidCloseTerminal` with exit code 0 (or a terminal
the user closed) resolves the login and the agent reconnects at once; a
non-zero exit fails it with the code. The "Reconnect" notification remains
the manual shortcut. `isTransient: true` keeps the terminal out of VS Code's
session restore.
