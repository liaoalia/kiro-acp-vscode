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
(`child_process.spawn` with `shell: true` so compound commands work), mirrored
into a VS Code `Pseudoterminal` the user can see. Output is retained up to
`outputByteLimit` (default 1 MiB), truncating from the start on a character
boundary. `release` kills a still-running process; the terminal tab stays open.

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
`messageId` (`user-N`). Incoming `user_message_chunk` updates are ignored for
the live session so an agent that echoes the prompt does not produce a
duplicate. Session replay (`session/load`) is out of scope; when it is added,
replayed user chunks (`_meta.kiro.replay: true`) must be rendered.

## D14. Compiled artifacts are not committed
`dist/` and `*.vsix` stay out of git. GitHub Actions builds and tests on
Linux/Windows/macOS, uploads the VSIX as a build artifact on every push to
`main`, and attaches it to a GitHub Release for `v*` tags.
