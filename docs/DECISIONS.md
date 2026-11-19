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
migration guide). Exception (D27): after Stop, a turn the agent has not ended
within 5 s is ended locally as `cancelled`; the late `session/prompt`
settlement is then ignored.

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

**Addendum (writes outside the workspace):** a write outside every
workspace folder asks first (modal: Write / Always allow in <folder> /
Deny). Kiro writes scratch files to the system temp folder, and asking for
each one was constant noise ("VS Code keeps complaining that Kiro writes to
temp"), so `kiroAcp.fs.allowedWriteRoots` lists folders that never ask,
by default `${tmpdir}`. Entries expand `${tmpdir}`, `~`/`${home}` and
`${env:NAME}`; one whose variable is missing or that is not absolute is
ignored, so a missing variable can never widen the list. The setting has
`machine` scope: a repository's `.vscode/settings.json` must not be able to
let the agent write anywhere without asking. **Always allow** appends the
file's folder to the user setting. Reads are not restricted (D8 is about
writes; reading outside the workspace never asked).

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

**Superseded in part by D31 (2026-11-19):** the "one `kiro-cli acp` process"
part. A process runs one turn at a time, so every session now gets a process
of its own behind the same `KiroAgent` facade; the views, groups, focus and
per-session state above are unchanged. "Agent exit" now means the whole pool
stopping (or `Kiro: Restart`); one process exiting ends only its sessions.

## D20. Sessions are grouped by tab; closing a tab ends its sessions
With several chat tabs open, every tab listed every session of the process,
which read as "the same chat four times". Each editor tab (WebviewPanel) is
therefore a session *group* (a fresh id per tab, also per restored tab), the
sidebar is the `sidebar` group, and sessions created without a view (the
auto-created first session, the API, tests) live in `default`. A grouped
view lists only the sessions of its group (`UiState.sessions`, the
`sessions` updates and their dedupe key are computed per group) and only
switches within it; `newSession`, `/new` and `/clear` create in the sender's
group (`/clear` then forgets the session it replaces, so the tab starts over
with one clean session; `/new` keeps the old one in the list);
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
  discarded". A session being closed or replaced is flagged `closing` and
  its queue is discarded *before* its turn is cancelled, so the cancel's
  own end-of-turn cannot drain a queued prompt into the session the user is
  leaving, and a late steer refusal for it is dropped silently (revmux
  round 14). A prompt typed while `/clear` still awaits `session/new` would
  resolve to the closing session (the view switches only when the new one
  exists); `prompt()` therefore waits for `ChatSession.replacement` and
  re-sends to the new session (revmux round 15). `/new` no longer touches
  the session it leaves behind. Nothing is sent that the user did not see
  go.
- **Real CLI (2026-11-11).** `_session/steer` answered `-32603 Internal
  error` on Kiro CLI V3; the message was queued as designed. Whether the
  method exists with another parameter shape is unknown
  (`docs/protocol-notes.md`); steering stays opportunistic.
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
agent streams, and `/clear` mid-turn discards the queue, cancels the running
turn and then opens the new session (`/new` just opens one alongside). Only the "session is restoring" refusal (D21) still applies
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
true })`): every live session with a conversation is loaded back with
`session/load` (D21) into its group, so signing in loses neither the
conversation a tab shows nor the others in its session list (see the 0.3.11
addendum); a view whose session cannot be restored gets a fresh one.
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

**Addendum (0.3.11):** the restart restored only the session each view
*displayed*. A tab holding several sessions came back with just the one on
screen, and the new process's own first session sat in the focused tab as an
extra empty "New session". A user who signed in again from one tab reported
"only the tab I signed in from is left, the others closed": the other
sessions of the tab's list were gone. `restorePlan()` now takes every live
session with a conversation (empty ones are not worth a `session/load`, and
sessions still restoring or closing are left out). The focused session goes
first, then the displayed ones, then the rest. `restoreSessions()` loads them
one at a time (since D31: four at a time, each into a process of its own)
into their old group, each view showing its own session again,
and keeps each `updatedAt` so the list order survives. With anything to
restore, the new process opens no first session (`startOnce(false)`). Views
still without a session then get a fresh one, and focus returns to the
focused view's session. A session the agent cannot load is named in a
warning in its tab; in a group no view lists, it only gets an output-channel
line. A tab closed during the restore gets nothing back (`closedGroups`).
Once the agent stops being ready, the remaining sessions are left for Past
sessions. The fake agent's session ids now differ per process, as UUIDs do,
so a restarted fake cannot hand out an id the old process used.

## D26. Context and token usage come from whatever the agent reports
The header shows a usage pill ("42% ctx · 12k tokens", tooltip with the
exact numbers) once anything is known about the displayed session. The
numbers are folded by the pure `applyUsageUpdate` (`src/features/pure/usage.ts`)
from three sources, in whichever order they arrive:

- ACP `usage_update` (`used` / `size` tokens in context, optional `cost`):
  sets the context numbers and the percentage.
- Kiro V3 `session_info_update` with `_meta.kiro.kind = "context_usage"`:
  `usagePercentage` (the only field Kiro documents) sets the percentage;
  token counts under a few plausible names are read when present.
- Kiro V3 `session_info_update` with `_meta.kiro.kind = "turn_completion"`:
  `promptTurnSummaries` is the turn's metering; every numeric `...tokens`
  field (or `totalTokens` when present) is summed and added to the session's
  running `tokensSpent`. Its real shape is not documented, so the first
  `turn_completion` meta of each session is written to the Kiro ACP output
  channel for recording in `docs/protocol-notes.md`.

Only changes are posted (`{ type: "usage" }`), the snapshot carries the
current value, and a new session starts with nothing (no pill). Nothing is
estimated client-side: when the agent reports neither, the pill stays
hidden rather than guessing from text length.

**After-turn poll (0.3.7).** On the real CLI no `context_usage` had shown
up by the end of a long session, so when a turn ends and the session still
has no percentage, the controller calls the advertised `_kiro/session/context`
(`pollContextUsage`, after each turn until a percentage is known) and reads
its reply defensively
(`contextFromResult`: the usual keys at any depth, then "42%" / "84k of 200k
tokens" in its text). The first reply per session and one example of every
`session_info_update` kind are logged to the Kiro ACP channel, so the real
shapes can be recorded. An agent that rejects the method is not polled again
until the next restart. The fake agent reports 7% for a session that never
announced a `context_usage`; its reply also counts the calls, which e2e
F15.2 checks through `/context`.

Stop on POSIX: commands run in their own process group (`detached`), and the
kill signals the group (SIGTERM, SIGKILL two seconds later when still
alive), so a service started by the shell dies with it; Windows already
used `taskkill /T /F`.

## D28. A view that becomes visible again gets no snapshot
Switching chat tabs took seconds on a long session: every
`onDidChangeViewState` (and the sidebar's `onDidChangeVisibility`) posted a
full `state` snapshot, i.e. the whole transcript with the output of every
terminal (up to 1 MB each), and the webview's transcript renderer memoises
by object identity, so a snapshot re-rendered every message (markdown and
all) and every tool card, then jumped to the bottom. Both hosts keep the
webview alive while hidden (`retainContextWhenHidden`), and VS Code delivers
posts to a retained hidden webview, so the view's state is already current
when it shows again. The snapshot on visibility is gone; a reloaded webview
(VS Code restart, panel serialisation) still asks for one with `ready`, and
a session switch still gets `session` + `state` (`postSessionState`).

## D27. Stop is local-first: kill the session's commands, then end the turn without the agent
A real session hung for an hour at "thinking": the agent had started a
service (`run_service_sit.bat`) through `terminal/create` and was waiting in
`terminal/wait_for_exit` for a process that never exits; `session/cancel`
did not get it out of that wait, and kiro-cli's stderr showed its backend
calls failing with `HTTP 407 Proxy Authorization Required` meanwhile. Only
the `session/prompt` response ends a turn (D5), so the UI stayed "working"
and Stop looked broken.

Stop (`cancel()`) therefore does three things:

- sends `session/cancel` as before;
- kills every command still running for the session
  (`TerminalService.killSession`: `taskkill /T /F` on Windows, SIGTERM
  elsewhere): their `wait_for_exit` resolve, so an agent blocked on one can
  honour the cancel and answer `cancelled` itself (e2e F12.9). Stop means
  the running command too; the terminal stays valid for output/wait like
  after `terminal/kill`;
- arms a watchdog (`CANCEL_GRACE_MS` = 5 s): when the turn is still active,
  it is ended locally as `cancelled` with a notice ("Kiro did not confirm the
  stop…"). `runTurn` compares the session's turn generation when the
  `session/prompt` promise finally settles and ignores a late answer (e2e
  F12.8, F12.10). The queue is kept (Stop never discards it, D22). Until
  that late settlement arrives the session is flagged `abandonedTurn`:
  streamed updates that reach it while no turn runs are that turn's late
  output and are dropped (logged once). Updates that arrive while a *new*
  turn already runs cannot be told apart (ACP updates carry no turn id) and
  are shown; that needs an agent that ignores the cancel for over 5 s and
  then resumes streaming into a session that has moved on.

Diagnostics that come with it: the working strip shows "no reply for N min"
from `UiState.lastActivityAt` (the snapshot carries `ChatSession.updatedAt`,
so a re-sent snapshot keeps the counter; the webview reducer restamps it on
the session messages that changed its state and clears it on a session
switch), every Kiro ACP log line starts with the local time
(`src/ui/stampedOutput.ts`), and `[ERROR]` lines on kiro-cli's stderr
are turned into one notice per distinct error per minute in every session
whose turn is running (`noteAgentStderr`). Unknown agent requests are logged
with their params (`_kiro/terminal/shell_type` was seen and answered
`-32601`, as the Kiro docs require).

## D29. Images are composer attachments sent as ACP `image` blocks
Kiro CLI advertises `promptCapabilities.image` (protocol-notes), and ACP
forbids `image` blocks unless the agent does, so the composer offers images
only when `ConnectionView.acceptsImages` is set, and the host refuses a
prompt carrying images otherwise (with a notice; nothing is sent).

- **Where they live.** Pasted images have no path, so attachments belong to
  the composer (webview), like the draft text, not to the host's
  `ContextTracker`. Files picked with the button (`pickImages`, an open
  dialog) or dropped as a VS Code uri-list (`dropFiles`) are read by the
  host and handed back to the requesting view (`imagesAttached`); the
  composer then owns them too. They travel with the `prompt` message as
  `ImageAttachment`s (base64). They are not persisted in the webview state
  (megabytes per image); a reload drops them.
- **Rules** (`src/ui/images.ts`, shared by both bundles): PNG, JPEG, GIF and
  WebP (what the Claude-family models behind Kiro accept), at most 5 MB each
  and 10 per prompt. Both sides judge an image by its bytes with the same
  code (`imageDataVerdict`: magic-byte sniffing wins over the declared type
  or extension): the webview on attach, so a renamed AVIF or text file never
  becomes a tile, and the host again on send, before anything is echoed, so
  a rejected prompt leaves no half-sent trace. The send check only catches
  what slipped past the composer (agent capability lost meanwhile, a prompt
  from the API), since Send clears the composer before the host answers.
  Images are not downscaled: what the user attached is what Kiro gets.
- **Paste.** Images are attached only when the clipboard has no plain text:
  Excel and Word put a bitmap next to the text, and the text is what the user
  means there; screenshots and "copy image" from a browser carry no text.
- **Block order:** text, images, then the context chips (D10), the same
  order as the echo.
- **Display.** The echo (D13) shows the webview's thumbnail (longest side
  ≤ 320 px; WebP, PNG where the canvas cannot encode WebP), so transcript
  snapshots stay small. Without a thumbnail (it could not be made, or the
  prompt came from the API) the echo shows the image itself only up to
  512 KB of base64 (`MAX_INLINE_PREVIEW_CHARS`), else an `[image]` chip; the
  same bound applies to image blocks the agent sends or replays
  (`session/load`). Every `src` is a
  `data:` URL of an accepted type, checked on the host and again in the
  webview (the CSP already allows only `data:` and local images).
- **Slash commands:** `/plan <text>` and agent commands forward the images
  with the text; a command the extension handles itself (`/help`, `/mode`,
  …) does not send them, and a notice says so.

## D30. Agent link: sessions reach each other through an MCP server on loopback
Agents in different tabs should see (later: read, message, wait for, start)
each other, the way agents in agterm tabs do through `agtermctl` and a unix
socket. Plan: `docs/plans/2026-11-13-agent-link.md`. Stage 1 ships the
transport and one read-only tool, `list_sessions`, behind
`kiroAcp.agentLink.enabled` (off by default until the real CLI is checked).

- **MCP, not a CLI in the terminal.** agterm gives each shell
  `$AGTERM_SESSION_ID` and a CLI. Our agent's commands run in our terminal
  too, so an env var + CLI would work, but the agent would have to be taught
  the CLI, every call would be a shell command (with its own permission
  prompt and output parsing), and Windows quoting gets in the way. MCP tools
  are what the agent already knows how to discover and call, with a schema.
  ACP lets the client hand MCP servers to a session (`mcpServers` on
  `session/new` / `session/load`), and Kiro CLI V3 advertises
  `mcpCapabilities: { http, sse }`, so no Kiro configuration is touched.
- **HTTP on 127.0.0.1, port 0, stateless.** `src/agentLink/server.ts`
  speaks the Streamable HTTP transport with JSON replies only (no SSE
  stream, no `Mcp-Session-Id`): `POST /mcp`, one JSON-RPC message per
  request; `GET`/`DELETE` are 405. No new dependency (`node:http`); the
  dispatch (`protocol.ts`) is pure and unit-tested. The server starts with
  the first session that gets it and stops when the setting is turned off
  or the extension deactivates. The extension still makes no outbound
  network calls; it listens on loopback for kiro-cli only.
- **Who is calling: one bearer token per session.** The token is minted
  before `session/new` (the session id is not known yet) and bound when the
  agent answers; for `session/load` it is minted bound. A `tools/call` on a
  token not yet bound waits up to 10 s for the bind. Closing a session,
  `/clear`, a restart or turning the setting off revokes its token. A tool
  call therefore always knows its session, the way `AGTERM_SESSION_ID`
  tells agterm. **[unverified]** whether Kiro keeps the servers of
  different sessions apart when they share a name (protocol-notes).
- **Guards.** Unknown, missing or revoked token, a `Host` other than
  `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding) or any `Origin`
  header (a browser) is refused with **403, never 401**: a 401 can make an
  MCP client start an OAuth discovery, and Kiro has an OAuth flow for MCP
  servers. Bodies are capped at 1 MiB. Tokens are never logged.
- **An agent that refuses the server never blocks a session.**
  `session/new` is retried without the server (then without the remembered
  hints, D24), and once the agent accepted a session only without it, the
  server is not offered again until the agent restarts. `session/load` is
  not retried: a failed load may already have replayed history.
- **Addressing.** Sessions are named by a short handle (`s<creation
  order>`), their title and the tab title ("Kiro Chat 2", "Sidebar"); the
  ACP session id stays inside the extension.
- **Delivery (stage 2) goes through the queue of D22**, never through
  `_session/steer`: an idle target starts a turn, a busy one shows the
  message as *queued* and gets it when its turn ends. Unlike agterm we know
  exactly when a turn ends, so "wait for the other agent" needs no screen
  scraping.

### D30 addendum: stages 2–4 — reading, messages, waits, new sessions (2026-11-19)

The same server gains `read_session`, `send_message`, `wait_for_session` and
`start_session` (plan Tasks 8–11; README "Agents talking to each other").
Still behind `kiroAcp.agentLink.enabled`, off by default.

- **Framing.** The receiving chat shows the sender's raw text as a user
  message carrying `origin` (sender's session id, handle, title): a "from s2 ·
  “title”" header that reveals the sender when clicked, and its text rendered
  as markdown like an agent message (an agent wrote it; the user's own
  messages stay plain text). The receiving *agent* gets
  `framePeerMessage(...)` (`src/agentLink/peerMessage.ts`): a header naming
  the sender (handle, title, tab) and saying it is not the user's
  instruction, the chain position from the second message on, the text
  verbatim, and a footer saying how to reply (`send_message` to the sender's
  handle) and not to reply just to acknowledge. The server `instructions`
  name the header's prefix, so the model can tell peer messages from its
  user.
- **Delivery** is the D22 queue: an idle target starts a turn (`started`),
  a busy one (a turn running or prompts queued) gets the message badged
  *queued* and runs it when its turn ends (`queued`). Never `_session/steer`:
  another agent's request must not slip into the turn the user is watching,
  and the queue keeps the order and the "done" signal exact.
- **Chain depth, per turn.** A turn the user started has depth 0; a turn a
  peer message started has the sender's depth + 1 (carried through the queue
  in `QueuedPrompt.depth`). `send_message` / `start_session` from a turn
  whose depth already equals `kiroAcp.agentLink.maxChain` (default 6) is
  refused with `chain_limit`, and both chats get one notice per turn, since
  the agents will not tell their users. Anything the user types starts at 0
  again. Depth is a better guard than a per-pair counter: it also stops
  A → B → C → A rings.
- **Rate.** 10 messages (sends and starts together) per sender per sliding
  minute; only an attempt that passed the other checks counts, a declined
  one too (each asked the user). The order of the checks: self, paused,
  empty, over 32 KiB, chain, rate, then the confirmation.
- **Confirmation as a synthetic permission card, isolated from policies.**
  `kiroAcp.agentLink.confirm` (`firstPerPair` default / `always` / `never`;
  like `maxChain`, scope `machine`, so a repository's `.vscode/settings.json`
  cannot switch the consent off or lengthen chains, as for D8's write roots)
  asks in the *sender's* chat through `PermissionManager.request` (kind
  `other`, options "Send" `allow_once` / "Don't send" `reject_once`,
  `_meta.kiro.consent.capability` `agent_link_message` /
  `agent_link_start_session` as a label), so it renders, resolves on Stop
  and makes the sender `needs_input` like any request, and is also kept as a
  local tool call in the sender's transcript (a `state` snapshot only renders
  cards of tool calls it knows; the call ends completed / failed "Not
  sent."). It is a **`local` request**: no session policy answers it, none
  is offered on it (`policies: []`, which the webview now renders as no
  "always" buttons rather than the legacy kind pair) and `setPolicy` refuses
  it. Otherwise a "kind other" rule chosen on one of Kiro's own cards (an MCP
  tool call, say) would send peer messages unasked, and an "Allow all actions
  of this kind" on the card would approve Kiro's own `other` tool calls.
  `firstPerPair` remembers an allowed (sender, target) pair until either
  closes; that memory is the card's only "always". Starting a session asks
  unless the mode is `never`.
- **Waits.** `wait_for_session` resolves at once when the target is idle
  (no turn, nothing queued, not restoring) or waits for its user (a pending
  permission request); otherwise a waiter is re-checked whenever a turn,
  queue or permission changes, after the synchronous work settles (a turn
  that ends may start the next queued one at once). It ends `closed` when
  the target goes away or the agent dies, `timeout` after `timeoutSeconds`
  (default 120, at most 600), and is dropped when the caller's tool call
  goes away (Stop in the caller aborts kiro-cli's HTTP request, the server
  aborts the call) or the caller's session closes (its grant is revoked,
  which now aborts the grant's running calls). The result carries the
  target's last agent answer (≤ 8000 characters, its end).
- **Start.** `start_session` passes the same gates and asks, creates the
  session and delivers the prompt as a peer message from the caller (so its
  title and its chain depth come from it). `sameTab` creates it in the
  caller's group without switching the caller's view; `newTab` opens a chat
  tab on it without taking the focus (the caller's tab stays in front).
  A caller that closed, or a Stop, while `session/new` ran closes the new
  session again: nobody would learn its handle.
- **Pause.** `Kiro: Pause Agent Messages` (not persisted) drops the queued
  peer messages of every session (the usual "N queued messages discarded"
  notice; what the user queued stays) and refuses send / start with `paused`
  until `Kiro: Resume Agent Messages`; running turns go on. `/capabilities`
  lists the tools, the chain limit, the confirmation mode and the pause.
- **Handles across a restore.** A sign-in restore (D25) carries each
  session's handle in its `RestoreEntry`, so the agents keep addressing it
  by the same name; a past session opened by the user gets a new one.
  Handles are never reused within a window (`s<seq>`, the counter only
  grows).
- **Known limits.** `session/load` replays a peer message as the framed text
  the agent got, without `origin` (the replay is the agent's history; the
  frame could be parsed back into an origin, see the plan's follow-ups).
  Kiro may ask its own permission for the MCP tool call as well, so a first
  message can show two cards (Kiro's, then the confirmation).
  **[unverified]** every stage-2–4 tool against the real CLI
  (protocol-notes, "Agent link").
- **One turn at a time per process, solved by D31.** On 2026-11-19 a
  signed-in CLI ran one turn at a time for all the sessions of its one
  process, so a message "started" in another session only ran once the
  sender's turn ended, and a `wait_for_session` from inside a turn could
  only time out. Since D31 every session has a process of its own: the
  target runs while the sender waits (e2e F19.7, against the fake agent
  with `--serial-turns`). With `kiroAcp.agentProcesses.max = 1`, or past the
  limit when sender and target share a process, the old limit is back
  (F19.9).

## D31. One kiro-cli process per session (agent pool)
On 2026-11-19 (0.3.12, signed in) three tabs were prompted at once: one
answered, the other two showed "no reply for 33 min". The extension sends
every `session/prompt` at once; the CLI runs **one turn at a time per
process**, and `kiro-cli acp --help` has no option for more. The agent link
(D30) hits the same wall: a `wait_for_session` from inside a turn can never
see its target run when both share the process. The user decided: one
process per session. Plan: `docs/plans/2026-11-19-process-per-session.md`.

- **A pool behind the same facade.** `AgentPool` (`src/acp/pool.ts`)
  implements `KiroAgent` over several `KiroAgentImpl` processes, so the
  agent calls themselves look as before; the controller holds an
  `AgentPool` (not just a `KiroAgent`) because it also uses what only the
  pool has: `releaseSession`, `processes()`, `maxProcesses`. Session-scoped
  calls (prompt, cancel, mode, config option, model, an extension call whose
  params name a `sessionId`) go to the process hosting the session;
  process-wide calls go to the spare, else any ready process — except
  `authenticate`, which goes first to the process that asked for the
  sign-in (it offered the methods the banner shows, and only it turns back
  to ready), and the later pages of one `session/list`, which go back to the
  process that issued the cursor (a cursor is that process's; when it is
  gone the call fails with "cursor expired … list again from the start"
  instead of asking another process). A `session/load` of an id that a newer
  load of the same id overtook is returned unbound and its process let go,
  so a session closed and opened again while its first load ran keeps the
  newer process. The client services (fs, terminals,
  permissions) were already keyed by session id and are shared. A process's
  own log lines carry `process N:`; the pool logs every spawn, assignment,
  release and exit (`agent-pool: …`).
- **A warm spare.** Starting the agent starts one process, the spare; the
  connection is ready once it answered `initialize`, and its `AgentInfo` is
  what the banner, the capabilities and `/capabilities` show (every process
  runs the same CLI). `session/new` and `session/load` take the spare and
  warm the next one in the background, so a new session opens as fast as
  with one process.
- **A limit, then sharing.** `kiroAcp.agentProcesses.max` (default 8, 1–32,
  the spare included) bounds the processes. Past it a new session shares the
  process with the fewest sessions, and there sessions take turns again.
  `1` is the old single shared process. Read at every start; `Kiro: Restart
  Agent Process` applies a change. `/capabilities` lists `Processes: N
  running (max M)` and one line per process (number, pid, its sessions'
  handles or `spare`).
- **Memory.** Every process is a whole kiro-cli (its runtime, its MCP
  servers and their children); the cost per process and its start time are
  **[unverified]** (protocol-notes). Eight covers a few tabs with a couple of
  sessions each. A session that closes (also `/clear` and a failed restore)
  releases its process (`releaseSession`), which stops unless it becomes the
  spare.
- **Failure isolation.** A process that exits on its own ends only its own
  sessions (`SessionEvent` `process_exited`); the pool, the connection
  banner and every other session go on, and a new spare warms up. Only the
  pool as a whole failing (no spare can start) or being stopped is "the
  agent went away" (every session `error`, Restart). Each session of the
  dead process: its turn ends, its queue is dropped (the usual notice), its
  permission requests are cancelled, the commands it still runs are killed
  (no agent is left to release them), its agent-link token is revoked, and
  one notice says "Kiro's process for this session exited (…). Your next
  message loads the session again in a new process." (an error when it cut
  a turn short, else a warning). On Windows the turn's `session/prompt`
  rejects ("ACP connection closed") *before* the exit event arrives: the
  exit notice replaces that "Prompt failed" when it comes within 5 s with no
  turn in between, so the user sees one notice. A `wait_for_session` on such
  a session ends `idle`, as after any failed turn: the session can be
  messaged again.
- **Transparent reload.** The session keeps its `ChatSession` (transcript,
  handle, notices, place in the list), marked `processLost`. Its next turn —
  a message the user sends, a queued one, a peer message — and a mode /
  model / option change or a slash command that asks the agent first
  `session/load` it into a new process, with a new agent-link token bound to
  its id; the history the agent replays is dropped, the transcript shows it
  already. Meanwhile the turn shows as running and text typed into it queues
  (there is no process to steer). Stop ends that turn locally: the load goes
  on, the prompt is not sent. A load that fails says "Could not load this
  session into a new Kiro process: …" (the message is not sent); the
  session stays marked and the next message tries again. An empty session
  whose process exited is not handed to a new tab as its first session.
- **Parallel restore.** A sign-in restart (D25) loads up to four sessions
  at once, each into a process of its own. They start in the plan order
  (focused, displayed, the rest), each `ChatSession` is created and the
  focused one focused when its load starts, and every session keeps its old
  `updatedAt`: order and focus come out as before, whichever load ends first.
- **Kept as it was.** `auth_required` from one process (its prompt was
  rejected as signed out) switches the whole connection to the sign-in
  banner and blocks prompts in every session; signing in restarts the pool
  and restores everything. kiro-cli stderr errors (D27) still reach every
  session with a running turn: a stderr line does not tell the controller
  which process printed it, and throttling per process would be needed
  before narrowing it (a proxy error usually hits every process anyway).
- **Limits.** Closing a session mid-turn stops its process right after
  `session/cancel`; whether Kiro saved the cancelled turn first is
  **[unverified]**. Whether one process's `session/list` sees sessions
  another process created, whether `session/load` works for a session still
  live in another process, and how Kiro's session store takes concurrent
  writes are **[unverified]** (protocol-notes, D31 checklist). The fake agent
  keeps sessions in memory per process: only its canned past sessions load
  into another process, so the e2e tests (F19) reload those; a fresh fake
  session cannot be loaded elsewhere, which F19.4 uses for the failure path.
- **Closing stops the commands.** An agent's terminal commands are children
  of the extension host, not of `kiro-cli`, and a closed session's process
  is stopped right after `session/cancel`, before it could release them; so
  closing a session (and ending every session on restart) kills its running
  commands, as Stop does (D27).
- **How to change.** `kiroAcp.agentProcesses.max = 1` brings the shared
  process back (an exit is still handled per session: the one process dying
  ends every session, and each reloads on its next message). Dropping the
  pool altogether is not a one-line change: the controller uses the pool's
  own API (`releaseSession`, `processes()`, `maxProcesses`); setting the
  limit to 1 is the supported way back.
