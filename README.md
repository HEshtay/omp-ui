# OMP UI

A graphical front-end for the [**omp**](https://github.com/badlogic/pi-mono) coding agent, wired into VS Code.

omp is a terminal-first coding agent. This extension puts a rich, streaming chat UI
in front of it — multi-session, multi-project, with inline diffs, tool call rendering,
and Mermaid diagrams — while keeping the agent itself completely unchanged.

## How it works

The extension spawns the same `omp` binary you use from the terminal, in `--mode rpc-ui`,
and talks to it over newline-delimited JSON on stdio. The extension host owns the
authoritative conversation state; the webview is a disposable renderer over it.

```text
┌──────────────────────────────────────────────────────────────┐
│ VS Code                                                       │
│  ┌─────────────────────────┐      ┌──────────────────────┐   │
│  │     Extension Host      │◄────►│       Webview        │   │
│  │ (owns agent + state)    │bridge│ (React renderer)     │   │
│  └──────────┬──────────────┘      └──────────────────────┘   │
└─────────────┼────────────────────────────────────────────────┘
              │ RPC over stdio
      ┌───────▼─────────┐
      │  omp child proc │
      └─────────────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for the full design: process topology,
both message protocols, the state model, and the reasoning behind the key decisions.

## Requirements

- **VS Code** 1.104 or newer
- **Node.js** 20 or newer (to build)
- **The `omp` CLI**, installed and on your `PATH`. If it lives somewhere else, point
  `omp.executablePath` at it.

## Install

Download the latest `omp-ui-<version>.vsix` from
[Releases](https://github.com/HEshtay/omp-ui/releases) — CI builds it from a clean
checkout on every tag, so a whole team installs an identical artifact:

```bash
code --install-extension omp-ui-0.2.0.vsix
```

Then **reload the window**, and open the **OMP** view from the activity bar or
press `Ctrl+Shift+Alt+O` (`Cmd+Shift+Alt+O` on macOS). The reload matters: the
IDE bridge registers itself at activation, and `omp` reads MCP config only at
agent startup.

Rolling this out to a team, where each engineer uses their own Jira and GitHub
credentials? Follow [`docs/onboarding.md`](docs/onboarding.md).

To build the `.vsix` yourself instead — see [Development](#development) for the
full loop:

```bash
npm install
npm run package
```

## Features

- **Multi-session, multi-project.** Run several agents at once across different
  workspace folders. Each session gets its own process, its own cwd, and its own
  session file. Background sessions stream status badges into the sidebar.
- **Sidebar or editor tab.** Chat lives in the activity bar, or pop any session into
  a full editor tab (pinned to its own project) with **Open Chat in Editor**.
- **Rendered tool calls.** File reads, edits, and shell commands render as structured
  cards. Edits open as native VS Code diffs.
- **Streaming transcript** with thinking blocks, token counts, and per-turn cost.
- **Session management.** Resume any prior session for the project, reset the
  conversation, or compact it when the context gets long.
- **Add selection to chat** — `Ctrl+Shift+Alt+L` on any editor selection.
- **Export to HTML** for sharing a transcript.
- **Workspace checkpoints.** Each turn is preceded by a snapshot of the work tree,
  so a turn's file changes can be reverted from the transcript or with **OMP:
  Revert Workspace to Checkpoint**. omp's own `checkpoint`/`rewind` rewind the
  conversation, not the filesystem; this is the file-level undo. Needs a git work
  tree. See `omp.checkpoints.enabled`.
- **IDE-backed MCP tools.** The extension exposes this window's live IDE state to
  the agent as twelve MCP tools — diagnostics, LSP navigation and symbols,
  source-control diffs, tasks, structured test runs (`run_tests` reports counts
  and per-failure `file:line`, not scraped terminal text), the active editor and
  cursor, the unsaved contents of a buffer you are still editing, and your own
  terminal's recent commands and exit codes — so it reads the IDE instead of
  guessing with `grep`. See `omp.ideBridge.enabled`.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `omp.executablePath` | `omp` | Path to the `omp` executable. Resolved on `PATH` when not absolute. |
| `omp.extraArgs` | `[]` | Extra CLI arguments appended to `omp --mode rpc-ui`. |
| `omp.model` | `""` | Model pattern passed as `--model`. Empty uses omp's default. |
| `omp.thinkingLevel` | `""` | Thinking level passed as `--thinking`. Empty uses omp's default. |
| `omp.approvalMode` | `""` | Tool approval mode. omp itself defaults to `yolo`, so prompts only appear if you pick `write` or `always-ask`. |
| `omp.subagentSubscription` | `progress` | How much subagent detail to stream into the UI. |
| `omp.showThinking` | `true` | Render the model's thinking blocks. |
| `omp.autoScroll` | `true` | Follow the bottom of the transcript while streaming. |
| `omp.sendKeybinding` | `enter` | Which key sends a message. With `enter`, `Shift+Enter` inserts a newline. |
| `omp.followActiveEditor` | `false` | Switch the chat to the project folder of the active editor. |
| `omp.ideBridge.enabled` | `true` | Expose IDE diagnostics, navigation, SCM diffs, tasks, test runs, editor state, and terminal output to the agent as MCP tools, registering a `vscode-ide` server in `~/.omp/agent/mcp.json`. Requires a window reload. |
| `omp.checkpoints.enabled` | `true` | Snapshot the workspace before each turn so file changes can be reverted from the transcript. Requires a git work tree. |
| `omp.testFramework` | `""` | Test framework for `run_tests`. Empty auto-detects from the project. |

## Development

```bash
npm install
npm run watch      # rebuild extension + webview on change
```

Then press `F5` to launch an Extension Development Host.

```bash
npm run typecheck        # tsc over both projects
npm run smoke            # end-to-end RPC round-trip against a real omp process
npm run smoke:sessions   # multi-session / multi-project behaviour
npm run smoke:ide        # IDE bridge: real socket, real MCP shim, degraded mode
npm run smoke:tests      # test-reporter parsing, one recorded payload per format
npm run smoke:checkpoint # snapshot/restore round-trip in a throwaway git repo
```

`smoke` and `smoke:sessions` spawn a real `omp` binary, so they need the CLI
installed and authenticated. `smoke:sessions` runs three concurrent agents across
two projects and asserts session isolation, focus behaviour, and lifecycle
transitions. `smoke:ide` needs no `omp` at all — it drives the built shim
(`npm run build:extension` first) against a real bridge socket over raw MCP
JSON-RPC. `smoke:tests` is offline too: it parses a recorded payload for each of
the six reporter formats behind the seven supported frameworks, and asserts a
malformed one yields nothing rather than a fake pass. `smoke:checkpoint` creates a
real temporary git repository and asserts the snapshot/restore round-trip is
byte-exact — binary files included, `.gitignore`d paths deliberately excluded.

## Layout

```text
src/
  extension.ts        activation, commands, keybindings
  chat/               ChatController — translates between the two protocols
  rpc/                agent process spawn + newline-delimited JSON framing
  session/            multi-session / multi-project bookkeeping
  view/               webview provider, editor panels, diff provider
  ide/                IDE-as-MCP-server bridge: socket, shim, tool registry
  checkpoint/         git-plumbing workspace snapshots for turn-level undo
  shared/             protocol types and the chat model (host ⇄ webview)
webview/src/          React renderer
scripts/              smoke tests and dev harness
docs/architecture.md  full design document
```

## License

[MIT](LICENSE)
