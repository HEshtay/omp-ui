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

No marketplace release yet — build the `.vsix` yourself:

```bash
npm install
npm run package
code --install-extension omp-ui-0.1.0.vsix
```

Then open the **OMP** view from the activity bar, or press `Ctrl+Shift+Alt+O`
(`Cmd+Shift+Alt+O` on macOS).

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

## Development

```bash
npm install
npm run watch      # rebuild extension + webview on change
```

Then press `F5` to launch an Extension Development Host.

```bash
npm run typecheck      # tsc over both projects
npm run smoke          # end-to-end RPC round-trip against a real omp process
npm run smoke:sessions # multi-session / multi-project behaviour
```

The smoke suites spawn a real `omp` binary, so they need the CLI installed and
authenticated. `smoke:sessions` runs three concurrent agents across two projects
and asserts session isolation, focus behaviour, and lifecycle transitions.

## Layout

```text
src/
  extension.ts        activation, commands, keybindings
  chat/               ChatController — translates between the two protocols
  rpc/                agent process spawn + newline-delimited JSON framing
  session/            multi-session / multi-project bookkeeping
  view/               webview provider, editor panels, diff provider
  shared/             protocol types and the chat model (host ⇄ webview)
webview/src/          React renderer
scripts/              smoke tests and dev harness
docs/architecture.md  full design document
```

## License

[MIT](LICENSE)
