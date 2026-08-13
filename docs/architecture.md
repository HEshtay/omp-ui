# OMP UI — Architecture

> **OMP UI** (`omp-ui`) is a graphical front-end for the **omp** coding agent
> (`pi-coding-agent`), wired into VS Code as an extension. OMP is a
> terminal-first coding agent; this extension is a pair of processes that give
> it a rich, streaming chat UI inside VS Code.

This document describes how the extension is put together: the process
topology, the two message protocols, the state-management model, the
rendering architecture, and the key engineering decisions behind it.

For the module-by-module API surface — every file, its exports, signatures, and
the limits/timeouts/regexes behind them — see
[`code-reference.md`](./code-reference.md).

---

## 1. System Context

```text
┌──────────────────────────────────────────────────────────────┐
│ VS Code (one host process)                                    │
│                                                               │
│  ┌─────────────────────────┐      ┌──────────────────────┐   │
│  │     Extension Host      │      │       Webview        │   │
│  │ (Node, dist/extension)  │      │ (sandboxed iframe)   │   │
│  │                         │      │                      │   │
│  │ ChatController          │◄────►│  React renderer      │   │
│  │ OmpRpcClient            │ bridge│  (dist/webview)      │   │
│  └──────────┬──────────────┘      └──────────────────────┘   │
│             │ RPC over stdio (newline-delimited JSON)        │
└─────────────┼────────────────────────────────────────────────┘
              │
      ┌───────▼────────┐
      │  omp child proc │
      │  `--mode rpc-ui`│
      └─────────────────┘
```

- **Extension Host** — Node.js process. Owns the agent child process and the
  *authoritative* conversation state. Runs the esbuild bundle
  `src/extension.ts → dist/extension.js`.
- **Webview** — a sandboxed VS Code webview (Chromium iframe). A React +
  Vite application (`webview/ → dist/webview/`) that renders the chat. It is a
  *renderer only* — it has no direct access to the agent.
- **Agent** — a separate `omp` child process spawned with `--mode rpc-ui`,
  communicating over its stdin/stdout. This is the same agent the CLI runs;
  the extension is a thin UI layer over it.

The webview is a *view over* the extension host. The host is the single source
of truth, and the webview is disposable — VS Code routinely destroys hidden
webviews — so the host must be able to re-hydrate any (re)attached webview from
its own state without replaying the session.

---
## 2. Two Independent Message Protocols

There are exactly **two** protocols, and they never talk to each other
directly — the `ChatController` translates between them.

### 2.1 RPC wire protocol: agent ⇄ extension host

*Defined in:* `src/shared/protocol.ts`
*Implemented by:* `src/rpc/client.ts`, `src/rpc/frame.ts`, `src/rpc/spawn-target.ts`

Transport is **newline-delimited JSON over the child's stdin/stdout** — one
JSON object per line. The agent runs commands concurrently and makes **no
ordering promise**; responses are correlated strictly by request `id`.

**Host → agent (`RpcCommand`, one JSON object per stdin line):**
- Lifecycle/session: `new_session`, `switch_session`, `get_state`,
  `get_messages`, `get_messages_page`, `prompt`, `steer`, `follow_up`,
  `abort`, `compact`, `get_available_commands`, `set_session_name`, `branch`,
  `get_branch_messages`, `export_html`.
- Model/tuning: `set_model`, `cycle_model`, `get_available_models`,
  `set_thinking_level`, `set_steering_mode`, `set_follow_up_mode`,
  `set_fast_mode`, `set_auto_compaction`.
- Auth: `get_login_providers`, `login`.
- Utilities: `get_session_stats`, `bash`, `set_todos`,
  `set_subagent_subscription`, `get_subagents`, `get_subagent_messages`,
  `handoff`.

**Agent → host (outbound frames), demultiplexed on `type`:**
- `ready` — spawn handshake; the client blocks on this before issuing commands.
- `response` — correlated answer to a command (success `data` or error).
- `extension_ui_request` — a *blocking* prompt for the user: `select`,
  `confirm`, `input`, `editor`. The host answers via a **side channel**
  (`extension_ui_response`) that is deliberately *never* id-correlated as a
  `response`.
- `available_commands_update`, `session_info_update`, `config_update`,
  `command_output`, `extension_error`, `subagent_*` — side-channel frames
  pushed to handlers.
- **Session events** (`AgentSessionEvent`) — the streaming transcript deltas:
  `agent_start/end`, `turn_start/end`, `message_start/update/end`,
  `tool_execution_start/update/end`, `auto_compaction_*`, `auto_retry_*`,
  `notice`, `todo_reminder`, etc. These are the bulk of the traffic and feed
  the shared reducer (see §5).

**Protocol negotiation & large frames.** After `ready`, the client tries
`negotiate_protocol { protocolVersion: 2 }`. If the agent accepts, framing
upgrades to **v2**, which reassembles oversized frames from base64
`rpc_chunk` sequences (`src/rpc/frame.ts`). A v1-only runtime keeps working —
oversized frames just degrade. Validation is strict: a chunk sequence must be
uninterrupted, start at index 0, keep metadata stable, and match its declared
byte length exactly (limits live in `protocol.ts`).

**Spawn target resolution** (`src/rpc/spawn-target.ts`) exists because npm
global installs produce `.cmd`/`.bat` shims on Windows that Node's `spawn`
cannot execute directly. It searches PATH honoring `PATHEXT`, and routes batch
shims through `cmd /d /s /c` with verbatim arguments.
### 2.2 Bridge protocol: extension host ⇄ webview

*Defined in:* `src/shared/bridge.ts`

This is the JSON message contract carried by
`webview.postMessage` / `onDidReceiveMessage`.

**Host → webview (`HostMessage`):**
- `snapshot` — a full `UiSnapshot` + `DraftState`, sent once on (re)attach.
- `events` — a batch of agent session events to fold incrementally.
- `session`, `commands`, `models`, `todos`, `subagents`, `config` — targeted
  updates for their respective slices.
- `dialogOpen` / `dialogClose` — surface a blocking `extension_ui_request`.
- `workspace` — the registered projects, every live session, and which session
  *this* webview is showing; drives the session switcher.
- `sessionStatus` — compact streaming / awaiting-approval badge for one session,
  broadcast to every webview so a *background* session's state is visible.
- `notify`, `commandOutput`, `setComposerText`, `appendComposerText`,
  `savedSessions`, `branchPoints`, `focusComposer` — one-off UI commands.

**Webview → host (`WebviewMessage`):**
- `ready` — first message sent on mount; asks the host for a `snapshot` and to
  start the agent if needed.
- `submit` (+ optional `steer`/`followUp` behavior), `abort`, `compact`,
  `resetSession`, `switchSession`, `requestSessions`, `setSessionName`,
  `branch`, model/thinking/mode toggles, `saveDraft`, `dialogAnswer`.
- Session/project roster messages handled by the `SessionManager` rather than a
  controller: `newSession`, `closeSession`, `selectSession`,
  `addProjectFolder`, `removeProjectFolder`.
- Intent-to-act messages the host translates into VS Code or agent actions:
  `openFile`, `openDiff`, `openExternal`, `openArtifact`, `openDiagram`,
  `copyText`, `revealSubagent`, `pickImages`, `showLog`, `loginProvider`.
- `refreshState` — ask the host to re-pull state and push a fresh snapshot.

---

## 3. Build & Packaging Targets

The repo compiles **two independent bundles** from a single TypeScript source
tree, sharing the `src/shared/` modules verbatim.

| Bundle | Tool | Entry | Target | Output |
|---|---|---|---|---|
| Extension host | esbuild (`esbuild.mjs`) | `src/extension.ts` | Node 20, CJS | `dist/extension.js` |
| Webview | Vite (`vite.config.ts`), root `webview/` | `webview/index.html` → `src/main.tsx` | ES2022, React | `dist/webview/` |

Notes:
- The extension is built with `vscode` marked `external` and excluded from the
  bundle — it is provided by the host at runtime.
- `vite.config.ts` emits plain relative assets (`base: "./"`, predictable
  names) because the webview is **loaded from disk via `Webview.asWebviewUri`,
  never from a dev server**.
- `tsconfig.json` is a project-references root over
  `tsconfig.extension.json` (host) and `tsconfig.webview.json` (webview); both
  extend `tsconfig.base.json`. `npm run typecheck` checks both.
- `npm run build`, `watch`, `smoke`, `package` scripts orchestrate the two
  builds plus the dev harnesses (§8).

The **Content-Security-Policy** in `src/view/chat-view.ts:renderHtml` uses a
per-load nonce plus `strict-dynamic`, with `connect-src 'none'` (no network in
the webview). `strict-dynamic` is required because the Vite entry chunk pulls
lazy chunks (mermaid, highlight.js grammars) via dynamic `import`.

---
## 4. Directory Structure & Layering

`src/shared/` is the *only* code shared between the two processes; everything
else belongs to exactly one side. The host never imports webview code, and the
webview never imports host code — they meet only in `shared/`.

```text
src/                        # Extension host (Node)
├── extension.ts            # Activation, DI wiring, command registration
├── chat/
│   └── controller.ts       # ChatController: orchestrator, owns agent + state
├── ide/                    # IDE-as-MCP-server bridge (§7)
│   ├── protocol.ts         # Host ⇄ shim IPC contract (types + env var names)
│   ├── bridge-server.ts    # IdeBridgeServer: named pipe / unix socket listener
│   ├── mcp-shim.ts         # Standalone MCP stdio server omp launches
│   ├── registration.ts     # Idempotent ~/.omp/agent/mcp.json merge
│   └── tools/              # The tools the agent actually sees
│       ├── types.ts        # IdeTool + IdeToolContext
│       ├── registry.ts     # ideTools: the single list the bridge serves
│       ├── format.ts       # MAX_RESULT_CHARS + truncate() + shared formatting
│       ├── diagnostics.ts / navigate.ts / symbols.ts
│       └── scm.ts / tasks.ts
├── rpc/                    # Agent wire protocol
│   ├── client.ts           # OmpRpcClient: spawn, framing, dispatch, request()
│   ├── frame.ts            # RpcFrameDecoder: v2 chunk reassembly
│   └── spawn-target.ts     # Executable resolution (PATH / PATHEXT / cmd shims)
├── session/
│   ├── session-manager.ts  # Projects + live sessions; webview surfaces
│   └── session-store.ts    # Enumerates on-disk .jsonl session transcripts
├── shared/                 # Shared verbatim between host AND webview
│   ├── protocol.ts         # RPC wire contract (types + guards)
│   ├── bridge.ts           # Host ⇄ webview message contracts
│   ├── chat-model.ts       # UI-facing conversation model + pure reducer
│   └── guards.ts           # Minimal structural type guards
└── view/
    ├── chat-view.ts        # WebviewViewProvider + WebviewPanel + HTML/CSP/bind
    ├── diff-provider.ts    # In-memory omp-diff:// content provider
    └── diagram-preview.ts  # Mermaid render -> standalone .svg in an editor tab

webview/                    # React renderer (Vite)
├── index.html
└── src/
    ├── main.tsx            # Mount, top-level message listener
    ├── App.tsx             # Layout composition
    ├── store.ts            # UiStore + useSyncExternalStore hooks
    ├── vscode.ts           # acquireVsCodeApi() wrapper, post()
    ├── format.ts           # Shared display formatting helpers
    ├── theme.css
    └── components/
        ├── Transcript.tsx  # Auto-scrolling transcript rendering
        ├── MessageItem.tsx # Per-kind message renderer (memoized)
        ├── Markdown.tsx    # react-markdown pipeline (memoized)
        ├── CodeBlock.tsx / Mermaid.tsx / Thinking.tsx
        ├── Composer.tsx    # Draft, images, send/steer/queue
        ├── SlashMenu.tsx   # Slash-command context + ranking + dropdown
        ├── SessionBar.tsx / StatusBar.tsx
        ├── SessionSwitcher.tsx # Project + live-session switcher
        ├── Popover.tsx     # Measured, portalled floating panel
        ├── Icon.tsx        # Shared 16×16 stroked-glyph primitive
        ├── DialogHost.tsx  # Renders blocking select/confirm/input/editor
        ├── TodoPanel.tsx / SubagentPanel.tsx / Toasts.tsx
        └── tools/          # Registry-driven tool-call cards
            ├── registry.ts # Tool name → renderer map
            ├── ToolCard.tsx# Shared card frame + error boundary
            ├── types.ts / detail.ts / parts.tsx
            ├── fs.tsx / shell.tsx / search.tsx / web.tsx
            ├── agentic.tsx / generic.tsx
            └── tools.css

scripts/                    # Dev-only harnesses (not shipped)
├── smoke-rpc.ts            # E2E RPC smoke test outside VS Code
├── smoke-sessions.ts       # E2E multi-session/multi-project smoke test
├── record-session.ts       # Record a live session to a HostMessage stream
├── serve-harness.mjs       # Serve the built webview with a stubbed bridge
└── harness/vscode-stub.ts  # Minimal fake `vscode` module for harness runs
```

---
## 5. State Management & the Shared Reducer

This is the heart of the design.

**The reducer lives in `src/shared/chat-model.ts` and is used identically by
both processes.** It folds an `AgentSessionEvent` into a `ChatState`:

```ts
ChatState = {
  items:    ChatItem[]             // user / assistant / shell / custom /
                                   // fileMention / summary / notice
  toolCalls: Record<string, ToolCallState>
  activeItemId: string | null      // timeline id of the streaming message
  running, compaction, retry, todoPhases, subagents, seq
}
```

- **Host:** `ChatController` keeps an authoritative `ChatState`, folds every
  incoming event with `applyEvent`, and batches deltas into `events`
  `HostMessage`s flushed on a ~33 ms frame budget
  (`EVENT_FLUSH_MS` in `controller.ts`).
- **Webview:** `UiStore` replays the `snapshot`, then folds forwarded events
  with the **same** `applyEvent` — so streaming is incremental and never
  re-serializes the transcript.

The contract that makes this consistent is:

> The host owns the truth. It sends a **full snapshot on attach**, then
> **incremental events** until the process/agent changes. Any (re)attached
> webview starts from `snapshot` and folds forward.

Because `applyEvent` returns the *same reference* when nothing changed, React
subscribers bail out cheaply; assistant messages memoize on item identity
(`MessageItem = memo(...)`), keeping a long transcript at roughly one
re-render per streamed frame.

### Reducer details worth knowing

- `message_update` replaces the assistant content **wholesale** from the
  accumulated snapshot (`event.message` is already fully accumulated — see the
  streaming contract in `protocol.ts`), rather than appending deltas.
- `toolResult` messages don't occupy their own timeline slot; they fold into
  their originating `ToolCallState` card.
- Steering/synthetic user messages are filtered out of the transcript.
- Interrupted tool calls (a steering interrupt) are marked `skipped` so they
  read neutrally rather than as failures (`isBenignSkip`).

---
## 6. Core Components

### 6.1 `extension.ts` — activation & wiring

`activate` is `async` and small by design. It builds the dependency graph and
registers everything:
- Creates the `OMP` output channel and the `DiffContentProvider`.
- Starts the IDE bridge (§7) — best effort, awaited before any session exists so
  the first agent to spawn already knows the address — and supplies the
  `agentEnv` function that hands each session's child that address plus its own
  `cwd`.
- Constructs the `SessionManager`, registers every workspace folder as a
  project with one (lazily-spawned) session, and wires the per-session editor
  panels into it.
- Registers the webview view provider (sidebar `omp.chatView`, with
  `retainContextWhenHidden`) and the `omp-diff://` content provider.
- Registers 17 commands (`omp.openChat`, `omp.newSession`, `omp.closeSession`,
  `omp.abort`, `omp.registerIdeBridge`, etc.) and the single
  configuration-change listener that offers an agent restart when a launch-time
  setting changes, or a window reload when `omp.ideBridge.enabled` changes.

### 6.2 `ChatController` (`src/chat/controller.ts`)

The orchestrator. Holds the authoritative `ChatState`, `SessionSnapshot`,
commands, models, dialogs, subagents, and the composer draft. Responsibilities:
- **Spawn & lifecycle:** idempotent `start()`, `restart()`, config-derived
  launch args, and status transitions (`starting/ready/restarting/exited/error`).
- **View attachment:** `subscribe()` listeners + `snapshot()` rehydration; a
  hidden webview's disposal never loses state because the controller keeps it.
- **Agent → UI:** folds events, coalesces them into flushes, special-cases
  `todo` results and streaming status, translates `select/confirm/input/editor`
  `extension_ui_request`s into `UiDialog`s (including recognizing the
  tool-approval gate via `parseApproval`, and forwarding an answer back as an
  `extension_ui_response` side channel).
- **UI → agent:** `handleWebviewMessage()` maps every `WebviewMessage` to an
  RPC command (or a VS Code action), awaiting the response and refreshing
  state where needed (most mutations call `#refreshState()` after).
- **Session parking:** resetting/emptying chat + subagents on new/switch
  session, and re-hydrating messages after a switch or branch.

### 6.3 `OmpRpcClient` (`src/rpc/client.ts`)

Owns one child process. Reads stdout as UTF-8, splits newline-delimited
frames, feeds them through `RpcFrameDecoder`, and dispatches on `type`
(`frameType`). `request()` writes a command with a fresh `req_N` id and awaits
its correlated `response`; `respondToUi()` writes a UI response on the side
channel. `dispose()` closes stdin as graceful shutdown, escalating to SIGKILL
after 5 seconds.

### 6.4 `src/session/session-store.ts`

`omp` exposes **no session-listing RPC command**, so the extension enumerates
the on-disk `.jsonl` transcripts itself, mirroring the agent's session-paths
layout. It maps a workspace `cwd` to a bucket directory, reads each session
file's head (title/first message) and tail (status) efficiently, and returns a
newest-first `SessionListEntry[]`.

### 6.5 `SessionManager` (`src/session/session-manager.ts`)

Owns the registered **projects** (a `cwd` + label + branch) and every **live
session**. A session is one `ChatController`, hence one agent process and one
on-disk session file — so a project can host several concurrent sessions and
several projects can run at once. Controllers spawn lazily on first focus, so
an unfocused session costs nothing.

Webviews never touch a controller directly; they bind to a *surface*:
- `sidebar()` — follows whichever session is active, and re-hydrates with a
  fresh `snapshot` when focus moves.
- `surface(sessionId)` — pinned to one session, for an editor panel.

The manager fans a controller's host messages out to the surfaces showing that
session, answers the roster messages itself (`newSession`, `closeSession`,
`selectSession`, `addProjectFolder`, `removeProjectFolder`), and broadcasts
`workspace` + per-session `sessionStatus` to *every* surface so background
badges stay live. Session ids are minted (`<cwd>#<n>`) and ordinals are never
reused, so labels stay stable; the window always keeps at least one session,
and a project removal that would break that is refused.

### 6.6 `src/view/chat-view.ts`

Both surfaces bind via a common `bind()` helper:
- `ChatViewProvider` — the sidebar webview view, bound to `manager.sidebar()`.
- `ChatPanel` — a wider editor-tab panel, **one per session** (keyed by session
  id), bound to `manager.surface(id)`. Focusing a panel makes its session active
  in the sidebar; its tab title tracks the agent's session name.

`bind()` sets `renderHtml` (CSP + nonce), subscribes the host's messages to
`webview.postMessage`, and forwards webview messages to the surface.
### 6.7 Diff preview

`src/view/diff-provider.ts` backs the read-only left/right sides of an edit
diff. Contents are held in memory keyed by an opaque `omp-diff://` id, so a diff
can be opened straight from a tool card without touching the filesystem.

### 6.8 Diagram preview

`src/view/diagram-preview.ts` opens a mermaid diagram in an editor tab, where it
gets the full editor width and VS Code's image zoom instead of a sidebar
column's worth of pixels. The webview has already rendered the diagram, so its
SVG is reused verbatim — mermaid never enters the extension host. The inline
render is sized to its container, so `standalone()` pins scaled viewBox
dimensions and paints an opaque backdrop before the file is written to
`<tmp>/omp-diagrams/` and opened with the built-in `imagePreview.previewEditor`.
A diagram mermaid refused has no SVG to reuse; its source opens as text instead.

### 6.9 Webview rendering (`webview/src/`)

- **`store.ts`** — `UiStore` + `useSyncExternalStore` hooks
  (`useUi(selector)`); the render pipeline subscribes only to what it renders.
- **`main.tsx`** — subscribes to `window` `message` events, renders `<App/>`,
  then posts `{ type: "ready" }`.
- **`App.tsx`** — composes `SessionSwitcher`, `SessionBar`, `Transcript`,
  panels, `Composer`, `StatusBar`, `DialogHost`, and `Toasts`.
- **`Transcript.tsx`** — auto-follows the stream with a `ResizeObserver` +
  scroll-threshold state machine and an empty state.
- **`MessageItem.tsx`** — memoized dispatch over `ChatItem.kind`; tool-call
  blocks subscribe to their own `toolCalls` entry so a running tool re-renders
  itself instead of its whole message.

### 6.10 Tool rendering: the registry pattern

`webview/src/components/tools/` mirrors omp's own renderer registry.
- **`registry.ts`** maps tool names (`bash`, `edit`/`apply_patch`, `read`,
  `write`, `grep`/`ast_grep`, `glob`, `task`, `todo`, `browser`, `lsp`,
  `web_search`) to per-tool renderers; unknown tools fall back to
  `genericRenderer`.
- **`ToolCard.tsx`** is the shared frame: status icon, title, one-line summary,
  expand caret, elapsed timer, artifact link, images, and the notes tail. Its
  interior is wrapped in a React **error boundary** (`RendererBoundary`) so a
  malformed `details` payload degrades to the generic card instead of blanking
  the transcript.
- Expansion state survives virtualized unmount/remount via a module-level
  `Map<toolCallId, boolean>` — a user decision, not conversation state.

---
## 7. The IDE Bridge: this Window as an MCP Server

*Defined in:* `src/ide/`

The agent's default view of a repository is the file system. Everything VS Code
already knows — the language server's diagnostics, its definition and reference
graph, the symbol index, the SCM diff, the task list — is invisible to it, so it
re-derives a worse approximation with `grep`. This layer hands that state over as
**MCP tools**, which the agent *pulls* on demand.

### 7.1 Two-hop topology

```text
┌ VS Code window ──────────────────────────────┐
│  Extension host                              │
│    IdeBridgeServer  ── listens on ──┐        │
│    ideTools[]                       │        │
└─────────────────────────────────────┼────────┘
                                      │ named pipe (Windows)
                                      │ unix socket (POSIX)
                                      │ newline-delimited JSON
┌ omp child (one per session) ─────────┼───────┐
│    MCP client ── stdio JSON-RPC ─► mcp-shim  │
└──────────────────────────────────────────────┘
```

omp discovers MCP servers **only** from `mcp.json` files (project `.omp/mcp.json`,
user `~/.omp/agent/mcp.json`) — never from `config.yml` or a `--config` overlay.
It speaks `initialize` (protocol `2025-03-26`) → `notifications/initialized` →
`tools/list`, honours `notifications/tools/list_changed`, and presents each tool
to the model as `mcp__vscode-ide_<name>`.

So the extension registers one **user-level stdio server** named `vscode-ide`
that launches a tiny shim, and the shim proxies to the extension host over an IPC
endpoint whose path arrives in its environment. Two hops rather than one, because
a stdio server is a *child of the agent* and cannot be the extension host.

Why IPC instead of an HTTP listener in the host:
- **No TCP port** to allocate, collide on, or expose to other processes on the
  machine — and therefore **no bearer token** to mint, store, and rotate.
  Reachability *is* the authorization, enforced by OS-level ACLs on the pipe.
- **Per-window addressing.** Each window's server has its own path, so a session
  can never be answered by a different window's IDE state.
- **Graceful degradation.** When the address is absent from the environment — a
  plain terminal `omp` that this extension did not launch — the shim still
  completes the MCP handshake and advertises **zero tools**. A silent no-op, not a
  connection error and not a broken server entry.

### 7.2 Contract A — host ⇄ shim

*Defined in:* `src/ide/protocol.ts`, imported by both sides. Newline-delimited
JSON, one object per line, correlated by `id` exactly like the RPC protocol
(§2.1).

**Shim → host:**
- `{ id, op: "hello", cwd }` — announce the session this agent runs in.
- `{ id, op: "list" }` → `result` is `{ tools: IdeToolDescriptor[] }`.
- `{ id, op: "call", tool, args }` → `result` is `{ text, isError? }`.

**Host → shim:** `{ id, ok: true, result }` or `{ id, ok: false, error }`, plus
the unsolicited `{ op: "tools_changed" }`, which the shim republishes as
`notifications/tools/list_changed`.

### 7.3 Contract B/C — the `IdeTool` extension point

Every tool is an `IdeTool` (`src/ide/tools/types.ts`): a bare `name`, a
`description`, a plain JSON-Schema `inputSchema` object, and
`invoke(args, ctx) => Promise<string>`. `IdeToolContext` carries the calling
session's `cwd` and the OMP log channel. `src/ide/tools/registry.ts` exports the
single `ideTools` array the bridge serves.

The return value goes straight into a model's context, so the output contract is
deliberately strict:
- Terse and line-oriented — `path:line:col  message`, not prose or a JSON dump.
- Paths workspace-relative (`asRelativePath`); lines and columns **1-based**,
  converted from VS Code's 0-based API.
- Capped at `MAX_RESULT_CHARS` (24 000) via the shared `truncate()`, which appends
  an explicit `… N more (truncated)` line rather than clipping silently.
- An empty result is a *success* that says so (`No diagnostics.`), never `""`.
- Bad arguments `throw`; the host turns a throw into `{ isError: true }`, so one
  bad call never takes the bridge down.

### 7.4 Registration & lifecycle

`src/ide/registration.ts` merges our entry into `~/.omp/agent/mcp.json` on every
activation — the shim path lives inside the extension install directory and moves
on upgrade, so registration must self-heal. It parses, mutates *only*
`mcpServers["vscode-ide"]`, and re-serializes, so unrelated keys and third-party
servers survive. A file that is malformed JSON is **left alone** with a warning:
losing a developer's other servers is worse than not registering. An entry that
already deep-equals what we would write is not rewritten.

Two parts of that entry are load-bearing and non-obvious:
1. **`env` values are variable *names*, not values.** Before connecting, omp
   resolves an `env` value that names a **set** environment variable to that
   variable's contents. Writing `"OMP_IDE_BRIDGE_PIPE": "OMP_IDE_BRIDGE_PIPE"`
   therefore means *"copy this from my own environment"* — so the address stays
   per-window and per-session instead of being baked into a global config file.
   When the variable is *unset*, the resolution falls through and the shim is
   handed the **literal** string `"OMP_IDE_BRIDGE_PIPE"`; the shim treats a
   value equal to its own variable name as unconfigured, which is what turns a
   terminal `omp` into the zero-tool case rather than a failed connection.
   (`envPolicy: "literal"` would disable this resolution, so the entry must not
   set it.)
2. **`ELECTRON_RUN_AS_NODE=1` with `command: process.execPath`.** VS Code's own
   binary is Electron, and nothing guarantees a plain `node` on the agent's
   `PATH`; this flag makes that same binary behave as a bare Node interpreter.

`extension.ts` starts the server, registers it, and pushes it into
`context.subscriptions`, all behind `omp.ideBridge.enabled`. Failure is contained:
a pipe we cannot bind or a config we cannot write logs a warning and leaves
`bridge` undefined — activation continues, and the per-session `agentEnv` supplier
returns `{}`. When the bridge *is* up, that supplier gives every agent child
`OMP_IDE_BRIDGE_PIPE` (this window) and `OMP_IDE_BRIDGE_CWD` (that session's own
working directory), which is how one window's several sessions stay distinct on a
single socket.

---
## 8. Development & Verification Tooling

The `scripts/` directory supports working on this extension outside a full VS
Code host:
- **`smoke-rpc.ts`** (`npm run smoke`) — spawns a real `omp --mode rpc-ui`,
  drives one prompt through the *same* `OmpRpcClient` and reducer the extension
  uses, and prints what the transcript would render. Auto-approves so an
  approval gate can't hang the run.
- **`smoke-sessions.ts`** (`npm run smoke:sessions`) — drives the production
  `SessionManager` (with the `vscode` module stubbed) across two projects and
  two sessions in the *same* project, prompting all of them concurrently with
  real agent processes. Asserts sessions stay independent (own session file, own
  transcript), that background badges reach every surface, and that
  focus/reset/close behave.
- **`smoke-ide-bridge.ts`** (`npm run smoke:ide`) — runs a real `IdeBridgeServer`
  over a real socket with a *stub* tool list, spawns the built `dist/mcp-shim.js`
  the way omp would, and drives raw MCP JSON-RPC over its stdio: handshake,
  `tools/list`, a `tools/call` that round-trips through the bridge, and an
  unknown-tool call that must come back as an error result instead of a crash. A
  second shim spawned with no bridge address asserts the degraded contract
  (handshake succeeds, zero tools, nothing on stderr). Needs no `omp` binary.
- **`record-session.ts`** (`npm run record`) — runs the *production*
  `ChatController` against a live agent (with the `vscode` module stubbed via
  `harness/vscode-stub.ts`) and writes the exact `HostMessage` stream the
  webview sees, so the renderer can be replayed against real agent traffic.
- **`serve-harness.mjs`** (`node scripts/serve-harness.mjs`) — serves the built
  webview in a browser with a stubbed `acquireVsCodeApi`, mirroring the real
  CSP (nonce + strict-dynamic) so a violation in the harness is a violation in
  VS Code. Exposes `window.__deliver(hostMessage)` and `window.__posted`.

---

## 9. Key Architectural Decisions

1. **The host is authoritative; the webview is a disposable renderer.**
   VS Code destroys hidden webviews, so all durable state lives in the
   extension host and is replayed as a `snapshot` whenever a view (re)attaches.
2. **One shared pure reducer, run in both processes.** The host folds events
   for durability; the webview folds the forwarded event stream for instant,
   incremental rendering. Both use the identical `applyEvent` from
   `src/shared/chat-model.ts`.
3. **Two deliberately separate protocols.** The agent's RPC wire protocol and
   the host⇄webview bridge have different shapes, error models, and coupling
   needs. Keeping them isolated — sharing only the *view model* in
   `src/shared/` — matches those differences.
4. **The RPC contract is a hand-maintained mirror, not a dependency.** Types
   are copied into `src/shared/protocol.ts` so the extension builds **without**
   the agent package installed and the webview bundle stays free of Node
   imports. Payloads the UI forwards without interpreting stay `unknown`, and
   untyped `details` are narrowed defensively (not trusted).
5. **Streaming is batched, not per-event.** Agent events are coalesced into one
   `postMessage` per ~33 ms frame budget, trading a little latency for much
   lower webview message churn.
6. **Effortless graceful degradation.**
   - Protocol v1 still works if v2 (chunk reassembly) is unavailable.
   - Unknown tool names render via the generic card.
   - A malformed tool card degrades via an error boundary.
   - A kind this build doesn't know (newer agent) returns `null`, not a crash.
7. **Webview hardening.** Loaded from disk via `asWebviewUri`, never a dev
   server; CSP `default-src 'none'` + `connect-src 'none'` (no network); nonce
   + `strict-dynamic` for scripts; minimal `localResourceRoots`; image-mime
   validation before data-URI use.
8. **Cross-platform spawn correctness.** Windows `.cmd`/`.bat` shims are routed
   through `cmd /c` with verbatim args (`spawn-target.ts`), and session-path
   encoding normalizes Windows drive letters across the agent's bucket scheme.
9. **Session metadata is read from disk, not the agent.** Because there is no
   listing RPC command, the extension scans `.jsonl` transcripts directly,
   reading only head/tail windows for performance.
10. **Multiplexing is session-keyed, not project-keyed.** The unit of
    concurrency is a session (one agent process), because two sessions in one
    project is as ordinary as two projects. Projects only supply the `cwd`;
    webviews bind to a *surface* (following or pinned) instead of a controller,
    which is what lets the sidebar and N editor panels watch different sessions
    simultaneously.

---
## 10. Sequence: A Prompt Round-Trip

```mermaid
sequenceDiagram
    participant W as Webview (React)
    participant H as ChatController (host)
    participant C as OmpRpcClient
    participant A as omp --mode rpc-ui

    Note over W,H: on mount
    W->>H: { type: "ready" }
    H-->>W: { type: "snapshot", snapshot, draft }
    H->>C: start() → spawn agent, negotiate protocol

    Note over W,H,A: user submits
    W->>H: { type: "submit", text, images }
    H->>C: request("prompt", { message, images })
    C->>A: {"id":"req_1","type":"prompt",...}

    rect rgb(240,248,255)
        Note over C,H,W: streaming
        A-->>C: message_start / message_update / tool_execution_*
        C-->>H: onSessionEvent(event)
        H->>H: chat = applyEvent(chat, event); buffer
        H-->>W: { type: "events", events:[...] }  (flushed ~33ms)
        A-->>C: extension_ui_request (approval / select / confirm)
        C-->>H: onUiRequest()
        H-->>W: { type: "dialogOpen", dialog }
        W-->>H: { type: "dialogAnswer", id, answer }
        H-->>C: respondToUi(extension_ui_response)
        A-->>C: agent_end
        H-->>W: { type: "session", isStreaming:false }
    end

    A-->>C: response (id=req_1)
    C-->>H: request promise resolves
    H->>C: request("get_state") → refresh
```

---

## 11. Configuration Surface

All settings live under the `omp.` namespace (`package.json` →
`contributes.configuration`):
- **Launch-time** (`--mode rpc-ui` args, applied on a fresh process):
  `executablePath`, `extraArgs`, `model`, `thinkingLevel`, `approvalMode`.
  A change to any of these prompts the user to restart the agent.
- **Runtime/streaming:** `subagentSubscription`, `showThinking`, `autoScroll`,
  `sendKeybinding`.
- **Activation-time:** `ideBridge.enabled`. The bridge's socket is created and
  registered during activation, so a change prompts a *window reload* rather than
  an agent restart.

`src/chat/controller.ts:readUiConfig()` reads the UI-affecting subset and is
included in every `snapshot` under `config`.

---

## 12. Conventions & Extension Points

- Add a new agent-side capability by expressing it in `src/shared/protocol.ts`
  (command type + response data), mapping it in `ChatController`
  `handleWebviewMessage`, and rendering it in the webview.
- Add a new tool renderer by implementing `ToolRenderer` (`tools/types.ts`)
  and registering it in `tools/registry.ts`; the generic card + error boundary
  cover everything else.
- Add a new IDE tool by implementing `IdeTool` in a module under
  `src/ide/tools/`, exporting it in that module's own `IdeTool[]`, and spreading
  that array into `ideTools` in `src/ide/tools/registry.ts`. Honour the output
  contract in §7.3 — workspace-relative paths, 1-based positions, `truncate()`,
  an explicit empty-result sentence, and `throw` on bad arguments. No other file
  changes: the shim, the schema advertised to the model, and the registration all
  follow from the registry.
- **Keep `src/shared/` free of imports from host or webview code** — it is the
  single shared boundary and must stay transport-agnostic and Node-free for the
  webview.
