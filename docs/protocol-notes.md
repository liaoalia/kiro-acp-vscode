# Protocol notes: ACP as spoken by Kiro CLI

Sources: ACP spec (https://agentclientprotocol.com, protocol v1), the ACP
TypeScript SDK 2.5.0 (`@agentclientprotocol/sdk`, Apache-2.0), Kiro docs
(https://kiro.dev/docs/cli/acp/ and https://kiro.dev/docs/cli/v3/acp-migration/),
and – where marked **[recorded]** – a raw exchange captured from the installed
`kiro-cli` with `scripts/record-acp.mjs`.

> **Status:** the sections marked **[unverified]** come from documentation
> only. `kiro-cli` was not installed on the development machine when this
> extension was written (the native Windows installer run was blocked in the
> automated session), so the real `initialize` exchange has not been captured
> yet. Run `node scripts/record-acp.mjs --prompt "hello"` after
> `kiro-cli login` and paste the result into the **Recorded exchange** section.

## Launch

- Command: `kiro-cli acp [--agent-engine=v2|v3]`. Newline-delimited JSON-RPC 2.0
  over stdio, one object per line. Kiro CLI ≥ 3.0 starts the **V3** harness for
  `acp` on Windows/macOS unless `--agent-engine` or the `acp.agentEngine`
  setting says otherwise. V2-only flags (`--agent`, `--model`, `--effort`,
  `--trust-all-tools`, `--trust-tools`) keep the run on v2 and are rejected by V3.
- Both engines negotiate ACP `protocolVersion: 1`; the engine cannot be
  detected from the protocol version. The extension never branches on engine,
  only on advertised capabilities.
- Logs: `$TMPDIR/kiro-log/kiro-chat.log` (macOS), `$XDG_RUNTIME_DIR/kiro-log/`
  (Linux); `KIRO_LOG_LEVEL=debug`, `KIRO_CHAT_LOG_FILE=<path>`.

## initialize **[unverified]**

Request sent by this extension:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true },
    "terminal": true,
    "auth": { "terminal": true },
    "_meta": { "kiro": { "openExternalUrl": true }, "terminal-auth": true }
  },
  "clientInfo": { "name": "kiro-acp-vscode", "title": "Kiro ACP Chat for VS Code", "version": "0.1.0" }
}
```

Documented response (Kiro docs example, CLI v2):

```json
{
  "protocolVersion": 1,
  "agentCapabilities": { "loadSession": true, "promptCapabilities": { "image": true } },
  "agentInfo": { "name": "kiro-cli", "version": "…" }
}
```

CLI V3 additionally advertises `agentCapabilities._meta.kiro.extensionMethods`
(array of `_kiro/...` request methods such as `_kiro/session/context`,
`_kiro/session/compact`, `_kiro/account/getUsage`, `_kiro/mcp/resetServer`,
`_kiro/workflow/*`). The extension stores this list and only calls methods in it.

### Authentication (CLI ≥ 2.37)

When signed out, `initialize` succeeds and returns one `authMethods` entry;
every other request returns an authentication-required JSON-RPC error. Because
we declare `auth.terminal: true` (and the pre-standard
`_meta["terminal-auth"]`), the method is a `type: "terminal"` one named
"Log in to Kiro" carrying `args`/`env`. **Verified 2026-11-11 on the real
CLI:** the method's `args` are `["--login"]` and, per the ACP spec, they are
*appended to the configured agent invocation*: the client must run
`kiro-cli acp [cliArgs…] --login` (the sign-in flag of the `acp` subcommand,
documented as "run the Kiro sign-in in the terminal, then exit without
starting the server"). Running `kiro-cli --login` (executable + args, without
`acp`) is an error; 0.3.4 did that, fixed in 0.3.5. The standalone
`kiro-cli login` subcommand also works and is what the extension's own
fallback method runs. After the terminal login completes the client must
**reconnect** (spawn a new process). The exact error code is **[unverified]**; the extension treats any
`session/new` failure while `authMethods` is non-empty as "auth required".

**Observed 2026-11-11 (Kiro CLI 3.x, V3, cached token expired):** `initialize`
returned **no** `authMethods`, `session/new` succeeded, and the first
`session/prompt` failed with the JSON-RPC error message
`Auth refresh callback failed: Internal error: You are not logged in. Please log in with `kiro-cli login`.`
(code not captured). So "signed out" cannot be detected from `initialize`
alone: `isAuthRequiredError` (`src/acp/types.ts`) also matches the message
(`not logged in`, `kiro-cli login`, `authentication required`, …) on
`session/new`, `session/load` and `session/prompt`, and when the agent offered
no auth method the client synthesises the terminal method `kiro-cli-login`
(`<cliPath> login`) so the chat can still show a login button (D25).

## Sessions

- `session/new` `{ cwd, mcpServers: [] }` (+ optional `additionalDirectories`,
  `_meta.kiro: { modeId, modelId, effortLevel }` on V3). Response: `sessionId`,
  optional `modes { currentModeId, availableModes[] }`, optional
  `configOptions[]` (V3: ids `model`, `effortLevel`, possibly `mode`).
  CLI v2 may return the unstable `models { currentModelId, availableModels }`
  and accepts `session/set_model` **[unverified]**.
- `session/load`, `session/list`: supported by V3; out of scope for this extension.
- V3 does **not** implement `session/set_model`; use
  `session/set_config_option { configId: "model", value }`.

## Prompt turn

- `session/prompt { sessionId, prompt: ContentBlock[] }` → `{ stopReason }`.
  The Kiro docs page shows `content` instead of `prompt` in one example; the
  spec and SDK use `prompt`. **[to confirm against the recorded exchange]**
- Updates arrive as `session/update { sessionId, update: { sessionUpdate, … } }`
  with `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`, `plan`, `available_commands_update`,
  `current_mode_update`, `config_option_update`, `session_info_update`.
- V3-specific `session_info_update._meta.kiro.kind` values: `context_usage`
  (`usagePercentage`), `turn_completion`, `steering_queued`,
  `steering_injected`, `steering_cleared`, `turn_end`. **`turn_end` is not a
  completion signal** – only the `session/prompt` response ends a turn.
- Usage (D26): the extension reads ACP `usage_update` (`used`, `size`, `cost`), `context_usage`
  (`usagePercentage`) and `turn_completion` (`promptTurnSummaries`: token fields summed). The
  `turn_completion` shape is undocumented; the first one per session is logged as
  `[info] session <id> turn_completion meta: ...` in the Kiro ACP output channel - **paste one here**.
- `_meta.kiro.replay: true` marks replayed updates; `_meta.kiro.failureReason`
  on failed tool calls is `cancelled` | `denied` | `error`.
- Content-filtered responses end with `stopReason: "refusal"` (v2).
- `session/cancel` is a notification; the agent then answers the pending
  prompt with `stopReason: "cancelled"`. The client answers pending
  `session/request_permission` requests with `{ outcome: "cancelled" }`.

### Steering **[unverified]**

- **Real CLI, 2026-11-11:** `_session/steer { sessionId, prompt }` during a
  turn answered `-32603 Internal error` (not `-32601`): the method is
  dispatched but fails. The parameter shape may be wrong; the message was
  queued and sent after the turn, as designed (D22).

- The extension sends a prompt typed while a turn runs as the extension
  request `_session/steer { sessionId, prompt: ContentBlock[] }` (the method
  keeps its `_session/` prefix, like `_session/terminate`; it is **not**
  `_kiro/…`). The parameter shape mirrors `session/prompt` and is a **guess**:
  the real CLI has not answered it yet, and the capabilities recorded below
  (2026-11-10) do not list it among the advertised extension methods. The
  **Kiro ACP** output channel logs every attempt (`[info] steer <sessionId>:
  _session/steer {…}` then `accepted …` / `failed (<code>): …`); use it to
  record the real request/response here.
- Expected replies: `{}`-ish on success, `-32601` when the engine has no such
  method (CLI v2), `-32602` when there is no turn to steer. Any error makes the
  extension queue the message until the turn ends (DECISIONS D22).
- The agent reports progress through `session_info_update` with
  `_meta.kiro.kind` = `steering_queued` (accepted, waiting for the next model
  round trip), `steering_injected` (now part of the turn; the extension clears
  the `steering` badge) or `steering_cleared` (dropped; badge cleared too).
  The injected text's answer arrives as normal `agent_message_chunk`s of the
  running turn; the `session/prompt` response still ends the turn.

## Observed on the real CLI (2026-11-11, V3)

- `_kiro/sessions/changed` notifications carry `upserted[]` entries with
  `sessionId`, `title` (the agent names the session after the first prompt,
  e.g. "Настроить Maven В IntelliJ IDEA"), `updatedAt`, `cwd`, `source`,
  `executionTarget` and a `status` of `idle` | `in_progress` |
  `waiting_on_user`. Not consumed yet (titles already arrive through
  `session_info_update`).
- Agent → client request `_kiro/terminal/shell_type` (params not yet
  recorded; the extension now logs them). Undocumented; answered `-32601`.
  **[record the params and the expected reply here]**
- Other notifications seen: `_kiro/mcp/status`, `_kiro/tools/didChange`,
  `_kiro/governance/state`, `_kiro/powers/items_changed`,
  `_kiro/progressive_context/items_changed`,
  `_kiro/steering/documents_changed`, `_kiro/policy/changed`.
- kiro-cli stderr: `[INFO] [KRS] <-- GenerateAssistantResponseCommand done
  totalEvents=N` per model round trip; `[ERROR] [KRS] HTTP 407
  requestId=(none) body=<HEAD><TITLE>Proxy Authorization Required…` when the
  corporate proxy rejects a backend call. The turn stayed open afterwards
  (no `session/prompt` response, no error update); see D27.
- A turn whose tool waits in `terminal/wait_for_exit` for a service that
  never exits is not ended by `session/cancel` alone; the extension kills
  the session's commands on Stop (D27).
- `_kiro/session/context` is polled after a turn when no `context_usage`
  arrived; its reply shape is **[to record]** (first reply per session is
  logged as `[info] session <id> _kiro/session/context reply: …`).

## Permissions

`session/request_permission { sessionId, toolCall: ToolCallUpdate, options[] }`
→ `{ outcome: { outcome: "selected", optionId } | { outcome: "cancelled" } }`.
Option kinds: `allow_once`, `allow_always`, `reject_once`, `reject_always`.
V3 adds `_meta.kiro.consent { capability, resource, triggeringResource,
workspaceRoot, persistableConsent }` and accepts a persistent choice as
`_meta.kiro.consent { scope: "workspace", resource: "<pattern>", workspaceRoot }`
on the response. The extension returns only supplied option ids and does not
send `_meta.kiro.consent` (persistent consent is left to the agent's
`allow_always` option); the "always allow this session" button is client-side.
V2 fields `_meta.trustOptions` / `_meta.trustOption` / `_meta.fsReadPaths` /
`_meta.feedback` are ignored.

## Client-side methods served by the extension

| Method | Implementation |
|---|---|
| `fs/read_text_file` | open (dirty) buffer first, else disk; `line`/`limit` honoured |
| `fs/write_text_file` | `WorkspaceEdit` (undoable) then save |
| `terminal/create` … `terminal/release` | child process mirrored into a visible VS Code pseudo-terminal |
| `_kiro/openExternalUrl` | confirmation dialog, then `env.openExternal` |
| anything else | JSON-RPC `-32601` method not found |

## Plan / approval **[unverified]**

ACP's `plan` update is a full replacement list of `{ content, priority, status }`.
Kiro's "Plan mode" is a session mode (the `/plan` slash command switches to the
planner mode; V3 clients do that with `session/set_mode`). The docs do not
describe a plan-approval RPC. ACP's `switch_mode` tool kind is the standard
way an agent asks to leave plan mode; the extension's plan tab offers
Approve/Reject whenever a `session/request_permission` with
`toolCall.kind == "switch_mode"` is pending. Whether Kiro V3 emits such a
request, or simply continues conversationally after the user says "approved",
must be confirmed with the real CLI and recorded here.

## Kiro v2 extensions (ignored unless observed)

`_kiro.dev/commands/available` (notification after session creation),
`_kiro.dev/commands/execute`, `_kiro.dev/commands/options`,
`_kiro.dev/mcp/oauth_request`, `_kiro.dev/mcp/server_initialized`,
`_kiro.dev/compaction/status`, `_kiro.dev/clear/status`, `_session/terminate`.
Unknown notifications are logged to the "Kiro ACP" output channel.

## SDK notes (verified against SDK 2.5.0 source and the fake agent)

- `ClientApp` installs a session-update router as the first handler for
  `session/update`; it validates the notification against the stable v1
  schema and an **unknown `sessionUpdate` kind is rejected with -32602 and
  logged**, never reaching app handlers or the `"*"` fallback. Kiro adds
  kinds over time, so the extension intercepts `session/update` (and every
  `_`-prefixed notification) at the ndjson stream level before the SDK sees
  them and forwards known kinds to the transcript reducer, unknown ones to the
  log.
- The SDK dispatches notifications through an async chain while responses
  resolve synchronously; without the interception a `session/prompt` response
  could overtake the last `agent_message_chunk`s. Intercepting keeps wire
  order.
- Requests the agent sends that the extension does not implement are answered
  with `-32601` by the `"*"` fallback handler, as the Kiro docs require.

## Recorded exchange **[to be filled]**

Paste the output of `node scripts/record-acp.mjs` here, redacting tokens.

## Recorded capabilities of a real Kiro CLI V3 (2026-11-10, `/capabilities` in the extension)

Organisation-managed account (AWS IAM Identity Center), Windows, Kiro CLI 3.x:

- `agentInfo` is **not** sent (the extension shows "Kiro" as the name).
- `agentCapabilities`: `loadSession: true`, `promptCapabilities: { image: true, embeddedContext: true }`,
  `sessionCapabilities: { list, close, delete, fork }`, `mcpCapabilities: { http, sse }`.
- `authMethods`: `aws-builder-id`, `aws-iam-identity-center` (shown when signed out).
  Neither signs in: `authenticate` with either id is rejected with "Auth refresh callback
  failed: Internal error: You are not logged in. Please log in with `kiro-cli login`."
  (observed 2026-11-12), so the extension ignores them: when signed out it offers one action, a fresh
  sign-in in a terminal (`kiro-cli logout`, then `kiro-cli login`).
- `_meta.kiro.extensionMethods` (34): `_kiro/knowledge`, `_kiro/memory/{list,get,create,update,delete,getSyncStatus,sync}`,
  `_kiro/codeIntelligence`, `_kiro/environment/{start_ssh_session,get_network_configuration}`,
  `_kiro/session/{context,compact,export,history}`, `_kiro/config/template`,
  `_kiro/configuration/{getState,set}`, `_kiro/workflow/{new,invoke,load,inspect,list,pause,cancel,delete,listRecipes,listWatchHandlers,resumeAll,retry,update,resume}`,
  `_kiro/sourceProviders/{list,listResources}`. **No usage/quota method at all**, so `/usage` cannot be served
  for this account; `/context` and `/compact` map to `_kiro/session/context` / `_kiro/session/compact`.
- `modes`: `vibe` ("Default", current), `spec`, `quick-spec`, `bug-fix`, `plan`, `autonomous`, plus every custom
  agent of the workspace (`kirocrew-*`, `atlassian`, `qc-*`, …) — 49 in total. The same list is also exposed as
  the config option `mode`.
- `configOptions`: `mode` (category mode), `model` (category model; `auto` + 18 model ids such as
  `claude-opus-5.5`, `gpt-5.6-sol`, `minimax-m2.5`), `memoryReflection` (on/off), `autopilot` (on/off),
  `contentCollection` (enabled/disabled). No `effortLevel`.
- `available_commands_update`: the workspace's custom prompts/agents (`/general-task-execution`,
  `/resolve-jira-ticket`, `/kirocrew-*`, …); the extension forwards them as prompt text.

## Spec vs. real behaviour differences

Observed on 2026-11-10 through the extension (Kiro CLI 3.x, V3 harness, an
organisation-managed account; raw exchange not yet captured):

- `agentCapabilities._meta.kiro.extensionMethods` included
  `_kiro/session/context` and `_kiro/session/compact` but **not**
  `_kiro/account/getUsage` (the migration guide lists it as an example).
  Kiro's own `/usage` in the terminal says usage is managed by the account
  administrator for organisation accounts, so the omission is account-driven.
  The extension's `/help` therefore lists `/usage` under "not available".
- `session/new` returned `modes` (including a planner mode, so `/plan` is
  offered) and `configOptions` with ids/categories for **model** (Auto),
  **mode** (Default/Autonomous), **Memory reflection**, **Autopilot** and
  **Content Collection**; no `effortLevel` option was advertised.

## Agent link (client-supplied MCP server) **[unverified]**

With `kiroAcp.agentLink.enabled` on (D30), every `session/new` / `session/load`
carries one entry:

```json
{ "type": "http", "name": "kiro-acp-tabs", "url": "http://127.0.0.1:<port>/mcp",
  "headers": [{ "name": "Authorization", "value": "Bearer <per-session token>" }] }
```

The **Kiro ACP** output channel logs `agent-link listening on …`, one
`agent-link <session|unbound> <method>[ <tool>] -> <status>` line per MCP
request and `agent-link refused <status>: <reason>` for refused ones; `/capabilities`
ends with `Agent link: on — 127.0.0.1:<port>, N sessions linked` (or why it is off).
Against the real CLI only one thing has been seen so far: V3 calls
`list_sessions` (2026-11-19, below). To record the rest, on a signed-in
machine, with the setting on and two chat tabs open, ask the agent in one tab
to "list the other chat sessions with the kiro-acp-tabs tool", then fill in:

- Does V3 accept the entry on `session/new` at all (no `[warn] agent-link: the
  agent rejected session/new…`)? Does it connect at `session/new` (an
  `initialize` line right away) or only when a tool is first used?
- Does each session call with **its own** token (the `agent-link` lines name the
  calling session; ask from both tabs)? If V3 de-duplicates MCP servers by name
  across sessions, the calls of tab 2 would arrive as tab 1.
- The `session/request_permission` it sends for an MCP tool: `toolCall.kind`,
  `title`, options, `_meta.kiro.consent` (capability / resource).
- How the tool appears in `tool_call` titles (e.g. `kiro-acp-tabs/list_sessions`,
  `@kiro-acp-tabs/list_sessions`) and what `_kiro/mcp/status` reports.
- Which MCP client and protocol version it uses: the `agent-link … initialize
  (client <name> <version>, protocol <requested> -> <negotiated>)` line.

2026-11-19, 0.3.12: on a signed-in machine Kiro called `list_sessions` and saw
the sessions of the other tabs (V3 accepts a client-supplied http server and
calls it); the details above are still to be recorded.

Stages 2–4 add `read_session`, `send_message`, `wait_for_session` and
`start_session` (D30 addendum), exercised so far only against the fake agent
(`test/e2e/f18-agent-messages.e2e.ts`). With two tabs open, ask the agent in
tab 1 to "ask the session in the other tab what it is working on and wait for
its answer", then record:

- **One turn at a time.** All sessions share one kiro-cli process (D19), and
  on 2026-11-19, of three tabs prompted at once, one worked and the other two
  got nothing for 33 minutes.
  Check whether a session that receives a message while the sender's turn
  runs starts before that turn ends; if not, `wait_for_session` from inside a
  turn can only time out until sessions get their own processes
  (docs/plans/2026-11-19-process-per-session.md).
- **Long calls.** `wait_for_session` keeps the HTTP request open for up to
  `timeoutSeconds` (default 120 s, at most 600 s). Does Kiro's MCP client time
  out earlier — after how long, and what does the turn show then (a failed tool
  card, an error the model sees, a retry)? Ask for `timeoutSeconds: 300` against
  a busy session to find out. The output channel shows `agent-link sX waits for
  sY (up to N s)` and `… wait for sY: <outcome>` (`aborted` when the client went
  away first).
- **Permissions per MCP tool.** Does Kiro send its own
  `session/request_permission` for each tool (once per tool, per call, or
  never; read-only tools treated differently from `send_message` /
  `start_session` with `readOnlyHint: false`)? Record `toolCall.kind`, title,
  options and `_meta.kiro.consent`. Our confirmation card comes in addition
  (`kiroAcp.agentLink.confirm`), so a first message may show two cards.
- **How results read.** How the `send_message` result ("Delivered to s3 … it
  started working on it now …") appears in the sender's transcript (tool card
  content, rawOutput, does the model relay it), and whether the model calls
  `wait_for_session` by itself afterwards.
- **The receiving side.** Does the target's model treat the framed message
  (`[Message from another Kiro agent session — …]`) as a peer request rather
  than its user's instruction, reply with `send_message` only when needed, and
  stop at a `chain_limit` / `paused` refusal? Tune the frame, the tool
  descriptions and the server `instructions` until it does unprompted.
- **`start_session`.** Does a session started in a new tab get the server and
  answer its first prompt; does Kiro name the new session itself
  (`session_info_update.title`)?
- **Replay.** Restore a session that received peer messages (Past sessions):
  the replayed user message shows the frame, without the "from …" header
  (expected, see the plan's follow-ups).

## Verification

| # | Feature | Fake agent (unit + extension-host E2E) | Real `kiro-cli acp` |
|---|---------|----------------------------------------|---------------------|
| 1 | Chat panel: streaming, tool cards, cancel, new session, mode/model/config pickers | ✅ `test/acp-client.test.ts`, `test/e2e/f1-chat.e2e.ts` (pickers: reducer tests + webview; v2 `models`/`set_model` and v3 `configOptions` both covered by the fake agent) | 🟡 partially (2026-11-10, screenshot from a second machine with Kiro CLI 3.x / V3): `initialize` + `session/new` + a text prompt worked and streamed a reply; the V3 server advertised both `modes` and `configOptions` – observed options **Mode** (category `mode`, value `Default`), **Model** (`Auto`), **Memory reflection** (`Off`), **Autopilot** (`Autopilot`), **Content Collection** (`Enabled`). The duplicate Mode picker this caused is fixed in 0.1.1. Tool cards, cancel and new session not yet exercised against the real CLI. |
| 2 | Diff editor with Accept/Reject, edited proposal is what gets written | ✅ `test/e2e/f2-diff.e2e.ts` (accept with user edit → disk has the edited text; reject → `failed`/`denied`) | ⏳ |
| 3 | Live plan document, approve/reject of `switch_mode` requests | ✅ `test/e2e/f3-plan.e2e.ts` | ⏳ (whether Kiro V3 emits a `switch_mode` permission request is unknown) |
| 4 | `@` file context, active-file chip | ✅ `test/e2e/f4-context.e2e.ts`, `test/features-contentBlocks.test.ts` | ⏳ |
| 5 | Selection context chip + command/keybinding | ✅ `test/e2e/f5-selection.e2e.ts` | ⏳ |
| 6 | Client fs (dirty buffers, WorkspaceEdit writes) and terminal methods | ✅ `test/acp-client.test.ts`, `test/e2e/f6-fs-terminal.e2e.ts` | ⏳ |
| 7 | Permissions: allow once / always for session / reject per tool kind | ✅ `test/features-permissionPolicy.test.ts`, `test/e2e/f7-permissions.e2e.ts` | ⏳ |
| 8 | Image attachments (paste / drop / pick → ACP `image` blocks, D29) | ✅ `test/features-images.test.ts`, `test/webview-attachments.test.ts`, `test/e2e/f16-images.e2e.ts` (the fake agent reports the image blocks it received) | ⏳ (`promptCapabilities.image: true` is advertised; whether Kiro forwards the `uri` field or limits sizes below 5 MB is unknown) |
| 9 | Agent link: per-session MCP server `kiro-acp-tabs`, tools `list_sessions`, `read_session`, `send_message`, `wait_for_session`, `start_session` (D30) | ✅ `test/agentLink-*.test.ts` (dispatch, server guards and tokens, tool texts and argument checks, frame, rate limiter), `test/features-transcriptText.test.ts`, `test/acp-client.test.ts` (`mcpServers` on new/load, the fake agent's `mcp_call`, peer-message scenarios), `test/e2e/f17-agent-link.e2e.ts` (two tabs see each other; setting off; agent without `mcpCapabilities.http`), `test/e2e/f18-agent-messages.e2e.ts` (delivery, origin and frame, refusals, replies, chain and rate limits, confirmation modes and their isolation from session policies, read, waits, start, reveal, pause, handles across a sign-in) | 🟡 `list_sessions` works (2026-11-19, 0.3.12); the other tools ⏳, see "Agent link" above |

To complete the right-hand column: install Kiro CLI, run `kiro-cli login`,
then (a) `node scripts/record-acp.mjs --prompt "hello" --out docs/recordings/kiro-initialize.ndjson`
and paste the `initialize` / `session/new` messages above, (b) launch the
Extension Development Host (`F5`) with default settings and walk through the
features in the table, noting any deviation in the table and in the section above.
