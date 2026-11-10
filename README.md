# Kiro ACP Chat for VS Code

A VS Code extension that talks to the [Kiro](https://kiro.dev) agent over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). It spawns
`kiro-cli acp` as a child process and exchanges JSON-RPC over stdio using the
official ACP TypeScript SDK. The goal is a Claude Code–like chat experience in
VS Code on top of Kiro.

The extension itself makes **no network calls** and has **no telemetry**. All
network access happens inside `kiro-cli`, which inherits your environment
(including `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`).

## Features

| # | Feature | Where |
|---|---------|-------|
| 1 | Chat panel in the secondary sidebar: streaming replies, tool-call cards with status, cancel, new session, mode / model / config pickers (when the agent advertises them) | **Kiro** view in the secondary side bar |
| 2 | Native diff review: proposed file changes open in VS Code's diff editor; Accept / Reject in the editor title or the chat card answer the agent's permission request; you can edit the proposed side before accepting and the edited text is what gets written | diff editor + chat |
| 3 | Live plan document: the agent's plan is rendered as Markdown in an editor tab and updated as steps progress; Approve / Reject appear when the agent asks to leave plan mode | `Kiro: Open Plan` |
| 4 | File context: type `@` in the input to pick workspace files; the active editor file is attached by default as a removable chip | chat input |
| 5 | Selection context: the current selection becomes a chip like `file.ts:12-40` and is sent with path and line range | `Kiro: Send Selection to Kiro Chat` (`Ctrl+Alt+K` / `Cmd+Alt+K`) |
| 6 | Client-side file system and terminal: reads are served from open (unsaved) buffers, writes go through `WorkspaceEdit` so they are undoable, agent commands run in a visible VS Code terminal | automatic |
| 7 | Permissions: allow once / always allow for this session / reject, per tool kind, using only the options the agent offers | chat permission card |

## Requirements

- VS Code **1.106** or newer (the secondary side bar contribution point).
- [Kiro CLI](https://kiro.dev/docs/getting-started/installation/) **2.37** or
  newer on the same machine, signed in (`kiro-cli login`). Windows 10/11,
  Linux and macOS are supported by both the CLI and this extension.

Install Kiro CLI:

```powershell
# Windows (PowerShell)
irm https://cli.kiro.dev/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://cli.kiro.dev/install | bash
```

Then run `kiro-cli login` once in a terminal. The extension can also start the
login for you: when the agent reports that you are signed out, the chat shows a
**Log in to Kiro** button that opens a terminal running the sign-in flow.

## Install the extension (VSIX)

The extension is distributed as a `.vsix` file, not through the Marketplace.

1. Build it (or take a release artifact): `npm install && npm run package`
   produces `kiro-acp-<version>.vsix`.
2. In VS Code: **Extensions** view → `…` menu → **Install from VSIX…**, or run
   `code --install-extension kiro-acp-<version>.vsix`.
3. Run `Kiro: Focus Chat` (or `Kiro: Open Chat in Editor`): the chat opens as
   a tab in the editor area. Prefer a side panel? Set `kiroAcp.chatLocation`
   to `sidebar` and use the **Kiro** view in the secondary side bar
   (View → Appearance → Secondary Side Bar, `Ctrl+Alt+B`).
4. Mode, model and other agent options are behind the ⚙ button in the chat
   header (or click the model / mode pill in the composer); press it again to
   hide them.

The composer at the bottom has `+` (attach a workspace file, same as typing
`@`), `/` (slash commands advertised by the agent), the current model and
mode as pills, and a send button that turns into **Stop** while Kiro is
working. In the narrow secondary-sidebar layout the same controls collapse
into a compact header.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `kiroAcp.cliPath` | `kiro-cli` | Path to the `kiro-cli` executable. A bare name is looked up on `PATH` and then in the default install locations (`C:\Program Files\Kiro-Cli\kiro-cli.exe`, `~/.local/bin/kiro-cli`, `/usr/local/bin/kiro-cli`, `/opt/homebrew/bin/kiro-cli`). Use a full path if VS Code does not see your shell's `PATH`. |
| `kiroAcp.cliArgs` | `[]` | Extra arguments appended after `acp`, e.g. `["--agent-engine=v2"]` to force the CLI v2 harness. |
| `kiroAcp.chatLocation` | `editor` | `editor`: the chat opens as a tab in the editor area (`Kiro: Focus Chat`, permission requests, `Send Selection`). `sidebar`: it opens in the **Kiro** view of the secondary side bar. Both can be open at once. |
| `kiroAcp.showSettingsByDefault` | `false` | Show the mode / model / option pickers without pressing the ⚙ button in the chat header. |
| `kiroAcp.attachActiveFile` | `true` | Attach the active editor file to each prompt as a removable chip. |
| `kiroAcp.autoOpenDiffs` | `true` | Open the diff editor automatically when a tool call proposes a file change. |
| `kiroAcp.terminal.outputByteLimit` | `1048576` | Bytes of terminal output retained for the agent when it does not specify a limit. |
| `kiroAcp.logProtocol` | `false` | Log every JSON-RPC message to the **Kiro ACP** output channel. |

## Proxy setup

The extension never opens a network connection. `kiro-cli` does, and it is
started with the extension host's environment, so the standard variables are
honoured:

```bash
export HTTPS_PROXY=http://proxy.example.com:8080
export HTTP_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1,.internal.example.com
```

Make sure the variables are visible to VS Code itself:

- **Windows:** set them as user or system environment variables (System
  Properties → Environment Variables), then restart VS Code.
- **macOS:** launch VS Code from a shell that has them exported (`code .`), or
  set them with `launchctl setenv`.
- **Linux:** export them in the shell that starts VS Code, or in
  `~/.profile` / your desktop session environment.

You can verify what the agent sees with `Kiro: Show Protocol Log` after
enabling `kiroAcp.logProtocol`: the log shows the spawn command and any stderr
from `kiro-cli` (proxy errors appear there).

## Commands

| Command | Description |
|---------|-------------|
| `Kiro: Focus Chat` | Reveal the chat view |
| `Kiro: New Session` | Start a fresh ACP session |
| `Kiro: Cancel Current Turn` | Send `session/cancel` |
| `Kiro: Restart Agent Process` | Kill and respawn `kiro-cli acp` |
| `Kiro: Send Selection to Kiro Chat` | Attach the current selection as a chip |
| `Kiro: Open Plan` | Open (or re-open) the live plan document |
| `Kiro: Accept Proposed Change` / `Reject Proposed Change` | Answer a pending diff permission |
| `Kiro: Approve Plan` / `Reject Plan` | Answer a pending plan hand-off request |
| `Kiro: Show Protocol Log` | Open the **Kiro ACP** output channel |

## Development

```bash
npm install
npm run build        # bundle extension + webview with esbuild
npm test             # typecheck + unit tests against the fake ACP agent
npm run package      # vsce package → kiro-acp-<version>.vsix
```

Press `F5` in VS Code to launch the Extension Development Host.

To try the UI without a Kiro login, point the extension at the fake agent
that ships with the tests (it speaks ACP over stdio and replays recorded
sessions):

```jsonc
// settings.json of the development host (Windows: kiro-cli-fake.cmd; .cmd/.bat
// paths are run through cmd.exe automatically)
"kiroAcp.cliPath": "<absolute path to repo>/test/fake-agent/kiro-cli-fake",
"kiroAcp.cliArgs": ["--scenario", "tour"]
```

Scenarios: `tour`, `chat`, `cancel`, `permission-reject`, `switch-mode`,
`refusal`, `bad-request`, `crash`; add `--engine v2` or `--auth-required` to
see the CLI v2 surface or the sign-in banner. Typing `/scenario <name>` in the
chat switches scenario per turn.

`npm run test:e2e` runs the same features inside a real VS Code instance
(downloaded into `.vscode-test/` on first run) against the fake agent.

Layout: `src/acp/` (process, connection, sessions – no `vscode` imports),
`src/features/` (diff, plan, context, fs, terminal, permissions),
`src/ui/` (webview provider and message protocol), `src/webview/` (browser
bundle). The webview never talks to the agent process directly.

Design notes live in `docs/DECISIONS.md`; what the real `kiro-cli` advertises
and where it differs from the spec is recorded in `docs/protocol-notes.md`.

## Verification status

See the **Verification** section at the end of `docs/protocol-notes.md` for
which features have been exercised against the real `kiro-cli` and which only
against the fake agent.

## License

MIT. Dependencies: `@agentclientprotocol/sdk` (Apache-2.0), `marked` (MIT),
`dompurify` (Apache-2.0 / MPL-2.0 dual, used under Apache-2.0).
