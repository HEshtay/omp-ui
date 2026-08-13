# OMP UI — Code Reference

> Per-module reference for the `omp-ui` VS Code extension: every file, its
> exported symbols, their signatures, and the behavior that is not obvious from
> a signature. For the *why* — process topology, protocol rationale, and the
> architectural decisions behind this layout — read
> [`architecture.md`](./architecture.md) first; this document is the *what*.

Conventions used throughout:

- Each `###` heading is a source file, listed with the path used in imports.
- The table under a file lists **every** export. Signatures are transcribed from
  the source; long unions are abbreviated in the table and spelled out in the
  bullets below it.
- `#### Key internal detail` sections cover module-private constants and
  behavior that materially affects callers (timeouts, limits, batching windows,
  regexes) — those symbols are *not* exported and must not be imported.

## Contents

1. [Extension Host Core](#1-extension-host-core) — `src/extension.ts`, `src/chat/controller.ts`
2. [RPC, Sessions, and Views](#2-rpc-sessions-and-views) — `src/rpc/`, `src/session/`, `src/view/`
3. [Shared Contracts](#3-shared-contracts-srcshared) — `src/shared/`
4. [Webview Renderer](#4-webview-renderer) — `webview/src/`
5. [Tool Call Renderers](#5-tool-call-renderers) — `webview/src/components/tools/`
6. [Build, Configuration, and Dev Tooling](#6-build-configuration-and-dev-tooling) — manifest, bundlers, `scripts/`

---

## 1. Extension Host Core

The extension-host entry point and the per-session chat controller. `extension.ts` wires the singleton object graph and registers all VS Code contributions; `chat/controller.ts` owns one agent process, the authoritative conversation state, and the bidirectional webview message bridge.

### `src/extension.ts`

VS Code activation entry point. Constructs the object graph, seeds one session per workspace folder, and registers every command, provider, and workspace listener onto `context.subscriptions`.

| Export | Kind | Signature |
|---|---|---|
| `activate` | function | `activate(context: vscode.ExtensionContext): void` |
| `deactivate` | function | `deactivate(): void` |

- `activate` — synchronous; performs no `await`. Construction order is significant:
  1. `output = vscode.window.createOutputChannel("OMP", { log: true })` — a `LogOutputChannel`, passed to every controller via `SessionManager`.
  2. `diffs = new DiffContentProvider()`.
  3. `manager = new SessionManager({ output, diffs })`.
  4. `manager.panels` is assigned *after* construction — `{ open: (id) => ChatPanel.show(context.extensionUri, manager, id), close: (id) => ChatPanel.close(id) }`. The source comment states this late binding exists to avoid a circular import.
  5. Project seeding: for each `vscode.workspace.workspaceFolders`, calls `manager.registerProject({ id: folder.uri.fsPath, cwd: folder.uri.fsPath, label: folder.name })` then `manager.createSession(folder.uri.fsPath)`. If there are **zero** folders, falls back to a single implicit project keyed on `process.cwd()` with label `"workspace"`.
  6. `provider = new ChatViewProvider(context.extensionUri, manager)`.
  7. Everything is pushed to `context.subscriptions` in one call: `output`, `diffs`, `manager`, the text-document content provider for `OMP_DIFF_SCHEME`, the webview view provider registered under `ChatViewProvider.viewType` with `{ webviewOptions: { retainContextWhenHidden: true } }`, three workspace/window listeners, then the commands.
- `deactivate` — calls `ChatPanel.disposeAll()` only. Nothing else is torn down explicitly; the rest rides on `context.subscriptions`.

#### Registered commands

| Command id | Action |
|---|---|
| `omp.focusChat` | `provider.reveal()` — reveal the sidebar chat view |
| `omp.openChat` | `ChatPanel.show(context.extensionUri, manager, manager.activeSessionId ?? "")` — open the session in an editor-column panel |
| `omp.addProjectFolder` | `manager.addFolder()` |
| `omp.removeProjectFolder` | `manager.removeFolder()` |
| `omp.newSession` | `manager.newSession()` |
| `omp.closeSession` | `manager.closeSession(id)` for `manager.activeSessionId`; no-op when there is no active id |
| `omp.resetSession` | `manager.active().resetSession()` |
| `omp.resumeSession` | `manager.active().pickAndSwitchSession()` |
| `omp.abort` | `manager.active().abort()` |
| `omp.selectModel` | `manager.active().pickModel()` |
| `omp.loginProvider` | `manager.active().loginProvider()` |
| `omp.compact` | `manager.active().compact()` |
| `omp.exportHtml` | `manager.active().exportHtml()` |
| `omp.restartAgent` | `manager.active().restart()` |
| `omp.showLog` | `output.show(true)` (preserve focus) |
| `omp.addSelectionToChat` | `addSelectionToChat(manager.active(), provider)` — module-private helper, see below |

#### Configuration-change handling

`vscode.workspace.onDidChangeConfiguration` returns immediately unless `event.affectsConfiguration("omp")`. Otherwise it calls `manager.notifyAllConfigChanged()` (fans a fresh `UiConfig` to every attached webview), then checks whether any *launch-time* key changed:

`omp.executablePath`, `omp.extraArgs`, `omp.model`, `omp.thinkingLevel`, `omp.approvalMode`

Those flags are only read when the agent process spawns, so a change prompts `showInformationMessage("OMP launch settings changed. Restart the agent to apply them?", "Restart")`; choosing `"Restart"` invokes `manager.active().restart()`. Non-launch keys take effect live with no prompt.

#### Other workspace listeners

- `onDidChangeWorkspaceFolders` — for each `event.added` folder, registers the project and creates a session; for each `event.removed` folder, calls `manager.removeProject(folder.uri.fsPath)`, so a folder that leaves the workspace stops being a project of this window.
- `onDidChangeActiveTextEditor` — gated on the boolean setting `omp.followActiveEditor` (default `false`). When enabled, resolves `manager.findProjectForUri(editor.document.uri)` and calls `manager.focusProject(projectId)` if a project matches.

#### Key internal detail — `addSelectionToChat`

`addSelectionToChat(controller: ChatController, provider: ChatViewProvider): void` (not exported). Reads `vscode.window.activeTextEditor`; returns early with no editor or when the resolved text is whitespace-only. An **empty selection means the whole document** (`getText(undefined)`). Builds a fenced block — a backtick-wrapped `` `<relativePath><range>` `` line, a blank line, then a fence tagged with `editor.document.languageId` containing the text — and calls `controller.appendToComposer(...)` followed by `provider.reveal()`. The `range` is `:<startLine+1>-<endLine+1>` and is omitted entirely for an empty (whole-file) selection; line numbers are converted from 0-based to 1-based.

### `src/chat/controller.ts`

Owns a single `OmpRpcClient` process, the authoritative `ChatState`/`SessionSnapshot`/dialog/subagent state, and the `WebviewMessage` → RPC dispatch. Durable state lives here because VS Code disposes hidden webviews; a reattaching view is replayed a full `UiSnapshot`.

| Export | Kind | Signature |
|---|---|---|
| `ControllerDeps` | interface | `{ output: vscode.LogOutputChannel; diffs: DiffContentProvider; workspaceFolder: vscode.WorkspaceFolder \| undefined; cwd?: string; label?: string }` |
| `ChatController` | class | `class ChatController implements vscode.Disposable` |

These are the **only** exports. `EVENT_FLUSH_MS`, `readUiConfig`, `parseApproval`, `toDialog`, `mimeForPath`, and `describe` are all module-private.

- `ControllerDeps` — `cwd` overrides the agent's working directory so a project can be an arbitrary worktree that is not a VS Code workspace folder; it falls back to `workspaceFolder?.uri.fsPath`, then `process.cwd()`. `label` overrides the UI display name (falls back to `workspaceFolder?.name`, then the literal `"workspace"`); it exists so two worktrees sharing a repo name can be told apart by branch.

- `ChatController` — constructed as `new ChatController(deps: ControllerDeps)`; `deps` is stored as a `private readonly` parameter property. The constructor is pure state initialization: it resolves `cwd`/`workspaceName` per the fallbacks above and seeds `#session` with `agentStatus: "starting"`, `isStreaming: false`, `isCompacting: false`, `fastModeEnabled: false`, `fastModeActive: false`, `autoCompactionEnabled: true`, `steeringMode: "one-at-a-time"`, `followUpMode: "one-at-a-time"`, `tokensPerSecond: null`, `queuedMessageCount: 0`. **No process is spawned in the constructor** — that happens in `start()`.

  Public surface:
  - `subscribe(listener: (message: HostMessage) => void): vscode.Disposable` — attach a view. Disposing removes the listener. Every internal `#post` fans out to all listeners synchronously.
  - `snapshot(): UiSnapshot` — `{ chat, session, commands, models, dialogs: [...], subagents: [...], config: readUiConfig() }`. The dialog and subagent Maps are materialized to arrays.
  - `get draft(): DraftState` — read-only accessor for the persisted composer draft (`{ text, images }`).
  - `start(): Promise<void>` — idempotent; concurrent callers share the one in-flight `#starting` promise. Never rejects: startup failure is caught, sets status `"error"` with the message, and logs via `output.error`.
  - `restart(): Promise<void>` — sets status `"restarting"`, disposes the client, clears `#client`/`#starting`, resets chat state to `createChatState()`, clears dialogs and subagents, pushes a snapshot, then `start()`. The draft survives a restart.
  - `resetSession(): Promise<void>` — delegates to `handleWebviewMessage({ type: "resetSession" })`.
  - `abort(): Promise<void>` — delegates to `handleWebviewMessage({ type: "abort" })`.
  - `compact(): Promise<void>` — delegates to `handleWebviewMessage({ type: "compact" })`.
  - `exportHtml(): Promise<void>` — delegates to `handleWebviewMessage({ type: "exportHtml" })`.
  - `appendToComposer(text: string): void` — appends to the draft joined by a single `\n` (or replaces when the draft is empty), then posts `appendComposerText` followed by `focusComposer`.
  - `pickAndSwitchSession(): Promise<void>` — lists sessions via `listSessions({ cwd, currentSessionFile })`; shows an information message and returns if empty; otherwise a `showQuickPick` (`title: "Resume omp session"`, `matchOnDetail: true`) whose description is `"current"` or the session status and whose detail is `<localized modified date> · <messageCount> messages`. Selection dispatches `{ type: "switchSession", path }`.
  - `pickModel(): Promise<void>` — lazily calls `#refreshModels()` when `#models` is empty, then `showQuickPick` (`title: "Select omp model"`, `matchOnDescription: true`) with description `<provider>/<id>` and detail `<contextWindow/1000 rounded>K context` when a context window is known. Selection dispatches `{ type: "setModel", provider, modelId }`.
  - `loginProvider(): Promise<void>` — warns and returns if the client is not running. Requests `get_login_providers`; on RPC failure logs a warning and shows a warning message. Shows an information message when the list is empty. Quick pick description is `"signed in"` / `undefined` / `"unavailable"`. Picking an unavailable provider warns and aborts; picking an already-authenticated provider requires confirming `"Sign in again"`. Finally issues `login` with `{ providerId }`; failures surface as an error message. The actual OAuth redirect is driven by the agent through an `open_url` UI request.
  - `openFile(target: string, line?: number, column?: number): Promise<void>` — opens the file as a preview editor. When `line` is given, converts 1-based line/column to a 0-based `Position` (clamped at `0`, `column` defaults to `1`), sets the selection, and reveals with `InCenterIfOutsideViewport`.
  - `notifyConfigChanged(): void` — posts `{ type: "config", config: readUiConfig() }`. Called by `SessionManager` on an `omp.*` settings change.
  - `handleWebviewMessage(message: WebviewMessage): Promise<void>` — the sole webview entry point; see the dispatch table below.
  - `dispose(): void` — guarded by `#disposed` so it is safe to call twice. Clears the flush timer, drops all listeners, and disposes the client.

#### Status state machine

`SessionSnapshot.agentStatus` is `AgentStatus = "starting" | "ready" | "restarting" | "exited" | "error"`. Transitions all go through the private `#setStatus(agentStatus, statusDetail?)`, which posts a `session` message:

- `"starting"` — set in the constructor and again immediately before `client.start()`.
- `"ready"` — set after `client.start()` resolves, before state refresh and message hydration.
- `"restarting"` — set at the top of `restart()`.
- `"exited"` — set from the client's `onExit` hook, with detail `omp exited (code=<code|null> signal=<signal|none>)`. `onExit` also clears `#client`/`#starting`, posts a `dialogClose` for every open dialog, and clears the dialog map.
- `"error"` — set when `start()`'s promise rejects, with detail from `describe(error)`.

`statusDetail` is only meaningful for `"exited"` and `"error"`; every other transition passes `undefined`, which overwrites any prior detail.

#### Key internal detail — event flush batching

```ts
/** Streaming deltas are coalesced into one postMessage per frame budget. */
const EVENT_FLUSH_MS = 33;
```

`#onSessionEvent` applies each event to `#chat` **immediately** (so host state is never stale), then pushes it onto `#pendingEvents` and calls `#scheduleFlush()`. `#scheduleFlush` is a no-op while a timer is already armed; on fire it drains the whole queue into a single `{ type: "events", events }` post. Effect: host-side state is synchronous, webview delivery is throttled to ~30 fps.

Out-of-band paths that bypass batching and post immediately:
- `tool_execution_end` with `toolName === "todo"` — `todosFromToolCall(event.result)` yields the only authoritative mid-run todo snapshot the agent publishes, written into `#chat` and posted as `{ type: "todos", phases }`.
- `agent_start` → `isStreaming: true` + `session` post.
- `agent_end` with `isTerminal !== false` → `isStreaming: false` + `session` post + `void #refreshState()`.
- `model_changed` → `void #refreshState()`.

#### Key internal detail — `readUiConfig()`

```ts
function readUiConfig(): UiConfig
```

Not exported. Reads from the `omp` configuration section with explicit defaults:

| Key | Type | Default |
|---|---|---|
| `omp.showThinking` | `boolean` | `true` |
| `omp.autoScroll` | `boolean` | `true` |
| `omp.sendKeybinding` | `"enter" \| "ctrl+enter"` | `"enter"` |

Called from `snapshot()` and `notifyConfigChanged()`.

Separately, `#startAgent()` reads the launch-time keys directly: `omp.model` → `--model`, `omp.thinkingLevel` → `--thinking`, `omp.approvalMode` → `--approval-mode` (each trimmed and only appended when non-empty), then spreads `omp.extraArgs` (`string[]`, default `[]`). The executable is `omp.executablePath` trimmed, falling back to the literal `"omp"`. After the client starts it also fires `set_subagent_subscription` with `omp.subagentSubscription` (`"off" | "progress" | "events"`, default `"progress"`); failure is logged as a warning and does not block startup.

#### Key internal detail — dialog and approval translation

`toDialog(request: RpcExtensionUIRequest): UiDialog` maps the four interactive UI methods (`select`, `confirm`, `input`, `editor`) into a `UiDialog` with `{ id, title, createdAt: Date.now() }` plus per-method fields (`options`/`timeout`, `message`/`timeout`, `placeholder`/`timeout`, `prefill`/`promptStyle`). Any unrecognized method degrades to `{ method: "input", title: "Input" }`.

`parseApproval(title: string, options: string[]): UiDialog["approval"]` recovers a structured tool-approval card from what the agent sends as an ordinary `select`. Returns `undefined` unless **all** hold:
- `options.length === 2`, `options[0] === APPROVE_LABEL`, `options[1] === DENY_LABEL` (both imported from `../shared/protocol`);
- the first line of `title` matches `/^Allow tool:\s*(.+)$/`.

On a match it returns `{ toolName, reason, detail }` where `toolName` is capture group 1 (fallback `"tool"`), `reason` is the first line starting with `"Reason: "` with that prefix stripped, and `detail` is every remaining line after the first, minus the reason line, joined by `\n` and trimmed.

`#onUiRequest` routes by method: the four interactive methods build a dialog, store it in `#dialogs`, and post `dialogOpen`; `cancel` deletes `request.targetId` and posts `dialogClose`; `notify` posts `{ type: "notify", level: request.notifyType ?? "info", message }`; `open_url` runs `#openLoginUrl`; `set_editor_text` overwrites the draft text and posts `setComposerText`. `setStatus`, `setWidget`, and `setTitle` are terminal-shaped chrome with no webview analogue and are deliberately dropped — they are fire-and-forget by contract, so ignoring them cannot stall the agent.

`#openLoginUrl(url, launchUrl?, instructions?)` logs, opens `launchUrl ?? url` externally, then shows `OMP sign-in: <instructions ?? "Complete the sign-in in your browser, then return here.">` with a `"Copy link"` action that writes `launchUrl ?? url` to the clipboard.

`#answerDialog(id, answer: DialogAnswer)` always deletes the dialog and posts `dialogClose` *before* checking for a client, so a dead process cannot leave a stuck dialog. It then sends `extension_ui_response` shaped by `answer.kind`: `value` → `{ value }`, `confirmed` → `{ confirmed }`, `cancelled` → `{ cancelled: true }`.

#### `handleWebviewMessage` dispatch table

`handleWebviewMessage` is a thin try/catch wrapper around the private `#handle`. On error it formats `RpcClientError` as `<command>: <message>` and anything else via `describe(error)`, logs to `output.error`, and posts `{ type: "notify", level: "error", message }` — errors never reject back into the webview.

| `WebviewMessage.type` | Action |
|---|---|
| `ready` | `#pushSnapshot()` then `void start()` |
| `submit` | `#submit(text, images, behavior)` — see below |
| `abort` | RPC `abort` |
| `dialogAnswer` | `#answerDialog(id, answer)` — responds over `respondToUi`, no request/response round trip |
| `setModel` | RPC `set_model { provider, modelId }` → `#refreshState()` |
| `setThinkingLevel` | RPC `set_thinking_level { level }` → `#refreshState()` |
| `setFastMode` | RPC `set_fast_mode { enabled }`; applies `fastModeEnabled`/`fastModeActive` from the response and posts `session` (no full refresh) |
| `setAutoCompaction` | RPC `set_auto_compaction { enabled }` → `#refreshState()` |
| `setSteeringMode` | RPC `set_steering_mode { mode }` → `#refreshState()` |
| `setTodos` | RPC `set_todos { phases }`; writes `data.todoPhases` into `#chat` and posts `todos` |
| `compact` | RPC `compact` → `#refreshState()` |
| `resetSession` | RPC `new_session`; if `data.cancelled`, posts a `warning` notify (`"New session was cancelled by an extension."`) and returns. Otherwise resets `#chat` to `createChatState()`, clears subagents, `#refreshState()`, `#pushSnapshot()` |
| `switchSession` | RPC `switch_session { sessionPath: message.path }`; `cancelled` → `warning` notify and return. Otherwise clears subagents, `#refreshState()`, `#hydrateMessages()`, `#pushSnapshot()` |
| `requestSessions` | `listSessions({ cwd, currentSessionFile: session.sessionFile })` → posts `savedSessions` (disk read, no RPC) |
| `setSessionName` | RPC `set_session_name { name }` → `#refreshState()` |
| `requestBranchPoints` | RPC `get_branch_messages` → posts `{ type: "branchPoints", messages }` |
| `branch` | RPC `branch { entryId }`; `cancelled` → `warning` notify and return. Otherwise `#refreshState()`, `#hydrateMessages()`, `#pushSnapshot()`, and posts `setComposerText` when `data.text` is non-empty |
| `exportHtml` | RPC `export_html`; shows `Exported session to <path>` with an `"Open"` action that calls `vscode.env.openExternal(Uri.file(path))` |
| `restartAgent` | `restart()` |
| `refreshState` | `#refreshState()` |
| `saveDraft` | `#draft = message.draft` — host-local only, no post, no RPC |
| `openFile` | `openFile(message.path, message.line, message.column)` |
| `openDiff` | `diffs.store("before", oldText)` and `diffs.store("after", newText)`, then `vscode.commands.executeCommand("vscode.diff", left, right, title)` |
| `openExternal` | `vscode.env.openExternal(Uri.parse(url))` |
| `openArtifact` | `#openArtifact(url)` — see below |
| `openDiagram` | `openDiagram(message)` from `src/view/diagram-preview.ts` — writes the webview's own render to `<tmp>/omp-diagrams/` and opens it with the image preview; falls back to the source as a text document when there is no render |
| `copyText` | `vscode.env.clipboard.writeText(text)` then an `info` notify `"Copied to clipboard."` |
| `revealSubagent` | Opens `message.sessionFile` as a preview text document |
| `pickImages` | `showOpenDialog({ canSelectMany: true, openLabel: "Attach", filters: { Images: ["png","jpg","jpeg","gif","webp"] } })`; reads each file, base64-encodes it into an `ImageContent` with `mimeForPath`, appends to the draft images, `#pushSnapshot()`. Returns early when nothing is picked |
| `showLog` | `output.show(true)` |
| `loginProvider` | `loginProvider()` |

The switch has no `default` — it relies on exhaustiveness over the `WebviewMessage` union.

#### Key internal detail — `#submit` streaming behavior

`#submit(text: string, images: ImageContent[], behavior: "steer" | "followUp" | undefined)` clears the draft first, then builds `{ message: text }` plus `images` only when the array is non-empty. When not streaming it sends a plain `prompt`. While streaming, the agent requires an explicit queue policy, so it sends `prompt` with `streamingBehavior: behavior ?? "steer"` — the default **interrupts** the current turn rather than queueing behind it.

#### Key internal detail — `#openArtifact` resolution

`artifact://<id>` (matched by `/^artifact:\/\/([\w.-]+)/`) resolves entirely on disk with no agent round trip: the artifact directory is `sessionFile` with a trailing `.jsonl` stripped, and the file is the first entry whose name equals `id` or starts with `` `${id}.` ``. A missing id or missing `sessionFile` posts a `warning` notify (`Cannot resolve <url> without a saved session.`); a `readdir` failure degrades to an empty list, and a miss posts `Artifact <id> is no longer on disk.` A hit opens the file as a preview editor.

#### Key internal detail — subagent bookkeeping

`#onSubagentFrame` handles exactly two frame types and returns without posting for anything else. `subagent_lifecycle` normalizes `status === "started"` to `"running"` and merges over any existing entry. `subagent_progress` merges the progress payload, preferring the incoming value and falling back to the existing entry for `description`, `parentToolCallId`, and `sessionFile`. Both stamp `lastUpdate: Date.now()` and post the full `subagents` array. The host retains terminal agents deliberately — the agent drops them from its own registry, so completed history only survives here.

#### Key internal detail — refresh helpers and `#require()`

- `#refreshState()` — no-op unless the client is running. Requests `get_state` and overwrites `sessionId`, `sessionName`, `sessionFile`, `model`, `thinkingLevel`, `isStreaming`, `isCompacting`, `fastModeEnabled`, `fastModeActive`, `autoCompactionEnabled`, `steeringMode`, `followUpMode`, `tokensPerSecond`, `queuedMessageCount`, `contextUsage`; posts `todos` when `state.todoPhases` is present, then posts `session`.
- `#refreshModels()` — requests `get_available_models` and posts `models`; failures are logged as warnings only.
- `#hydrateMessages()` — requests `get_messages`, folds them in with `applyMessages`, and pushes a full snapshot; failures are logged as warnings only.
- `#require(): OmpRpcClient` — every RPC-issuing branch goes through it. Throws `"omp is not running. Use “OMP: Restart Agent Process” to start it again."` when `#client` is absent or `!client.running`. That error is caught by `handleWebviewMessage` and surfaced as an error notify.

---

## 2. RPC, Sessions, and Views

The plumbing between the webview and the agent: the child-process RPC transport (`src/rpc/`), the multi-project/multi-session registry that owns the controllers (`src/session/`), and the VS Code webview + diff surfaces (`src/view/`).

### `src/rpc/client.ts`

Owns one `omp --mode rpc-ui` child process and its newline-delimited JSON protocol. Responses correlate strictly on `id`; all other frames are demultiplexed on `type` and pushed to handler callbacks.

| Export | Kind | Signature |
|---|---|---|
| `OmpClientOptions` | interface | `{ executable: string; extraArgs: string[]; cwd: string; env?: Record<string, string \| undefined>; readyTimeoutMs?: number; log(message: string): void }` |
| `OmpClientHandlers` | interface | 10 callbacks — see below |
| `RpcClientError` | class | `new RpcClientError(message: string, command: string, code?: string)` |
| `OmpRpcClient` | class | `new OmpRpcClient(options: OmpClientOptions, handlers: OmpClientHandlers)` |

- `OmpClientOptions.readyTimeoutMs` — defaults to `DEFAULT_READY_TIMEOUT_MS = 60_000`. On expiry `start()` rejects with `` `omp did not send a ready frame within ${readyTimeout / 1000}s` ``.
- `RpcClientError` — `name` is set to `"RpcClientError"`; `command` and `code` are public readonly constructor properties. `code` is populated from a failed response frame's `code` field only when that field is a string.

#### `OmpClientHandlers` — the full callback surface

```ts
onSessionEvent(event: AgentSessionEvent): void;
onSubagentFrame(frame: RpcSubagentFrame): void;
onUiRequest(request: RpcExtensionUIRequest): void;
onCommands(commands: SlashCommand[]): void;
onSessionInfo(info: { title?: string; sessionId?: string }): void;
onConfigUpdate(update: { model?: unknown; thinkingLevel?: unknown }): void;
onCommandOutput(text: string): void;
onExtensionError(frame: RpcExtensionErrorFrame): void;
onStderr(text: string): void;
onExit(code: number | null, signal: NodeJS.Signals | null): void;
```

#### `OmpRpcClient` public members

- `get protocolVersion(): 1 | 2` — starts at `1`; promoted to `2` only when the `negotiate_protocol` handshake echoes `protocolVersion === 2`.
- `get running(): boolean` — `this.#process !== undefined && this.#process.exitCode === null && !this.#disposed`.
- `start(): Promise<void>` — builds `args = ["--mode", "rpc-ui", ...options.extraArgs]`, resolves the binary via `resolveSpawnTarget`, logs `` `spawn: ${target.resolvedPath} ${args.join(" ")}  (cwd=${cwd})` ``, then spawns with `cwd`, `env: { ...process.env, ...options.env }`, `stdio: ["pipe","pipe","pipe"]`, `windowsHide: true`, and `windowsVerbatimArguments: true` only when the target requested it. It awaits the `ready` frame, then attempts `request("negotiate_protocol", { protocolVersion: 2 })`; a rejection is swallowed and logged as `protocol v2 unavailable, staying on v1: …` (a v1-only runtime keeps working). Ready settles early — and rejects — if the child emits `error` (rejects with that error) or `exit` (rejects with `` `omp exited before becoming ready (code=${code} signal=${signal})` ``).
- `request<K extends keyof RpcResponseData>(type: K, params?: Omit<Extract<RpcCommand, { type: K }>, "type" | "id">): Promise<RpcResponseData[K]>` — with an untyped overload `request(type: RpcCommandType, params?: Record<string, unknown>): Promise<unknown>`. Rejects immediately with `RpcClientError("omp is not running", type)` when not running. **Request-id scheme:** `` `req_${++this.#nextRequestId}` `` — a per-client monotonic counter starting at `0`, so the first id is `req_1`. The frame written is `{ ...params, id, type }`, i.e. `id`/`type` always win over caller params. A synchronous write failure removes the pending entry and rejects.
- `respondToUi(response: RpcExtensionUIResponse): void` — side channel for blocking `extension_ui_request` frames; never queued and never correlated. No-op when not running.
- `dispose(): Promise<void>` — idempotent. Clears `#process`, rejects all pending with `Error("omp client disposed")`, returns early if there is no child or it already exited. Otherwise performs the protocol's graceful shutdown by calling `child.stdin.end()` (throws swallowed), then waits for `exit` with a **5000 ms** kill timer that fires `child.kill("SIGKILL")` and resolves.

#### Frame ingestion and dispatch

`stdout` is decoded through a `StringDecoder("utf8")` and buffered; lines are split on `\n`, trimmed, and empty lines skipped. Each line is `JSON.parse`d and pushed through the `RpcFrameDecoder`; any throw calls `decoder.reset()` and logs `dropping malformed frame: …`. A handler that throws is caught and logged as `frame handler threw: …` — it never kills the stream.

Dispatch by `type`:
- `ready` → resolves the pending start.
- `response` → correlated on a string `id`. Missing id: if `success === false` it logs `` `uncorrelated failure (${command}): …` `` (unknown-command and parse failures answer without an id) and returns. Unknown id is silently ignored. `success === true` resolves with `frame.data`; otherwise rejects with `RpcClientError(frame.error ?? `${command} failed`, command, frame.code)`.
- `extension_ui_request`, `extension_error` → forwarded verbatim to the matching handler.
- `available_commands_update` → `onCommands` only when `frame.commands` is an array.
- `session_info_update` → `onSessionInfo` with `title`/`sessionId` narrowed to strings or `undefined`.
- `config_update` → `onConfigUpdate({ model, thinkingLevel })` unnarrowed.
- `command_output` → `onCommandOutput` only when `frame.text` is a string.
- `subagent_lifecycle` | `subagent_progress` | `subagent_event` → `onSubagentFrame`, only when `frame.payload` is a record.
- `rpc_frame_error` → logged as `agent dropped an oversized frame: …`; no handler.
- `prompt_result`, `host_tool_call`, `host_tool_cancel`, `host_uri_request`, `host_uri_cancel` → deliberately ignored (features never opted into).
- default → `onSessionEvent` when `isAgentSessionEvent(frame)` passes.

Child `exit` (independent of dispose) rejects all pending with `` `omp exited (code=${code} signal=${signal})` `` and then calls `onExit`.

### `src/rpc/frame.ts`

Reassembles protocol-v2 `rpc_chunk` sequences into whole logical frames. Mirrors the agent-side validation in `pi-coding-agent/src/modes/rpc/rpc-frame.ts`: any deviation throws rather than yielding a truncated frame.

| Export | Kind | Signature |
|---|---|---|
| `RpcFrameDecoder` | class | `push(value: unknown): Record<string, unknown> \| undefined` / `reset(): void` |

- `push` — a non-chunk value passes straight through: it throws `"rpc chunk sequence interrupted"` if a sequence is mid-flight, throws `"rpc frame must be an object"` if not a record, else returns it unchanged. A chunk (`isRecord(value) && value.type === "rpc_chunk"`) is validated, buffered, and returns `undefined` until the last index arrives; on completion the concatenated buffer is decoded with `new TextDecoder("utf-8", { fatal: true })` (invalid UTF-8 throws), `JSON.parse`d, and rejected with `"rpc frame must be an object"` if not a record.
- `reset` — drops a partially received sequence, e.g. after a transport error.

#### Validation rules and exact error messages

Metadata (`"invalid rpc chunk metadata"`) requires **all** of: `chunkId` a string with `length > 0` and `length <= 128`; `index`, `count`, `byteLength` all `Number.isSafeInteger`; `index >= 0`; `count >= 2`; `count <= MAX_CHUNK_COUNT`; `index < count`; `byteLength >= MAX_RPC_FRAME_BYTES`; `byteLength <= MAX_RPC_REASSEMBLED_BYTES`. Note the lower bound on `byteLength` — a chunked frame must be at least one whole frame limit large, since anything smaller would not have been chunked.

Payload:
- `"invalid rpc chunk data"` — `data` is not a non-empty string matching `` /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/ ``, **or** the base64 fails a round-trip (`Buffer.from(data,"base64").toString("base64") !== data`), which rejects lossily-decoding base64.
- `"rpc chunk payload exceeds the transport limit"` — decoded bytes exceed `RPC_CHUNK_PAYLOAD_BYTES`.

Sequence state machine:
- `"rpc chunk sequence must start at index 0"` — the first chunk of a new sequence has `index !== 0`.
- `"rpc chunk sequence mismatch"` — any of `chunkId`, `count`, `byteLength` changed mid-sequence, or `index !== pending.nextIndex` (chunks must arrive strictly in order, no gaps or repeats).
- `"rpc chunk sequence exceeds declared length"` — cumulative `receivedBytes > byteLength`, checked after each chunk.
- `"rpc chunk sequence length mismatch"` — all `count` chunks received but `receivedBytes !== byteLength`.

#### Limits (from `src/shared/protocol.ts`)

```ts
MAX_RPC_FRAME_BYTES = 1024 * 1024;            // 1 MiB
MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024; // 64 MiB
RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;         // 256 KiB
```
`const MAX_CHUNK_COUNT = Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES)` = `256`.

### `src/rpc/spawn-target.ts`

Locates the agent binary on PATH and builds a spawnable command, working around two Windows facts: Node's `spawn` only implicitly appends `.exe`, and batch shims cannot be executed directly by `CreateProcess`.

| Export | Kind | Signature |
|---|---|---|
| `SpawnTarget` | interface | `{ command: string; args: string[]; windowsVerbatimArguments?: boolean; resolvedPath: string }` |
| `findOnPath` | function | `findOnPath(executable: string, env?: NodeJS.ProcessEnv): string \| undefined` |
| `resolveSpawnTarget` | function | `resolveSpawnTarget(executable: string, args: string[], env?: NodeJS.ProcessEnv): SpawnTarget` |

- `findOnPath` — `env` defaults to `process.env`. If `executable` contains `/` or `\` it is treated as a path: resolved against cwd when relative, and returned only if it is an executable file, else `undefined` (no PATH search). Otherwise:
  - Extensions: on Windows `` (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) ``; elsewhere `[""]`.
  - Search path: `env.PATH ?? env.Path ?? ""`, split on `path.delimiter`. On Windows `process.cwd()` is prepended, matching Windows' rule of resolving the current directory before PATH.
  - Iterates roots outer, extensions inner, returning the first `join(root, executable + extension)` that is an executable file. Empty roots are skipped.
  - Executability test: must `statSync(...).isFile()`; on Windows that alone suffices, elsewhere it must additionally pass `accessSync(candidate, constants.X_OK)`. All errors are treated as "not executable".
- `resolveSpawnTarget` — when `findOnPath` misses, returns `{ command: executable, args, resolvedPath: executable }` unchanged, deliberately letting the OS raise ENOENT so the error names the binary. On Windows, when the resolved path lowercases to a `.cmd` or `.bat` shim, it routes through the command processor:
  ```ts
  { command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${resolved}" ${args.map(quoteForCmd).join(" ")}`],
    windowsVerbatimArguments: true,
    resolvedPath: resolved }
  ```
  Verbatim mode disables Node's own escaping, so the shim path is quoted here and each arg goes through the internal `quoteForCmd`: an argument is passed bare when non-empty and free of `` /[\s"^&|<>()]/ ``, otherwise wrapped in double quotes with inner `"` escaped as `\"`. Everything else returns `{ command: resolved, args, resolvedPath: resolved }`.

### `src/session/session-manager.ts`

Owns the registered projects and every live session running against them. A project is just a `cwd`; a session is one `ChatController` and therefore one `omp --mode rpc-ui` child process, so a project can host several concurrent sessions.

| Export | Kind | Signature |
|---|---|---|
| `ChatSurface` | interface | `{ subscribe(listener: (message: HostMessage) => void): vscode.Disposable; handleWebviewMessage(message: WebviewMessage): Promise<void> }` |
| `SessionPanels` | interface | `{ open(sessionId: string): void; close(sessionId: string): void }` |
| `SessionManagerDeps` | interface | `{ output: vscode.LogOutputChannel; diffs: ControllerDeps["diffs"] }` |
| `SessionManager` | class | `new SessionManager(deps: SessionManagerDeps)` — `implements vscode.Disposable` |

`SessionPanels` is assigned by `extension.ts` onto the public mutable field `panels: SessionPanels | undefined`, purely to avoid a circular import between the manager and `chat-view.ts`.

#### `SessionManager` — public surface

- `readonly onDidChangeSessions: vscode.Event<void>` — fires when the project/session roster or a session's name changes.
- `panels: SessionPanels | undefined` — editor-panel control, set externally.
- `registerProject(entry: ProjectEntry): ProjectEntry` — idempotent on `entry.id`; returns the existing entry unchanged if present. Creates no session. Appends to registration order, broadcasts the roster, and kicks off a fire-and-forget git-branch read.
- `projects(): ProjectEntry[]` — in registration order.
- `addFolder(): Promise<void>` — native `showOpenDialog` (`canSelectFolders`, single selection, `openLabel: "Add project"`); registers the picked path with `id === cwd === fsPath` and `label = path.basename(fsPath)`, then creates and selects a session. No-op if cancelled.
- `removeProject(projectId: string): void` — drops a project and terminates every session it owns (subscription + controller disposed, `panels?.close(id)` per session), then deletes the project, its registration-order slot and its mint counter, so a folder added again later starts from `#1`. **Refused** when the project owns *every* live session: broadcasts `{ type: "notify", level: "warning", message: "Cannot remove <label>: it holds the only open session." }` and changes nothing. No-op for an unknown project. If the active session was one of the removed ones, the new active id is `#sessionOrder[Math.min(activeIndex, length - 1)]` — the survivor that took its slot — followed by `#onActiveChanged()`; otherwise the roster is broadcast and `onDidChangeSessions` fires.
- `removeFolder(): Promise<void>` — `showQuickPick` over `projects()` (`label`, `description: cwd`), then `removeProject(picked.id)`. No-op when nothing is registered or the pick is cancelled.
- `findProjectForUri(uri: vscode.Uri): string | undefined` — first project (in registration order) whose `cwd` contains `uri.fsPath`, tested via `path.relative` being non-empty, not `..`-prefixed and not absolute. Note an exact `cwd` match returns `""` and therefore does **not** match. Drives the `followActiveEditor` setting.
- `focusProject(projectId: string): void` — no-op for unknown projects; reuses the project's oldest session or creates one, then `setActive`.
- `createSession(projectId: string): string | undefined` — **id minting scheme:** `` `${projectId}#${ordinal}` `` where `ordinal` is a per-project monotonic counter starting at `1`; ordinals are never reused, even after a close, so labels stay stable. Constructs a `ChatController` with `{ output, diffs, workspaceFolder: undefined, cwd: project.cwd, label: project.label }` but **does not start it** — the agent process spawns lazily on first focus. Initial status is `{ id, isStreaming: false, hasPendingDialog: false }`. The first-ever session becomes active. Broadcasts the roster and fires `onDidChangeSessions`. Returns `undefined` for an unknown project.
- `sessions(): SessionEntry[]` — in creation order.
- `sessionEntry(id: string): SessionEntry | undefined`
- `get activeSessionId(): string | undefined`
- `active(): ChatController` — the active session's controller, falling back to the oldest session (and re-pointing `#activeId` at it). **Throws** `Error("No OMP session is open.")` when there are none.
- `controller(id: string | undefined): ChatController | undefined`
- `selectSession(id: string): void` — makes `id` active, calls `controller.start()` (idempotent; needed because the sidebar sends `ready` only once, so a freshly focused session needs an explicit kick), re-hydrates surfaces if the active id changed, and opens/focuses the editor panel via `panels?.open(id)`.
- `setActive(id: string): void` — same minus the panel; no-op for unknown or already-active ids (so unlike `selectSession` it will not re-start an already-active session).
- `newSession(projectId?: string): string | undefined` — target defaults to the active session's project, then the first registered project; returns `undefined` if there is none. Creates and selects, so the new panel opens beside the old.
- `closeSession(id: string): void` — refuses to close the last session, instead broadcasting `{ type: "notify", level: "warning", message: "Cannot close the only open session." }`. Otherwise removes it from order and map, disposes the manager's subscription and the controller (terminating the agent), and calls `panels?.close(id)`. If it was active, the new active id is `#sessionOrder[Math.min(index, length - 1)]` — the neighbour that took its slot, else the last.
- `sidebar(): ChatSurface` — a surface with `pinned === undefined`, so it always shows whichever session is active.
- `surface(sessionId: string): ChatSurface` — a surface pinned to that session (an editor panel).
- `notifyAllConfigChanged(): void` — calls `controller.notifyConfigChanged()` on every session.
- `dispose(): void` — idempotent; clears surfaces, disposes the change emitter, disposes every subscription and controller, and empties both maps and both order arrays.

#### Surface objects: `sidebar()` vs `surface(id)`

Both are produced by the same internal `#makeSurface(pinned)` and expose exactly the `ChatSurface` pair. The returned object is a closure over a `BoundSurface { pinned, listener }`:
- `subscribe(listener)` — installs the listener, adds the binding to the manager's surface set, and returns a `vscode.Disposable` that removes it. Only one listener per surface (a second `subscribe` overwrites `listener` and re-adds the same binding).
- `handleWebviewMessage(message)` — routes through `#route`.

The only difference is `pinned`: `undefined` resolves to `#activeId` at every lookup (the sidebar follows the active session), whereas a pinned id always resolves to that one session.

#### Roster message handling and broadcast behavior

`#route` intercepts five roster-level messages before they ever reach a controller — `selectSession`, `newSession` (defaulting `projectId` to the surface's current session's project), `closeSession`, `addProjectFolder`, and `removeProjectFolder`. Everything else is delegated to the surface's current session's controller; if the surface resolves to no session the message is dropped.

`ready` is special: before delegating, the surface is pushed its `workspace` message plus one `{ type: "sessionStatus", ...status }` per live session, because the roster is not part of a controller snapshot.

Fan-out rules:
- `#forwardFromController(id, message)` — per-message, updates the session name (`#trackName`, from `snapshot.session.sessionName` or `session.sessionName`) and compact status (`#trackStatus`), broadcasting `sessionStatus` to **all** surfaces when the status changed and re-broadcasting the roster + firing `onDidChangeSessions` when the name changed. The message itself only reaches surfaces whose resolved session is this one.
- `#trackStatus` — `snapshot` resets `dialogCount` to `snapshot.dialogs.length` and takes `isStreaming` from the snapshot; `session` updates `isStreaming`; `dialogOpen`/`dialogClose` increment/decrement (floored at 0); any other type returns `false`. It returns `false` when neither flag actually changed, so `sessionStatus` is only broadcast on real transitions.
- `#onActiveChanged` — pushes an updated `workspace` message to every surface, and additionally pushes a fresh `{ type: "snapshot", snapshot, draft }` to every *unpinned* surface so the sidebar re-hydrates on switch. Fires `onDidChangeSessions`.
- `#workspaceMessage(surface)` — `{ type: "workspace", projects, sessions, activeSessionId: surface.pinned ?? this.#activeId }`; a pinned panel therefore always sees itself as active.
- `#broadcast(message)` sends to every surface unconditionally; `#broadcastWorkspace()` sends each surface its own per-surface workspace message.

#### Key internal detail — `readGitBranch`

Best-effort branch read with no `git` subprocess. Reads `<cwd>/.git`: a directory yields `<.git>/HEAD`; a file (worktree) is parsed with `` /gitdir:\s*(.+)/ `` and yields `<gitdir>/HEAD`. `HEAD` is matched against `` /ref:\s*refs\/heads\/(.+)/ `` for a branch name; otherwise the trimmed SHA truncated to 8 chars when longer. Any failure returns `undefined`. `#refreshBranch` discards the result if the manager was disposed or the project deregistered meanwhile.

### `src/session/session-store.ts`

omp exposes no session-listing RPC command, so the extension enumerates the on-disk JSONL transcripts itself. The layout mirrors `pi-coding-agent/src/session/session-paths.ts` and `session-listing.ts` — note that the shipped docs describe a hashed bucket scheme the runtime does **not** use; the real scheme is path-based.

| Export | Kind | Signature |
|---|---|---|
| `sessionsRoot` | function | `sessionsRoot(env?: NodeJS.ProcessEnv): string` |
| `encodeSessionDirName` | function | `encodeSessionDirName(cwd: string): string` |
| `sessionDirFor` | function | `sessionDirFor(cwd: string, env?: NodeJS.ProcessEnv): string` |
| `ListSessionsOptions` | interface | `{ cwd: string; currentSessionFile?: string; limit?: number; env?: NodeJS.ProcessEnv }` |
| `listSessions` | function | `listSessions(options: ListSessionsOptions): Promise<SessionListEntry[]>` |

- `sessionsRoot` — precedence: `PI_CODING_AGENT_DIR` → `<that>/sessions`; else on Linux with `XDG_DATA_HOME` → `<XDG_DATA_HOME>/omp/sessions` (XDG flattens the `agent/` segment); else `<homedir>/<PI_CONFIG_DIR ?? ".omp">/agent/sessions`.
- `encodeSessionDirName` — **cwd→bucket encoding.** The cwd is resolved, then:
  - Under `$HOME` (or equal to it): `joinBucket("-", relative)`.
  - Else under `tmpdir()` (or equal to it): `joinBucket("-tmp", relative)`.
  - Else: `` `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--` `` — a leading separator is stripped, then every `/`, `\` and `:` becomes `-`. Because `:` is in the substitution class, a Windows drive letter contributes two dashes (`C:\work` → `--C--work--`).
  - `joinBucket(prefix, relative)` replaces `` /[/\\:]/g `` with `-`; an empty relative (cwd *is* the root) returns the bare prefix (`-` or `-tmp`); otherwise a single `-` separator is inserted unless the prefix already ends in one.
- `sessionDirFor` — `path.join(sessionsRoot(env), encodeSessionDirName(cwd))`.
- `listSessions` — newest-first list of a workspace's saved sessions. A missing/unreadable directory yields `[]`. Only `*.jsonl` names are considered; each is `stat`ed in parallel, non-files and stat failures dropped. **Sort order: descending `mtimeMs` (newest modified first)**, applied *before* `limit` slices the window, and the returned array preserves that order — scanning is parallel but results are `Promise.all`-ordered. Files that fail to scan, or whose prefix contains no `session` entry with a string `id`, are dropped.

#### Key internal detail — head/tail read strategy and limits

```ts
const PREFIX_BYTES = 4096;
const SUFFIX_BYTES = 32_768;
```
`scanSessionFile` never reads a whole transcript. It reads at most the first `min(4096, size)` bytes for identity/metadata and the last `32_768` bytes (from `max(0, size - SUFFIX_BYTES)`) for status. Both windows are line-parsed by `parseLines`, which skips any trimmed line not starting with `{` and swallows `JSON.parse` failures — a byte-window cut lands mid-line, so only complete JSON objects are usable.

From the prefix: `type: "title"` sets `title` (an explicitly empty string means "deliberately untitled" and yields `undefined`); `type: "session"` sets `id`, a fallback `title`, and `created = Date.parse(entry.timestamp)`; `type: "message"` increments `messageCount` and, for the first `user`/`developer`/`assistant` message, sets `firstMessage` from `flattenContent` (a raw string, else the first non-blank `{type:"text"}` block).

From the tail, `statusFromTail` walks entries **backwards** and returns on the first `type: "message"`: assistant → `"error"` / `"aborted"` (`stopReason`), `"interrupted"` (`stopReason === "length"`, or content containing a `toolCall` block), else `"complete"`; `toolResult` → `"interrupted"`; `user` → `"pending"`; anything else → `"unknown"`. No message at all → `"unknown"`.

Display name precedence: `sanitizeName(title)` → `sanitizeName(firstMessage)` → `` `Untitled · ${new Date(created || modified).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` ``. `sanitizeName` keeps only the first line and strips C0 controls and DEL (`` /[\x00-\x1F\x7F]/ ``) before trimming.

#### `SessionListEntry` (defined in `src/shared/bridge.ts`, populated here)

```ts
interface SessionListEntry {
  path: string;          // absolute file path
  id: string;            // from the `session` record
  name: string;          // title → firstMessage → `Untitled · HH:MM`
  firstMessage: string;  // sanitized
  modified: number;      // mtimeMs
  created: number;       // parsed session timestamp, falling back to mtimeMs
  messageCount: number;  // counted within the 4 KiB prefix only
  size: number;
  status: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
  current: boolean;      // path.resolve equality against options.currentSessionFile
}
```

### `src/view/chat-view.ts`

The two VS Code webview hosts — the sidebar view and the per-session editor panel — plus the shared binding that wires a `vscode.Webview` to a `ChatSurface`.

| Export | Kind | Signature |
|---|---|---|
| `ChatViewProvider` | class | `new ChatViewProvider(extensionUri: vscode.Uri, manager: SessionManager)` — `implements vscode.WebviewViewProvider` |
| `ChatPanel` | class | private constructor; static `show` / `close` / `disposeAll` |

`bind`, `renderHtml`, `nonce`, `titleFor` and `WEBVIEW_DIR` are module-private.

- `ChatViewProvider.viewType` — `static readonly viewType = "omp.chatView"`.
- `ChatViewProvider.resolveWebviewView(view: vscode.WebviewView): void` — disposes any prior binding, binds the webview to `manager.sidebar()` (so it follows the active session), and clears `#view`/`#binding` on `onDidDispose`.
- `ChatViewProvider.reveal(): void` — `view.show(true)` when already resolved, otherwise `vscode.commands.executeCommand("omp.chatView.focus")` (built from `viewType`).
- `ChatPanel.show(extensionUri, manager, sessionId): void` — reveals an existing panel in `vscode.ViewColumn.Active` if one exists for the session; no-op when `manager.sessionEntry(sessionId)` is undefined; otherwise creates a `vscode.window.createWebviewPanel("omp.chatPanel", titleFor(...), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [<extensionUri>/dist/webview] })` and registers it in the static per-session map. One panel per *session*, so two sessions in the same project can be watched side by side.
- `ChatPanel.close(sessionId): void` — disposes that session's panel if open.
- `ChatPanel.disposeAll(): void` — disposes every panel and clears the map.
- Panel instance behavior: binds to `manager.surface(sessionId)` (pinned), re-titles on `manager.onDidChangeSessions`, calls `manager.setActive(sessionId)` whenever the panel becomes visible (focusing a panel makes its session active in the sidebar too), and on dispose tears down its disposables and removes itself from the static map. Title format is `` `${entry.projectLabel} · ${entry.name ?? `#${entry.ordinal}`}` ``, or `"OMP"` when the entry is gone.

#### `bind(webview, surface, extensionUri)`

Sets `webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")] }` — `WEBVIEW_DIR = ["dist", "webview"]` is the only permitted local root, and the same array is passed to `createWebviewPanel`. It then assigns `webview.html = renderHtml(...)` and returns a `vscode.Disposable` that tears down both directions: `surface.subscribe(m => webview.postMessage(m))` and `webview.onDidReceiveMessage(m => surface.handleWebviewMessage(m))`. Order matters — the surface's snapshot arrives on attach, events after.

#### `renderHtml` — CSP, verbatim

Assets resolve to `<extensionUri>/dist/webview/assets/index.js` and `.../index.css` through `webview.asWebviewUri`. The nonce is 32 characters drawn from `"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"` via `Math.random()`, regenerated per render.

```ts
const csp = [
	"default-src 'none'",
	`img-src ${webview.cspSource} data: https:`,
	`font-src ${webview.cspSource} data:`,
	`style-src ${webview.cspSource} 'unsafe-inline'`,
	`script-src 'nonce-${token}' 'strict-dynamic'`,
	"connect-src 'none'",
].join("; ");
```

`'strict-dynamic'` is required because the entry chunk pulls lazily-loaded chunks (mermaid, highlight grammars) in through dynamic import. The document is emitted with `<meta http-equiv="Content-Security-Policy" content="${csp}" />`, a `<link rel="stylesheet">` for the CSS, `<div id="root"></div>`, and `<script type="module" nonce="${token}" src="${script}"></script>`.

### `src/view/diff-provider.ts`

Backs the read-only left/right sides of an edit-tool diff view. Contents are held in memory and keyed by an opaque id, so a diff can be opened straight from a tool card without touching the filesystem.

| Export | Kind | Signature |
|---|---|---|
| `OMP_DIFF_SCHEME` | const | `"omp-diff"` |
| `DiffContentProvider` | class | `implements vscode.TextDocumentContentProvider, vscode.Disposable` |

- `OMP_DIFF_SCHEME` — the URI scheme the provider must be registered under (`vscode.workspace.registerTextDocumentContentProvider(OMP_DIFF_SCHEME, provider)`); registration happens in the extension entry point, not in this file.
- `DiffContentProvider` public members:
  - `readonly onDidChange: vscode.Event<vscode.Uri>` — the `TextDocumentContentProvider` change signal, backed by a private emitter. Nothing in this file ever fires it; stored content is immutable once written.
  - `provideTextDocumentContent(uri: vscode.Uri): string` — looks up `uri.path` and returns `""` for unknown keys rather than throwing, so a stale diff tab renders empty instead of erroring.
  - `store(label: string, content: string): vscode.Uri` — **keying scheme:** `` `/${++this.#next}/${label}` `` from a per-instance counter starting at `0` (first key is `/1/<label>`). The counter guarantees uniqueness, so the same label can be stored repeatedly; the label rides along only so the tab shows a readable name. Returns `vscode.Uri.from({ scheme: OMP_DIFF_SCHEME, path: key })`.
  - `dispose(): void` — clears the content map (releasing memory for all stored diffs) and disposes the emitter. Not idempotency-guarded, but both operations are safe to repeat.

### `src/view/diagram-preview.ts`

Opens a mermaid diagram in an editor tab, where it gets the full editor width and VS Code's image zoom instead of a sidebar column's worth of pixels. The webview has already rendered the diagram, so its SVG is reused verbatim rather than dragging mermaid into the extension host.

| Export | Kind | Signature |
|---|---|---|
| `DiagramRequest` | interface | `{ source: string; svg: string; background: string }` |
| `openDiagram` | function | `openDiagram(diagram: DiagramRequest): Promise<void>` |
| `standalone` | function | `standalone(svg: string, background: string): string` |

`DIRECTORY` (`<os.tmpdir()>/omp-diagrams`), `IMAGE_PREVIEW` (`"imagePreview.previewEditor"`), `MIN_WIDTH` (1200), `MAX_SCALE` (3), `sequence`, and `fill` are module-private.

- `openDiagram` — with an empty (whitespace-only counts) `svg` there is nothing to show, so `workspace.openTextDocument({ content: source, language: "mermaid" })` is opened as a preview text document and no file is written. Otherwise `standalone(svg, background)` is written to `<tmp>/omp-diagrams/diagram-<base36 ms>-<sequence>.svg` (the counter keeps two diagrams opened in the same millisecond apart), then opened with `vscode.openWith` pinned to `imagePreview.previewEditor` so a workspace that has remapped `.svg` to the text editor still gets a picture; if that view type is unavailable the call falls back to `vscode.open`. Failures propagate to `handleWebviewMessage`, which notifies.
- `standalone` — makes mermaid's inline SVG viewable as a file. Returns the input untouched when it does not start with `<svg` or has no `>`. From the opening tag it strips every `width`/`height` attribute and any `max-width:` declaration (the container fit that would otherwise collapse the image), inserts the SVG namespace when missing, and — when a `viewBox` is present — pins `width`/`height` to the viewBox dimensions scaled by `min(MAX_SCALE, max(1, MIN_WIDTH / viewBoxWidth))` and prepends a `<rect>` covering the viewBox in `fill(background)`. The scale exists because a 400px diagram in a 1400px editor tab is the complaint that sent the user there; the file stays vector, so zoom costs nothing. The backdrop keeps a dark-theme diagram off the image preview's transparency checkerboard.
- `fill(background)` (private) — the backdrop arrives as a computed style but lands in an attribute, so anything outside `[\w#(),.%/ -]` is replaced with `#ffffff`.

---

## 3. Shared Contracts (`src/shared/`)

Code shared verbatim by the extension host and the webview bundle: the hand-maintained mirror of the `omp --mode rpc-ui` wire contract, the host↔webview message protocol, the UI conversation model plus its pure reducer, and two structural guards. Nothing here imports Node or `vscode`, so every file is safe to pull into the webview bundle.

### `src/shared/protocol.ts`

Hand-maintained copy of the omp RPC wire shapes (commands, responses, transport frames, extension-UI sub-protocol, session events, messages and content blocks). Kept as a copy rather than a dependency so the extension builds without the agent package installed, and so the webview bundle stays free of Node imports. Payloads this UI forwards without interpreting stay `unknown`.

| Export | Kind | Signature |
|---|---|---|
| `MAX_RPC_FRAME_BYTES` | const | `1024 * 1024` |
| `MAX_RPC_REASSEMBLED_BYTES` | const | `64 * 1024 * 1024` |
| `RPC_CHUNK_PAYLOAD_BYTES` | const | `256 * 1024` |
| `ThinkingLevel` | type | `"inherit" \| "off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` |
| `QueueMode` | type | `"all" \| "one-at-a-time"` |
| `InterruptMode` | type | `"immediate" \| "wait"` |
| `SubagentSubscriptionLevel` | type | `"off" \| "progress" \| "events"` |
| `ApprovalMode` | type | `"always-ask" \| "write" \| "yolo"` |
| `StopReason` | type | `"stop" \| "length" \| "toolUse" \| "error" \| "aborted"` |
| `Model` | interface | `{ id: string; name: string; provider: string; api?: string; baseUrl?: string; reasoning?: boolean; input?: string[]; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; contextWindow?: number; maxTokens?: number; [key: string]: unknown }` |
| `TextContent` | interface | `{ type: "text"; text: string; textSignature?: string }` |
| `ThinkingContent` | interface | `{ type: "thinking"; thinking: string; thinkingSignature?: string; itemId?: string }` |
| `RedactedThinkingContent` | interface | `{ type: "redactedThinking"; data: string }` |
| `ImageContent` | interface | `{ type: "image"; data: string; mimeType: string; detail?: "auto" \| "low" \| "high" \| "original" }` |
| `ToolCallContent` | interface | `{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; intent?: string; customWireName?: string; rawBlock?: string; thoughtSignature?: string }` |
| `OpaqueContent` | interface | `{ type: "fallback" \| "anthropicServerTool"; [key: string]: unknown }` |
| `AssistantContent` | type | `TextContent \| ThinkingContent \| RedactedThinkingContent \| ImageContent \| ToolCallContent \| OpaqueContent` |
| `UserContent` | type | `TextContent \| ImageContent` |
| `Usage` | interface | `{ input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; contextTokens?: number; reasoningTokens?: number; premiumRequests?: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; [key: string]: unknown }` |
| `UserMessage` | interface | `{ role: "user"; content: string \| UserContent[]; synthetic?: boolean; steering?: boolean; attribution?: "user" \| "agent"; timestamp: number }` |
| `DeveloperMessage` | interface | `{ role: "developer"; content: string \| UserContent[]; attribution?: "user" \| "agent"; timestamp: number }` |
| `AssistantMessage` | interface | `{ role: "assistant"; content: AssistantContent[]; api?: string; provider?: string; model?: string; usage?: Usage; stopReason?: StopReason; errorMessage?: string; errorStatus?: number; errorId?: number; responseId?: string; timestamp: number; duration?: number; ttft?: number; [key: string]: unknown }` |
| `ToolResultMessage` | interface | `{ role: "toolResult"; toolCallId: string; toolName: string; content: Array<TextContent \| ImageContent>; details?: unknown; isError: boolean; useless?: boolean; prunedAt?: number; timestamp: number }` |
| `CustomMessage` | interface | `{ role: "custom" \| "hookMessage"; customType: string; content: string \| Array<TextContent \| ImageContent>; display: boolean; details?: unknown; timestamp: number }` |
| `BashExecutionMessage` | interface | `{ role: "bashExecution"; command: string; output: string; exitCode: number \| undefined; cancelled: boolean; truncated: boolean; excludeFromContext?: boolean; timestamp: number }` |
| `PythonExecutionMessage` | interface | `{ role: "pythonExecution"; code: string; output: string; exitCode: number \| undefined; cancelled: boolean; truncated: boolean; excludeFromContext?: boolean; timestamp: number }` |
| `FileMentionMessage` | interface | `{ role: "fileMention"; files: Array<{ path: string; content: string; lineCount?: number; byteSize?: number; skippedReason?: "tooLarge" \| "binary"; image?: ImageContent }>; timestamp: number }` |
| `SummaryMessage` | interface | `{ role: "branchSummary" \| "compactionSummary"; content?: string \| Array<TextContent \| ImageContent>; summary?: string; shortSummary?: string; timestamp: number; [key: string]: unknown }` |
| `AgentMessage` | type | `UserMessage \| DeveloperMessage \| AssistantMessage \| ToolResultMessage \| CustomMessage \| BashExecutionMessage \| PythonExecutionMessage \| FileMentionMessage \| SummaryMessage` |
| `AgentMessageRole` | type | `AgentMessage["role"]` |
| `AssistantMessageEvent` | type | 13-variant union discriminated on `type` — see bullet |
| `TruncationMeta` | interface | `{ direction: "head" \| "tail" \| "middle"; truncatedBy: "lines" \| "bytes" \| "middle"; totalLines: number; totalBytes: number; outputLines: number; outputBytes: number; maxBytes?: number; shownRange?: { start: number; end: number }; headRange?: { start: number; end: number }; tailRange?: { start: number; end: number }; elidedBytes?: number; elidedLines?: number; artifactId?: string; nextOffset?: number }` |
| `OutputMeta` | interface | `{ truncation?: TruncationMeta; source?: { type: "path" \| "url" \| "internal"; value: string }; diagnostics?: { summary: string; messages: string[] }; limits?: { matchLimit?: { reached: number; suggestion: number }; resultLimit?: { reached: number; suggestion: number }; headLimit?: { reached: number; suggestion: number }; columnTruncated?: { maxColumn: number } } }` |
| `AgentToolResult` | interface | `{ content: Array<TextContent \| ImageContent>; details?: unknown; isError?: boolean; useless?: boolean }` |
| `TodoStatus` | type | `"pending" \| "in_progress" \| "completed" \| "abandoned" \| "blocked"` |
| `TodoItem` | interface | `{ content: string; status: TodoStatus; blocker?: string }` |
| `TodoPhase` | interface | `{ name: string; tasks: TodoItem[] }` |
| `ContextUsage` | interface | `{ tokens: number; contextWindow: number; percent: number }` |
| `RpcSessionState` | interface | `{ model?: Model; thinkingLevel?: ThinkingLevel; isStreaming: boolean; isCompacting: boolean; steeringMode: QueueMode; followUpMode: QueueMode; interruptMode: InterruptMode; sessionFile?: string; sessionId: string; sessionName?: string; autoCompactionEnabled: boolean; fastModeEnabled: boolean; fastModeActive: boolean; tokensPerSecond: number \| null; messageCount: number; queuedMessageCount: number; todoPhases: TodoPhase[]; systemPrompt?: string[]; dumpTools?: Array<{ name: string; description: string; parameters: unknown }>; contextUsage?: ContextUsage }` |
| `SessionStats` | interface | `{ sessionFile?: string; sessionId: string; userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number }; premiumRequests: number; cost: number; contextUsage?: ContextUsage }` |
| `SlashCommand` | interface | `{ name: string; aliases?: string[]; description?: string; input?: { hint?: string }; subcommands?: Array<{ name: string; description?: string; usage?: string }>; source: string }` |
| `LoginProvider` | interface | `{ id: string; name: string; available: boolean; authenticated: boolean }` |
| `SubagentStatus` | type | `"pending" \| "running" \| "completed" \| "failed" \| "aborted"` |
| `SubagentLifecycleStatus` | type | `"started" \| "completed" \| "failed" \| "aborted"` |
| `AgentProgress` | interface | `{ index: number; id: string; agent: string; agentSource: string; status: SubagentStatus; task: string; assignment?: string; description?: string; lastIntent?: string; currentTool?: string; currentToolArgs?: string; currentToolStartMs?: number; recentTools?: Array<{ tool: string; args: string; endMs: number }>; recentOutput?: string[]; toolCount: number; requests: number; tokens: number; contextTokens?: number; contextWindow?: number; cost: number; durationMs: number; resolvedModel?: string; resolvedModelIsFallback?: boolean; retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAtMs: number } }` |
| `SubagentSnapshot` | interface | `{ id: string; index: number; agent: string; agentSource?: string; description?: string; status: SubagentStatus; task?: string; assignment?: string; sessionFile?: string; lastUpdate: number; progress?: AgentProgress; parentToolCallId?: string }` |
| `SubagentLifecyclePayload` | interface | `{ id: string; agent: string; agentSource: string; description?: string; status: SubagentLifecycleStatus; sessionFile?: string; parentToolCallId?: string; index: number; detached?: boolean }` |
| `SubagentProgressPayload` | interface | `{ index: number; agent: string; agentSource: string; task: string; parentToolCallId?: string; assignment?: string; progress: AgentProgress; sessionFile?: string; detached?: boolean }` |
| `SubagentEventPayload` | interface | `{ id: string; event: AgentSessionEvent }` |
| `SubagentMessagesResult` | interface | `{ sessionFile: string; fromByte: number; nextByte: number; reset: boolean; entries: unknown[]; messages: AgentMessage[] }` |
| `RpcCommand` | type | 40-variant union; every variant is `{ id?: string; type: …; … }` — see bullet |
| `RpcCommandType` | type | `RpcCommand["type"]` |
| `RpcResponseData` | interface | per-command success `data` map — see bullet |
| `RpcResponse` | type | `{ id?: string; type: "response"; command: string; success: true; data?: unknown } \| { id?: string; type: "response"; command: string; success: false; error: string; code?: string }` |
| `RpcReadyFrame` | interface | `{ type: "ready"; protocolVersion: 1; supportedProtocolVersions: number[]; maxFrameBytes: number; maxReassembledFrameBytes: number }` |
| `RpcChunkFrame` | interface | `{ type: "rpc_chunk"; chunkId: string; index: number; count: number; byteLength: number; data: string }` |
| `RpcFrameErrorFrame` | interface | `{ type: "rpc_frame_error"; originalType?: string; error: string }` |
| `RpcAvailableCommandsUpdateFrame` | interface | `{ type: "available_commands_update"; commands: SlashCommand[] }` |
| `RpcPromptResultFrame` | interface | `{ type: "prompt_result"; id?: string; agentInvoked: boolean }` |
| `RpcExtensionErrorFrame` | interface | `{ type: "extension_error"; extensionPath: string; event: string; error: string }` |
| `RpcCommandOutputFrame` | interface | `{ type: "command_output"; text: string }` |
| `RpcSessionInfoUpdateFrame` | interface | `{ type: "session_info_update"; title?: string; sessionId?: string }` |
| `RpcConfigUpdateFrame` | interface | `{ type: "config_update"; model?: Model; thinkingLevel?: ThinkingLevel }` |
| `RpcSubagentLifecycleFrame` | interface | `{ type: "subagent_lifecycle"; payload: SubagentLifecyclePayload }` |
| `RpcSubagentProgressFrame` | interface | `{ type: "subagent_progress"; payload: SubagentProgressPayload }` |
| `RpcSubagentEventFrame` | interface | `{ type: "subagent_event"; payload: SubagentEventPayload }` |
| `RpcSubagentFrame` | type | `RpcSubagentLifecycleFrame \| RpcSubagentProgressFrame \| RpcSubagentEventFrame` |
| `RpcExtensionUIRequest` | type | 11-variant union; every variant is `{ type: "extension_ui_request"; id: string; method: …; … }` — see bullet |
| `ExtensionUIMethod` | type | `RpcExtensionUIRequest["method"]` |
| `BlockingUIMethod` | type | `"select" \| "confirm" \| "input" \| "editor"` |
| `RpcExtensionUIResponse` | type | `{ type: "extension_ui_response"; id: string; value: string } \| { type: "extension_ui_response"; id: string; confirmed: boolean } \| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean }` |
| `APPROVE_LABEL` | const | `"Approve"` |
| `DENY_LABEL` | const | `"Deny"` |
| `OTHER_OPTION_LABEL` | const | `"Other (type your own)"` |
| `RECOMMENDED_SUFFIX` | const | `" (Recommended)"` |
| `AgentSessionEvent` | type | 24-variant union discriminated on `type` — see bullet |
| `AgentSessionEventType` | type | `AgentSessionEvent["type"]` |
| `isAgentSessionEvent` | function | `isAgentSessionEvent(frame: { type?: unknown }): frame is AgentSessionEvent` |
| `RpcInboundFrame` | type | `RpcReadyFrame \| RpcResponse \| RpcChunkFrame \| RpcFrameErrorFrame \| RpcAvailableCommandsUpdateFrame \| RpcPromptResultFrame \| RpcExtensionErrorFrame \| RpcExtensionUIRequest \| RpcSubagentFrame \| RpcCommandOutputFrame \| RpcSessionInfoUpdateFrame \| RpcConfigUpdateFrame \| AgentSessionEvent` |

- Chunking / limits — `MAX_RPC_FRAME_BYTES` (1 MiB) is the per-line frame ceiling; oversized frames travel as `rpc_chunk` frames carrying `RPC_CHUNK_PAYLOAD_BYTES` (256 KiB) of payload each, tagged with `chunkId` / `index` / `count` / `byteLength`; `MAX_RPC_REASSEMBLED_BYTES` (64 MiB) caps the reassembled result. `RpcReadyFrame` restates the agent's own `maxFrameBytes` / `maxReassembledFrameBytes` at handshake time, so the two sides can disagree and the smaller wins.
- Protocol version — `RpcReadyFrame.protocolVersion` is the literal `1` (the pre-negotiation baseline advertised in `ready`, alongside `supportedProtocolVersions: number[]`); the `negotiate_protocol` command carries `protocolVersion: number` and its success payload is the literal type `{ protocolVersion: 2 }`.
- `isAgentSessionEvent` — the file's only exported type guard. Returns true iff `frame.type` is a string present in the module-private `SESSION_EVENT_TYPES` lookup. Used to split session events out of the stdout frame stream; everything else is a response, transport frame, or side channel.
- `AssistantMessageEvent` variants (the payload of `message_update.assistantMessageEvent`): `start`, `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `image_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, `done` (`reason: "stop" | "length" | "toolUse"`, carries `message: AssistantMessage`), `error` (`reason: "aborted" | "error"`, carries `error: AssistantMessage`). Every variant except `done`/`error` carries `partial: AssistantMessage` — a fully-accumulated immutable snapshot of the message so far, so a client never has to reduce deltas itself. All variants except `start`/`done`/`error` also carry `contentIndex: number`; `text_delta`/`thinking_delta`/`toolcall_delta` carry `delta: string`, `text_end`/`thinking_end` carry `content: string`, `image_end` carries `content: ImageContent`, `toolcall_end` carries `toolCall: ToolCallContent`.
- `AgentSessionEvent` variants, grouped: **run lifecycle** — `agent_start`, `agent_end` (`messages?`, `messageCount?`, `isTerminal?`), `turn_start`, `turn_end` (`message`, `toolResults?`); **messages** — `message_start` (`message`), `message_update` (`message: AssistantMessage`, `assistantMessageEvent`), `message_end` (`message`); **tools** — `tool_execution_start` (`toolCallId`, `toolName`, `args?`, `intent?`), `tool_execution_update` (`toolCallId`, `toolName`, `args?`, `partialResult?`), `tool_execution_end` (`toolCallId`, `toolName`, `result?`, `isError?`); **compaction** — `auto_compaction_start` (`reason: "threshold" | "overflow" | "idle" | "incomplete"`, `action: "context-full" | "handoff" | "shake" | "snapcompact"`), `auto_compaction_end` (`action`, `aborted`, `willRetry`, `skipped?`, `errorMessage?`); **retry** — `auto_retry_start` (`attempt`, `maxAttempts`, `delayMs`, `errorMessage`, `errorId?`), `auto_retry_end` (`success`, `attempt`, `finalError?`), `retry_fallback_applied` (`from`, `to`, `role`), `retry_fallback_succeeded` (`model`, `role`); **config** — `model_changed` (carries no payload — refresh via `get_state` or the `config_update` frame), `thinking_level_changed` (`thinkingLevel?`, `configured?`, `resolved?`); **misc** — `ttsr_triggered` (`rules?`), `todo_reminder` (`todos?`, `attempt?`, `maxAttempts?`), `todo_auto_clear`, `irc_message` (`message: CustomMessage`), `notice` (`level: "info" | "warning" | "error"`, `message`, `source?`), `goal_updated` (`goal: unknown`).
- `RpcCommand` names, grouped: **handshake** — `negotiate_protocol` (`protocolVersion`); **prompting** — `prompt` (`message`, `images?`, `streamingBehavior?: "steer" | "followUp"`), `steer` (`message`, `images?`), `follow_up` (`message`, `images?`), `abort`, `abort_and_prompt` (`message`, `images?`); **session** — `new_session` (`parentSession?`), `get_state`, `switch_session` (`sessionPath`), `branch` (`entryId`), `get_branch_messages`, `set_session_name` (`name`), `handoff` (`customInstructions?`), `get_session_stats`, `export_html` (`outputPath?`); **message history** — `get_messages`, `get_messages_page` (`cursor?`, `limit?`), `get_last_assistant_text`; **model / thinking** — `set_model` (`provider`, `modelId`), `cycle_model`, `get_available_models`, `set_thinking_level` (`level`), `cycle_thinking_level`, `set_fast_mode` (`enabled`); **queueing** — `set_steering_mode` (`mode: QueueMode`), `set_follow_up_mode` (`mode: QueueMode`), `set_interrupt_mode` (`mode: InterruptMode`); **compaction / retry** — `compact` (`customInstructions?`), `set_auto_compaction` (`enabled`), `set_auto_retry` (`enabled`), `abort_retry`; **commands / todos** — `get_available_commands`, `set_todos` (`phases`); **subagents** — `set_subagent_subscription` (`level`), `get_subagents`, `get_subagent_messages` (`subagentId?`, `sessionFile?`, `fromByte?`); **shell** — `bash` (`command`), `abort_bash`; **auth** — `get_login_providers`, `login` (`providerId`). Sent host → agent, one JSON object per stdin line. Every variant carries an optional `id?: string` used to correlate the matching `RpcResponse`.
- `RpcResponseData` keys the success `data` payload by command name; commands absent from the map answer with no data. The 13 absent commands are `steer`, `follow_up`, `abort`, `abort_and_prompt`, `set_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `abort_bash`, `set_session_name`. Nullable/optional entries worth noting: `prompt` is `{ agentInvoked?: boolean } | undefined`; `cycle_model`, `cycle_thinking_level` and `handoff` can each be `null`.
- Outbound (agent → host) frame `type` values: `ready`, `response`, `rpc_chunk`, `rpc_frame_error`, `available_commands_update`, `prompt_result`, `extension_error`, `extension_ui_request`, `subagent_lifecycle`, `subagent_progress`, `subagent_event`, `command_output`, `session_info_update`, `config_update`, plus every `AgentSessionEvent` type. `RpcInboundFrame` is the union of all of them — "inbound" from the extension's point of view.
- `RpcExtensionUIRequest` methods: blocking (the agent waits for an `RpcExtensionUIResponse`) — `select` (`title`, `options`, `timeout?`), `confirm` (`title`, `message`, `timeout?`), `input` (`title`, `placeholder?`, `timeout?`), `editor` (`title`, `prefill?`, `promptStyle?`); non-blocking — `cancel` (`targetId`), `notify` (`message`, `notifyType?: "info" | "warning" | "error"`), `setStatus` (`statusKey`, `statusText: string | undefined`), `setWidget` (`widgetKey`, `widgetLines: string[] | undefined | null`, `widgetPlacement?: "aboveEditor" | "belowEditor"`), `setTitle` (`title`), `set_editor_text` (`text`), `open_url` (`url`, `launchUrl?`, `instructions?`). `BlockingUIMethod` names exactly the first four. Tool approval rides this channel: it arrives as `select` with options exactly `[APPROVE_LABEL, DENY_LABEL]` and a multi-line `title`. The server compares option labels by string equality, so `APPROVE_LABEL` / `DENY_LABEL` / `OTHER_OPTION_LABEL` / `RECOMMENDED_SUFFIX` must be echoed verbatim.

#### Key internal detail

`SESSION_EVENT_TYPES: Record<string, true>` is a module-private lookup listing exactly the 24 `AgentSessionEvent` type strings, and is the sole backing for `isAgentSessionEvent`. `session_shutdown` is deliberately absent: it is extension-runner-only and never hits the wire, so shutdown must be detected from child-process exit.

### `src/shared/bridge.ts`

The host↔webview message protocol and its view models. The host owns the agent process and the authoritative conversation state; the webview is a renderer that replays a `UiSnapshot` on attach and then folds forwarded events with the same reducer. Nothing here touches the RPC wire directly — the host translates.

| Export | Kind | Signature |
|---|---|---|
| `AgentStatus` | type | `"starting" \| "ready" \| "restarting" \| "exited" \| "error"` |
| `SessionSnapshot` | interface | see bullet |
| `UiDialog` | interface | `{ id: string; method: "select" \| "confirm" \| "input" \| "editor"; title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; promptStyle?: boolean; timeout?: number; approval?: { toolName: string; reason?: string; detail: string }; createdAt: number }` |
| `DialogAnswer` | type | `{ kind: "value"; value: string } \| { kind: "confirmed"; confirmed: boolean } \| { kind: "cancelled" }` |
| `SessionListEntry` | interface | `{ path: string; id: string; name: string; firstMessage: string; modified: number; created: number; messageCount: number; size: number; status: "complete" \| "interrupted" \| "aborted" \| "error" \| "pending" \| "unknown"; current: boolean }` |
| `ProjectEntry` | interface | `{ id: string; cwd: string; label: string; branch?: string }` |
| `SessionEntry` | interface | `{ id: string; projectId: string; projectLabel: string; ordinal: number; name?: string }` |
| `SessionStatus` | interface | `{ id: string; isStreaming: boolean; hasPendingDialog: boolean }` |
| `UiConfig` | interface | `{ showThinking: boolean; autoScroll: boolean; sendKeybinding: "enter" \| "ctrl+enter" }` |
| `UiSnapshot` | interface | `{ chat: ChatState; session: SessionSnapshot; commands: SlashCommand[]; models: Model[]; dialogs: UiDialog[]; subagents: SubagentState[]; config: UiConfig }` |
| `DraftState` | interface | `{ text: string; images: ImageContent[] }` |
| `HostMessage` | type | 19-variant union discriminated on `type` — see bullet |
| `WebviewMessage` | type | 34-variant union discriminated on `type` — see bullet |

- `SessionSnapshot` — `{ agentStatus: AgentStatus; statusDetail?: string; sessionId?: string; sessionName?: string; sessionFile?: string; model?: Model; thinkingLevel?: ThinkingLevel; isStreaming: boolean; isCompacting: boolean; fastModeEnabled: boolean; fastModeActive: boolean; autoCompactionEnabled: boolean; steeringMode: QueueMode; followUpMode: QueueMode; tokensPerSecond: number | null; queuedMessageCount: number; contextUsage?: ContextUsage; stats?: SessionStats; cwd: string; workspaceName: string }`. `statusDetail` is populated only when `agentStatus` is `error` or `exited`.
- `UiSnapshot` is the full re-hydration payload sent with `snapshot`; it is the only place the webview receives `ChatState` wholesale — after that it folds `events`.
- `UiDialog` — a blocking `extension_ui_request` awaiting the user; `method` is narrowed to the four blocking methods. `approval` is set when this `select` is the tool-approval gate rather than a plain question, and carries the parsed `toolName` / `reason` / `detail` so the webview can render an approval card instead of a generic picker.
- `DialogAnswer` is the discriminated reply the webview sends back through `dialogAnswer`; the host maps it onto the three `RpcExtensionUIResponse` shapes.
- `ProjectEntry` — a registered project/worktree that sessions can run in. A project is just a `cwd` plus display metadata; it owns no agent process. `id` is the resolved folder path, so registration survives reloads.
- `SessionEntry` — a live session: one `ChatController`, and therefore one `omp --mode rpc-ui` child process, running in its project's `cwd`. Several sessions can share a project, so ids are minted by the host rather than derived from the path; `ordinal` is the mint counter, used as a stable fallback label until the agent reports a session name. `projectLabel` is the project's label denormalised so the switcher needs no lookup.
- `SessionStatus` — compact live status of a session, forwarded to the switcher for badges. `hasPendingDialog` means a blocking approval/input dialog is awaiting the user.
- `DraftState` — composer text the user is drafting, persisted by the host across webview disposal and returned alongside the snapshot.
- `HostMessage` variants (host → webview), with payload fields:
  - `snapshot` — `snapshot: UiSnapshot`, `draft: DraftState`
  - `events` — `events: AgentSessionEvent[]`
  - `session` — `session: SessionSnapshot`
  - `commands` — `commands: SlashCommand[]`
  - `models` — `models: Model[]`
  - `todos` — `phases: TodoPhase[]`
  - `subagents` — `subagents: SubagentState[]`
  - `dialogOpen` — `dialog: UiDialog`
  - `dialogClose` — `id: string`
  - `config` — `config: UiConfig`
  - `notify` — `level: "info" | "warning" | "error"`, `message: string`
  - `commandOutput` — `text: string`
  - `setComposerText` — `text: string`
  - `appendComposerText` — `text: string`
  - `savedSessions` — `sessions: SessionListEntry[]` (the project's saved sessions on disk, for the resume menu)
  - `branchPoints` — `messages: Array<{ entryId: string; text: string }>`
  - `workspace` — `projects: ProjectEntry[]`, `sessions: SessionEntry[]`, `activeSessionId?: string` (the session this webview is showing)
  - `sessionStatus` — `id: string`, `isStreaming: boolean`, `hasPendingDialog: boolean` (the `SessionStatus` shape inlined structurally, not a reference to the interface)
  - `focusComposer` — no payload
- `WebviewMessage` variants (webview → host), with payload fields:
  - `ready` — no payload
  - `submit` — `text: string`, `images: ImageContent[]`, `behavior?: "steer" | "followUp"`
  - `abort` — no payload
  - `dialogAnswer` — `id: string`, `answer: DialogAnswer`
  - `setModel` — `provider: string`, `modelId: string`
  - `setThinkingLevel` — `level: ThinkingLevel`
  - `setFastMode` — `enabled: boolean`
  - `setAutoCompaction` — `enabled: boolean`
  - `setSteeringMode` — `mode: QueueMode`
  - `setTodos` — `phases: TodoPhase[]`
  - `compact` — no payload
  - `resetSession` — no payload; starts a fresh conversation inside the *current* agent process
  - `newSession` — `projectId?: string`; spawns an additional session with its own agent process in a project
  - `closeSession` — `id: string`; terminates a session's agent and drops it from the switcher
  - `requestSessions` — no payload
  - `switchSession` — `path: string` (a saved session file on disk)
  - `selectSession` — `id: string` (a live session in the switcher)
  - `addProjectFolder` — no payload
  - `removeProjectFolder` — `projectId: string`; drops a project from the roster, terminating every session it owns
  - `setSessionName` — `name: string`
  - `requestBranchPoints` — no payload
  - `branch` — `entryId: string`
  - `exportHtml` — no payload
  - `restartAgent` — no payload
  - `refreshState` — no payload
  - `saveDraft` — `draft: DraftState`
  - `openFile` — `path: string`, `line?: number`, `column?: number`
  - `openDiff` — `title: string`, `oldText: string`, `newText: string`, `path?: string`
  - `openExternal` — `url: string`
  - `openArtifact` — `url: string`
  - `openDiagram` — `source: string`, `svg: string`, `background: string`; opens a mermaid diagram full size in an editor tab. `svg` is the webview's render (empty when it failed), `background` the colour behind it
  - `copyText` — `text: string`
  - `revealSubagent` — `sessionFile: string`
  - `pickImages` — no payload
  - `showLog` — no payload
  - `loginProvider` — no payload
- Asymmetry worth knowing: `setSteeringMode` exists but there is no `setFollowUpMode` and nothing for `set_interrupt_mode`, even though `SessionSnapshot` reports `followUpMode` and `RpcSessionState` reports `interruptMode`. Likewise `switchSession` (by disk path) and `selectSession` (by live session id) are distinct messages that read almost identically.

### `src/shared/chat-model.ts`

The UI-facing conversation model plus the pure reducer that folds agent session events into it. Shared verbatim by host and webview: the host keeps an authoritative copy so a disposed/restored webview can be re-hydrated without replaying the whole session, and the webview runs the same reducer on the forwarded event stream so streaming stays incremental.

| Export | Kind | Signature |
|---|---|---|
| `ToolCallStatus` | type | `"pending" \| "running" \| "success" \| "error" \| "skipped"` |
| `ToolCallState` | interface | `{ toolCallId: string; name: string; args?: Record<string, unknown>; partialArgs?: string; intent?: string; status: ToolCallStatus; result?: AgentToolResult; partialResult?: AgentToolResult; startedAt?: number; endedAt?: number }` |
| `UserItem` | interface | `{ kind: "user"; id: string; text: string; images: ImageContent[]; timestamp: number }` |
| `AssistantItem` | interface | `{ kind: "assistant"; id: string; content: AssistantContent[]; model?: string; provider?: string; usage?: Usage; stopReason?: StopReason; errorMessage?: string; streaming: boolean; timestamp: number; durationMs?: number }` |
| `ShellItem` | interface | `{ kind: "shell"; id: string; language: "bash" \| "python"; source: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean; timestamp: number }` |
| `CustomItem` | interface | `{ kind: "custom"; id: string; customType: string; text: string; timestamp: number }` |
| `FileMentionItem` | interface | `{ kind: "fileMention"; id: string; files: Array<{ path: string; lineCount?: number; byteSize?: number; skippedReason?: string }>; timestamp: number }` |
| `SummaryItem` | interface | `{ kind: "summary"; id: string; label: string; text: string; timestamp: number }` |
| `NoticeItem` | interface | `{ kind: "notice"; id: string; level: "info" \| "warning" \| "error"; text: string; source?: string; timestamp: number }` |
| `ChatItem` | type | `UserItem \| AssistantItem \| ShellItem \| CustomItem \| FileMentionItem \| SummaryItem \| NoticeItem` |
| `RetryState` | interface | `{ attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }` |
| `CompactionState` | interface | `{ reason: string; action: string }` |
| `SubagentState` | interface | `{ id: string; index: number; agent: string; description?: string; task?: string; status: "pending" \| "running" \| "completed" \| "failed" \| "aborted"; parentToolCallId?: string; sessionFile?: string; toolCount?: number; tokens?: number; contextTokens?: number; contextWindow?: number; cost?: number; durationMs?: number; currentTool?: string; lastIntent?: string; resolvedModel?: string; lastUpdate: number }` |
| `ChatState` | interface | `{ items: ChatItem[]; toolCalls: Record<string, ToolCallState>; activeItemId: string \| null; running: boolean; compaction: CompactionState \| null; retry: RetryState \| null; todoPhases: TodoPhase[]; subagents: Record<string, SubagentState>; seq: number }` |
| `createChatState` | function | `createChatState(): ChatState` |
| `contentToText` | function | `contentToText(content: unknown): string` |
| `toolCallsIn` | function | `toolCallsIn(item: AssistantItem): ToolCallContent[]` |
| `applyEvent` | function | `applyEvent(state: ChatState, event: AgentSessionEvent): ChatState` |
| `applyMessages` | function | `applyMessages(state: ChatState, messages: AgentMessage[]): ChatState` |
| `todosFromToolCall` | function | `todosFromToolCall(result: AgentToolResult \| undefined): TodoPhase[] \| null` |
| `lastAssistant` | function | `lastAssistant(state: ChatState): AssistantItem \| undefined` |
| `AssistantMessage` | type re-export | `export type { AssistantMessage };` — re-exported from `./protocol` |

- `ChatItem` kinds: `user` (flattened text plus images), `assistant` (raw `AssistantContent[]` blocks with a `streaming` flag and usage/stop metadata), `shell` (covers both `bashExecution` and `pythonExecution`, discriminated by `language`), `custom` (from `custom`/`hookMessage`), `fileMention` (path metadata only — the wire message's file `content` is deliberately dropped), `summary` (from `branchSummary`/`compactionSummary`), `notice` (synthesized by the reducer; never a wire message). There is no `toolResult` kind by design.
- `ChatState` — `activeItemId` is the timeline id of the message currently being streamed, if any. `toolCalls` is keyed by `toolCallId` and lives beside `items` because tool results fold into their originating call card rather than occupying a timeline slot. `seq` is a monotonic id source that also doubles as a cheap change token.
- `ToolCallState.partialArgs` holds the raw JSON fragment accumulated while the arguments are still streaming; `partialResult` is a live partial result, replaced wholesale on every update and never appended.
- `createChatState()` returns a fresh zeroed state: empty `items`, empty `toolCalls`, `activeItemId: null`, `running: false`, `compaction: null`, `retry: null`, empty `todoPhases`, empty `subagents`, `seq: 0`.
- `contentToText(content)` flattens `string | Block[]` message content into plain text: returns a string as-is, returns `""` for non-arrays, otherwise concatenates the `text` of every block whose `type` is `"text"`. Non-text blocks are dropped silently.
- `toolCallsIn(item)` filters an `AssistantItem`'s content array down to the `toolCall` blocks, preserving order.
- `applyEvent(state, event)` — the core reducer; folds one agent session event into the conversation. **Referential-equality bail-out:** it returns the *same* `state` reference whenever nothing changed, so React subscribers can bail out cheaply with an identity check. The bail-out paths are: `agent_start` when `state.running` is already true; `agent_end` when `event.isTerminal === false`; `message_update` when the active item is missing or is not an assistant item; `message_end` for a `toolResult` whose fold returned the same object; `todo_reminder` (explicitly a no-op); and the `default` branch, which covers `turn_start`, `turn_end`, `model_changed`, `thinking_level_changed`, `ttsr_triggered`, `retry_fallback_succeeded`, `irc_message`, and `goal_updated`.
  - **`agent_end` terminality** — `isTerminal === false` is ignored outright, because the session re-arms itself for maintenance and async delivery; a run is only actually over when it settles terminally. A terminal `agent_end` sets `running: false` and clears `activeItemId` and `retry`.
  - **Wholesale message replacement** — `message_update` does *not* reduce deltas. `event.message` is already a fully-accumulated snapshot, so `content` replaces the existing array wholesale (`Array.isArray(event.message.content) ? event.message.content : existing.content`); `model`, `provider` and `usage` fall back to the existing value via `??`; `streaming` is forced `true`. If `activeItemId` is null, `message_update` instead appends a new streaming item and adopts it as active.
  - **toolResult folding** — `message_start` and `message_end` both special-case `message.role === "toolResult"` and route to the private `applyToolResultMessage`, which writes a `ToolCallState` under `message.toolCallId` — synthesizing an `AgentToolResult` from `content` / `details` / `isError` / `useless`, preserving `args` / `intent` / `startedAt` from any existing entry, and setting `endedAt: message.timestamp` — and adds no timeline item. `itemFromMessage` likewise returns `null` for `toolResult`. On `message_end` the fold additionally clears `activeItemId`.
  - **Synthetic / steering message filtering** — `itemFromMessage` returns `null` for a `user` message with `steering` or `synthetic` set (steering messages are queue plumbing; synthetic ones are harness-injected continuations; neither is something the user wrote), and for any user/developer message whose flattened text is empty *and* which carries no images. It also returns `null` for `custom`/`hookMessage` with `display === false`. When a filtered message arrives at `message_end` while an item already occupies `activeItemId`, that item is *removed* from `items` and `activeItemId` is cleared; in the no-active-item case the reducer still returns a new state with `seq` bumped, so the id counter stays monotonic even for suppressed messages.
  - **Benign skip** — a steering interrupt cancels queued tool calls by synthesizing a result, which must read as neutral rather than as a failure. Both `tool_execution_end` and the toolResult fold consult `isBenignSkip(result)` first and set `status: "skipped"` when it matches, otherwise `"error"` when the error flag is set, otherwise `"success"`. For `tool_execution_end` the error flag is `event.isError ?? event.result?.isError ?? false`; for the fold it is `message.isError`.
  - Remaining branches: `tool_execution_start` sets `status: "running"` and `startedAt: Date.now()`, merging `args`/`intent` over any existing entry; `tool_execution_update` sets `status: "running"` and replaces `partialResult`; `tool_execution_end` clears `partialResult` and sets `endedAt: Date.now()`; `auto_compaction_start` / `auto_compaction_end` set and clear `compaction`; `auto_retry_start` / `auto_retry_end` set and clear `retry`; `agent_start` also clears `retry`; `notice` appends a `NoticeItem` carrying the event's level / message / source; `retry_fallback_applied` appends a synthesized `warning` `NoticeItem` reading `` `Retrying on ${event.to} after ${event.from} failed (${event.role}).` ``; `todo_auto_clear` empties `todoPhases`. Note that nothing in `applyEvent` writes `state.subagents` or `state.todoPhases` (beyond clearing) — those are populated out of band by the host from `subagent_*` frames and `set_todos`.
- `applyMessages(state, messages)` rebuilds the whole conversation from a persisted message list. It resets `items`, `toolCalls` and `activeItemId` (keeping `seq`, `running`, `compaction`, `retry`, `todoPhases`, `subagents`), then for every assistant message pre-seeds a `pending` `ToolCallState` from each `toolCall` block — so a result arriving before its call still lands on a populated card — and folds each message through `applyEvent(next, { type: "message_end", message })`. It mutates `next.toolCalls` in place while seeding, which is safe only because `next` is a fresh object it just created.
- `todosFromToolCall(result)` extracts the latest todo snapshot the agent published through a `todo` tool call. Returns `null` when `result.details.phases` is missing or not an array; otherwise it defensively validates each phase (`name` must be a string, `tasks` an array) and each task (`content` and `status` must be strings), skipping anything malformed. `status` is cast to `TodoItem["status"]` without membership checking, and `blocker` is kept only if it is a string. A well-formed but empty `phases` array yields `[]`, not `null` — so callers must distinguish "no todo payload" from "todos cleared".
- `lastAssistant(state)` scans `items` backwards and returns the last `assistant` item, or `undefined`. Assistant messages carry the model that produced them, so the last one wins.

#### Key internal detail

Private helpers that shape the exported behavior: `contentToImages(content)` filters array content down to `type === "image"` blocks and returns `[]` for non-arrays; `isBenignSkip(result)` matches only when `result.details.source === "interrupt_skipped"` **and** either `details.__synthetic === true` or (`details.__interrupted === true` **and** `details.execution === "started"`); `nextId(state, prefix)` returns `` [`${prefix}-${seq}`, seq] `` with `seq = state.seq + 1` (prefixes in use: `msg`, `notice`); `replaceItem(items, id, next)` replaces by id and *appends* when the id is not found, so a stale `activeItemId` degrades to a duplicate rather than a lost message; `itemFromMessage(message, id, streaming)` maps an `AgentMessage` to `ChatItem | null`, defaulting a non-numeric `timestamp` to `Date.now()`, labelling summaries `"Branch summary"` vs `"Compacted"`, and picking summary text as `shortSummary ?? summary ?? contentToText(content)`.

### `src/shared/guards.ts`

The package's canonical structural guards. These narrow only enough to safely probe an unknown value's fields; every property stays `unknown`. Anything with a real contract should be narrowed on a discriminant instead.

| Export | Kind | Signature |
|---|---|---|
| `isRecord` | function | `isRecord(value: unknown): value is Record<string, unknown>` |
| `frameType` | function | `frameType(value: unknown): string \| undefined` |

- `isRecord` — `typeof value === "object" && value !== null && !Array.isArray(value)`. Functions are *not* records here, since `typeof` reports them as `"function"`.
- `frameType` — narrows a frame by its `type` discriminant without asserting the rest: returns `value.type` when `value` is a record and `type` is a string, otherwise `undefined`. Built on `isRecord`; this is the entry point for dispatching an untrusted stdout frame before casting it to `RpcInboundFrame`.

---

## 4. Webview Renderer

The React application that renders inside the VS Code webview panel. It owns no truth: the host is authoritative and this layer mirrors a `ChatState` snapshot, folds forwarded events into it, and posts intents back over `postMessage`. Everything under `webview/src/` other than `components/tools/` is covered here.

### `webview/index.html`

Vite entry document. No exports.

- Single `<div id="root">` plus `<script type="module" src="/src/main.tsx">`. Title is `OMP`. No CSP meta tag — the host injects the CSP when it rewrites this document for the webview.

### `webview/src/main.tsx`

Bootstrap. No exports.

- Registers a `window` `message` listener that funnels every `MessageEvent<HostMessage>` straight into `store.apply(event.data)` — there is no filtering or origin check here; the webview only ever receives from its host.
- Looks up `#root`; throws `new Error("missing #root")` if absent.
- Renders `<App />` inside `<StrictMode>` via `createRoot`.
- Imports `./theme.css` for its side effect.
- Posts `{ type: "ready" }` **after** the render call. This is the handshake that makes the host send the first `snapshot` and start the agent if needed, so the message listener is guaranteed to be installed before any reply can arrive.

### `webview/src/App.tsx`

Root layout component; fixed composition, no routing.

| Export | Kind | Signature |
|---|---|---|
| `App` | function component | `App(): JSX.Element` |

- `App` — subscribes to a single field, `state.hydrated`. Structure is `div.app` → `<SessionSwitcher/>`, `<SessionBar/>`, `div.app-body > main.app-main`, then `<DialogHost/>` and `<Toasts/>` as siblings (both render into the overlay layer / portal, so they sit outside `app-main`). Inside `app-main`, order is: `<Transcript/>` **or** `<div class="app-loading muted">Connecting to omp…</div>` when not yet hydrated, then `<SubagentPanel/>`, `<TodoPanel/>`, `<Composer/>`, `<StatusBar/>`. Only the transcript is gated on hydration; the chrome renders immediately.

### `webview/src/vscode.ts`

The single `acquireVsCodeApi` acquisition point for the whole bundle.

| Export | Kind | Signature |
|---|---|---|
| `vscodeApi` | const | `VsCodeApi` |
| `post` | function | `post(message: WebviewMessage): void` |

The (non-exported) interface it is typed against:

```ts
interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
```

- `vscodeApi` — module-scope `acquireVsCodeApi()` call. VS Code permits exactly one call per webview instance, so every consumer must import this binding rather than call the global again.
- `post` — thin typed wrapper over `vscodeApi.postMessage`. Its only job is to constrain the payload to `WebviewMessage` (from `src/shared/bridge`); `postMessage` itself takes `unknown`.
- `getState`/`setState` are declared on the interface but never used — draft persistence goes through the host (`saveDraft`), not webview state.

### `webview/src/store.ts`

The webview's mirror of host state, plus the `useSyncExternalStore` bindings that expose it to React.

| Export | Kind | Signature |
|---|---|---|
| `Toast` | interface | `{ id: number; level: "info" \| "warning" \| "error"; message: string }` |
| `UiState` | interface | see shape below |
| `store` | const | `UiStore` (singleton instance) |
| `registerComposerFocus` | function | `registerComposerFocus(focus: (() => void) \| undefined): void` |
| `focusComposer` | function | `focusComposer(): void` |
| `useUi` | hook | `useUi<T>(selector: (state: UiState) => T): T` |
| `useUiState` | hook | `useUiState(): UiState` |

`UiState` — the whole mirrored shape:

```ts
interface UiState {
	chat: ChatState;                                  // from src/shared/chat-model
	session: SessionSnapshot;
	commands: SlashCommand[];
	models: Model[];
	dialogs: UiDialog[];
	subagents: SubagentState[];
	config: UiConfig;                                 // { showThinking, autoScroll, sendKeybinding }
	savedSessions: SessionListEntry[];                // sessions on disk, for the resume menu
	branchPoints: Array<{ entryId: string; text: string }>;
	toasts: Toast[];
	commandOutput: string[];                          // local-only slash command output, newest last
	draft: DraftState;                                // { text: string; images: ImageContent[] }
	hydrated: boolean;                                // true once the first snapshot lands
	projects: ProjectEntry[];
	sessions: SessionEntry[];                         // live sessions, one agent process each
	activeSessionId: string | undefined;
	sessionStatuses: Record<string, SessionStatus>;
}
```

- `UiStore` (not exported as a type; only the `store` instance is). Private fields: `#state: UiState`, `#listeners: Set<() => void>`, `#nextToastId: number`.
  - `get state(): UiState` — current snapshot; always read through this in async callbacks rather than closing over a render-time value.
  - `subscribe = (listener: () => void) => () => boolean` — arrow property so it is reference-stable and safe to hand to `useSyncExternalStore`. Returns an unsubscribe closure.
  - `#set(next: UiState): void` — private. No-ops when `next === this.#state` (reference equality), otherwise assigns and notifies every listener. Every mutation goes through it, so the store is strictly immutable-replace.
  - `setDraft(draft: DraftState): void` — local-only; the host is told separately via a debounced `saveDraft`.
  - `dismissToast(id: number): void` — filters `toasts` by id.
  - `clearCommandOutput(): void` — early-returns when already empty, so it cannot cause a spurious render.
  - `apply(message: HostMessage): void` — the single reducer entry point. Exhaustive `switch` on `message.type`; every arm ends in `return`, and an unrecognised type falls out silently (forward compatibility with a newer host).
- **Snapshot vs incremental.** `"snapshot"` replaces `chat`, `session`, `commands`, `models`, `dialogs`, `subagents`, `config` and `draft` wholesale from `message.snapshot` / `message.draft` and sets `hydrated: true`. `"events"` instead folds `message.events` through `applyEvent(chat, event)` from `src/shared/chat-model` — the *same* reducer the host uses — starting from the current `chat`. If the fold returns the identical reference (no event changed anything) it returns without notifying. That is the whole streaming path: the transcript is never re-serialized between snapshots.
- Other `apply` arms, by `message.type`:
  - `"session"`, `"commands"`, `"models"`, `"subagents"`, `"config"`, `"savedSessions"` — straight field replacement.
  - `"todos"` — writes `chat.todoPhases = message.phases` (a shallow clone of `chat`; note this bypasses `applyEvent`).
  - `"dialogOpen"` — removes any existing dialog with the same id, then appends, so a re-open replaces in place and lands at the tail.
  - `"dialogClose"` — filters by `message.id`.
  - `"notify"` — appends a `Toast` with `id: ++this.#nextToastId` (monotonic, never reused).
  - `"commandOutput"` — appends `message.text`.
  - `"setComposerText"` — replaces `draft.text`; keeps `draft.images`.
  - `"appendComposerText"` — joins with `\n` when the draft is non-empty, otherwise sets the text directly.
  - `"branchPoints"` — `message.messages` → `branchPoints`.
  - `"workspace"` — replaces `projects`, `sessions`, `activeSessionId` together.
  - `"sessionStatus"` — upserts one entry into `sessionStatuses` keyed by `message.id`, storing `{ id, isStreaming, hasPendingDialog }`.
  - `"focusComposer"` — calls `focusComposer()` and mutates no state.
- `registerComposerFocus` / `focusComposer` — a module-level `composerFocus` slot outside the store. The composer registers a callback on mount and passes `undefined` on unmount; `focusComposer()` is a no-op when nothing is registered (`composerFocus?.()`). Used both by the host's `focusComposer` message and by the transcript's example-prompt buttons.
- `useUi` — wraps the selector in `useCallback` keyed on the selector identity, then `useSyncExternalStore`. **Callers must pass a module-scope selector** (every component in this tree defines `const selectX = (state: UiState) => …` at module level); an inline arrow would produce a new `getSnapshot` each render.
- `useUiState` — subscribes to the whole state object; re-renders on every store change.

#### Key internal detail

`INITIAL_SESSION` is the pre-hydration `SessionSnapshot`: `agentStatus: "starting"`, all booleans false except `autoCompactionEnabled: true`, `steeringMode`/`followUpMode` both `"one-at-a-time"`, `tokensPerSecond: null`, `queuedMessageCount: 0`, `cwd`/`workspaceName` empty. `initialState()` seeds `config` as `{ showThinking: true, autoScroll: true, sendKeybinding: "enter" }` — these defaults are visible for the brief window before the first `snapshot`/`config` message.

### `webview/src/format.ts`

Pure display formatters shared across the webview. No React, no state.

| Export | Kind | Signature |
|---|---|---|
| `formatNumber` | function | `formatNumber(value: number): string` |
| `formatBytes` | function | `formatBytes(value: number): string` |
| `formatDuration` | function | `formatDuration(ms: number \| undefined): string` |
| `formatCost` | function | `formatCost(usd: number \| undefined): string` |
| `formatRelativeTime` | function | `formatRelativeTime(timestamp: number): string` |
| `ContextLevel` | type | `"normal" \| "warning" \| "purple" \| "error"` |
| `contextLevel` | function | `contextLevel(percent: number, contextWindow: number): ContextLevel` |
| `formatContextUsage` | function | `formatContextUsage(percent: number \| undefined, contextWindow: number, usedTokens: number): string` |
| `basename` | function | `basename(filePath: string): string` |
| `shortenPath` | function | `shortenPath(filePath: string, segments?: number): string` |
| `languageFromPath` | function | `languageFromPath(filePath: string): string` |
| `stripAnsi` | function | `stripAnsi(text: string): string` |

- `formatNumber` — `"?"` for non-finite. `≥1e6` → `M` (0 decimals at `≥1e7`, else 1); `≥1e3` → `K` (0 decimals at `≥1e4`, else 1); otherwise `String(Math.round(value))`. Thresholds test `Math.abs`, so negatives get the same treatment.
- `formatBytes` — `"?"` for non-finite or negative. `<1024` → `"N B"` (integer, unrounded); `<1 MiB` → `"X.X KB"`; else `"X.X MB"`. No GB tier.
- `formatDuration` — **empty string** for `undefined`, non-finite, or negative (so callers can `length > 0` test). `<1s` → `"NNNms"`; `<60s` → `"N.Ns"`; else `"Nm Ns"`.
- `formatCost` — empty string for `undefined`, non-finite, or `<= 0`. Under `$0.01` uses 4 decimals, else 2.
- `formatRelativeTime` — from `Date.now()`: `"just now"` under 1m, then `"Nm ago"`, `"Nh ago"`, `"Nd ago"`. Always floors; never says "in the future".
- `contextLevel` — escalates on whichever of percent *or* absolute tokens trips first, via the internal `reachesThreshold(percent, contextWindow, percentThreshold, tokenThreshold)`. Bands: `error` at 90% or 500K tokens, `purple` at 70% or 270K, `warning` at 50% or 150K, else `normal`. With an unknown/zero `contextWindow` it degrades to the plain percent comparison; `percent <= 0` or non-finite always yields `normal`.
- `formatContextUsage` — `"42.0%/200K"` when the window is known; `"12.4K/?"` when it is not; `"?%/200K"` when the window is known but percent is `undefined`. Deliberately never prints `0.0%/0`.
- `basename` — strips trailing separators first, then takes the segment after the last `/` **or** `\`.
- `shortenPath` — splits on either separator dropping empties; returns the input unchanged when it has `<= segments` parts, otherwise `…/` + the last `segments` joined with `/`. Default `segments = 3`.
- `languageFromPath` — extension → highlight.js language name via a fixed map (`ts→typescript`, `tsx`, `js/mjs/cjs→javascript`, `jsx`, `json`, `md→markdown`, `py→python`, `rs→rust`, `go`, `java`, `kt→kotlin`, `rb→ruby`, `php`, `cs→csharp`, `c`/`h→c`, `cpp`/`hpp→cpp`, `css`, `scss`, `html`, `xml`, `yml`/`yaml→yaml`, `toml`, `sh`/`bash`/`zsh→bash`, `ps1→powershell`, `sql`). Unknown extension → `""`. Extensionless paths take the whole string as the "extension" and miss the map.
- `stripAnsi` — removes ANSI SGR/CSI sequences (`/\x1B\[[0-?]*[ -/]*[@-~]/g`) then the C0 class `[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`. Tab (`\x09`), LF (`\x0A`) and CR (`\x0D`) are the only control characters that survive; vertical tab and form feed are stripped.

### `webview/src/components/Transcript.tsx`

The conversation timeline and its sticky-autoscroll machinery.

| Export | Kind | Signature |
|---|---|---|
| `Transcript` | function component | `Transcript(): ReactElement` |

Not memoized. Internal-only components: `EmptyState`, `CommandOutput`, `RetryStrip`.

- `Transcript` — reads six slices through module-scope selectors: `chat.items`, `session.isStreaming`, `config.autoScroll`, `chat.compaction`, `chat.retry`, `config.showThinking`.
- **Auto-scroll state machine.** Three pieces of state, deliberately split:
  - `followingRef: MutableRefObject<boolean>` — the authoritative "am I pinned to the bottom" flag, read from the observer callback without re-rendering.
  - `following: boolean` — mirrored into React state only so the "↓ Jump to latest" button can appear/disappear.
  - `autoScrollRef` — mirrors the `config.autoScroll` setting so the observer sees the current value without being torn down.

  On `scroll`, `distance = scrollHeight - scrollTop - clientHeight`; `following` flips to `distance <= FOLLOW_THRESHOLD_PX` (40). The handler early-returns when the value is unchanged, so scrolling within the bottom band costs no renders. A **single** `ResizeObserver` is installed once for the panel's lifetime (empty dep array) on the inner content column; its callback pins `scrollTop = scrollHeight` only when *both* `followingRef.current` and `autoScrollRef.current` are true. This is why streamed text, an expanding tool card, and a late-decoding image all keep the view pinned without any of them triggering a render here. `jumpToLatest` force-sets both flags and does a `behavior: "smooth"` scroll.
- **Streaming indicator.** The `working…` row shows only when `isStreaming` *and* the last item is not a visibly-populated streaming assistant message. `hasVisibleContent(item, showThinking)` walks `item.content`: `text` counts when non-blank after trim; `thinking` counts only when `showThinking` and non-blank; `redactedThinking`, `toolCall`, `image` always count; anything else is ignored. Without this, an encrypted-reasoning turn (`{ thinking: "" }`) or a turn with thinking disabled would render as a dead transcript.
- `EmptyState` — wordmark, `session.workspaceName` (or `"no folder open"`), and four `EXAMPLE_PROMPTS` buttons; clicking one calls `store.setDraft({ text: prompt, images: [] })` then `focusComposer()`.
- `CommandOutput` — renders each `state.commandOutput` entry through `stripAnsi` in a `<pre>`; every row carries a dismiss button that clears the **entire** list via `store.clearCommandOutput()`. Keyed by array index. Returns `null` when empty.
- `RetryStrip({ retry: RetryState })` — local countdown. Recomputes a `deadline = Date.now() + delayMs` in an effect keyed on `[retry, delayMs]` and ticks a 500 ms interval, displaying `Retry {attempt}/{maxAttempts} in {ceil(remaining/1000)}s` plus `retry.errorMessage` when present. A non-positive or non-numeric `delayMs` collapses to 0 and the `in Ns` suffix disappears.
- Compaction strip joins `compaction.action` and `compaction.reason` with `" · "`, skipping empty parts.

#### Key internal detail

`FOLLOW_THRESHOLD_PX = 40`. Items are keyed by `item.id`, which is what makes `MessageItem`'s `memo` effective.

### `webview/src/components/MessageItem.tsx`

Per-item dispatch for the transcript. One exported component; every renderer per `ChatItem.kind` is module-private.

| Export | Kind | Signature |
|---|---|---|
| `MessageItem` | memoized component | `React.memo(({ item }: { item: ChatItem }) => ReactElement \| null)` |

- `MessageItem` — **`memo`-wrapped** with the default shallow prop comparison. The chat reducer replaces only the items it touches, so memoizing on the `item` reference keeps a long transcript at one re-render per streamed frame. `MessageItemInner` switches on `item.kind`:
  - `"user"` → `UserBubble` — renders `item.text` through `<Markdown>` and `item.images` as `<img>`; returns `null` when both are empty.
  - `"assistant"` → `AssistantMessage` — maps `item.content` (keyed by index) through `AssistantBlock`, appends an `error`/`aborted` strip when `item.stopReason` says so, and renders `AssistantFooter` only once `item.streaming` is false. Returns `null` for an empty, non-failed, non-aborted message.
  - `"shell"` → `ShellCard` — prompt glyph is `>>>` for `item.language === "python"`, else `$`; output passes through `stripAnsi`; chips for a non-zero `exitCode`, `cancelled`, `truncated`.
  - `"custom"` → `CustomBlock` — labelled with `item.customType` (falling back to `"message"`), body in compact Markdown; `null` when the text is blank.
  - `"fileMention"` → `FileMentions` — a chip per file showing `basename(path)`; the meta suffix prefers `skippedReason`, then `formatNumber(lineCount) + " ln"`, then `formatBytes(byteSize)`. Clicking posts `{ type: "openFile", path }`.
  - `"summary"` → `SummaryStrip` — collapsed disclosure with local `open` state, disabled when the text is empty; shows `formatNumber(text.length)` chars in the header.
  - `"notice"` → `NoticeStrip` — tinted by `NOTICE_TINT` (`info`/`warning`/`error` → `tx-strip-info`/`-warn`/`-err`, defaulting to info).
  - `default` → `null`. An unknown kind means a newer omp, not a crash.
- `AssistantBlock({ block, streaming })` — per-block dispatch: `text` → `<Markdown>` (skipped when empty), `thinking` → `<Thinking text streaming>`, `redactedThinking` → a `redacted reasoning` chip, `toolCall` → `<ToolCallSlot>`, `image` → inline `<img>`. `fallback` / `anthropicServerTool` / unknown discriminants render nothing.
- `ToolCallSlot({ block })` — subscribes to **its own entry** in the live map via a `useCallback`-stabilised selector `state => state.chat.toolCalls[id]`, so a running tool re-renders itself rather than its whole message. Falls back to a `useMemo`-built `pending` `ToolCallState` (`status: "pending"`, name defaulting to `"tool"`, args defaulting to `{}`) because the content block can land a frame before `tool_execution_start` registers the call.
- `AssistantFooter` — chips for `item.model`, `formatNumber(usage.totalTokens) + " tok"`, `formatCost(usage.cost.total)`, `formatDuration(item.durationMs)`; returns `null` when all four are empty.
- `imageSource(image: ImageContent): string | null` (module-private) — the security-relevant helper. Empty data → `null`; an already-`data:`-prefixed payload is passed through unchanged (so a lenient provider cannot produce `data:image/png;base64,data:image/…`); otherwise the mime type is used only when it starts with `image/`, else forced to `image/png`.

### `webview/src/components/Composer.tsx`

The input surface: draft text, image attachments, slash completion, and send/steer/queue.

| Export | Kind | Signature |
|---|---|---|
| `Composer` | function component | `Composer(): ReactElement` |

Not memoized.

- **Send keybinding.** `config.sendKeybinding` is `"enter" | "ctrl+enter"`.
  - `"enter"`: a bare Enter (no Ctrl/Meta/Shift/Alt) submits; Ctrl/Cmd+Enter *inserts* a newline explicitly, because Chromium does not do it for that chord on its own; Shift/Alt+Enter fall through to the browser's own newline.
  - `"ctrl+enter"`: only Ctrl/Cmd+Enter (without Shift/Alt) submits; plain Enter is a newline.
  - Either way, submitting while `session.isStreaming` passes `behavior: "steer"`, otherwise `behavior` is omitted.
  - `event.nativeEvent.isComposing` short-circuits the whole handler so IME composition is never hijacked.
- **Slash menu integration.** `useSlashItems(draft.text, caret)` produces the completion state. `menuOpen = focused && slash !== null && !menuDismissed` — the `focused` term exists so a restored draft that happens to start with `/` does not pop a menu at nobody. When open, ArrowDown/ArrowUp wrap the active index modulo the item count, Escape sets `menuDismissed`, and Tab **or** Enter (without Shift/Alt) completes via `pick`. `pick` splices in `completion(...)`, parks the resulting caret in `pendingCaretRef`, and clears `menuDismissed` so a command with subcommands re-opens on the next token.
- **Caret restoration.** A `useLayoutEffect` keyed on the `draft` *object* (not the string — a completion can reproduce identical text and would otherwise strand the ref) auto-grows the textarea (`height = "auto"` then `scrollHeight`) and, when `pendingCaretRef.current !== null`, refocuses and sets the selection range.
- **Draft persistence.** A separate effect debounces `post({ type: "saveDraft", draft })` by `DRAFT_SAVE_DEBOUNCE_MS` (400), skipping when the draft already equals `savedDraftRef.current`. `submit` bypasses the debounce and posts an empty draft immediately.
- **Images.** `onPaste` collects clipboard items with `kind === "file"` and an `image/*` type; `onDrop` collects `dataTransfer.files` with an `image/*` type and clears the dragging highlight. Both funnel into `attach`, which reads each file through `readImage` (`FileReader.readAsDataURL`, then splits at the first comma and re-derives the mime from the `data:` prefix, falling back to `file.type` then `"image/png"`) and pushes an `ImageContent` per success. A failed read raises a local `warning` toast by calling `store.apply({ type: "notify", … })` directly. Drag-over only engages when `dataTransfer.types.includes("Files")`; drag-leave ignores events whose `relatedTarget` is still inside the composer. Thumbnails show `formatBytes(Math.floor(data.length * 0.75))` — the base64→bytes estimate — and each has a remove button. The paperclip button posts `{ type: "pickImages" }` so the host can open a native picker.
- **Send gating.** `canSend` requires `agentStatus` outside `{starting, exited, error}` **and** a non-blank text or at least one image. `submit` re-reads `store.state` rather than the render closure and re-checks the status, so a stale closure can never fire a message at a dead agent.
- **Blocked banner.** Derived from `agentStatus`: `starting` → info "Starting omp…", `restarting` → info "Restarting omp…", `exited` → error `statusDetail ?? "The omp process exited."`, `error` → error `statusDetail ?? "The omp process reported an error."`. Error levels get a Restart button posting `{ type: "restartAgent" }`.
- **Action row.** Queued-message chip when `session.queuedMessageCount > 0`, a `compacting` chip when `session.isCompacting`, the send hint, and — while streaming — a `Stop` button posting `{ type: "abort" }` alongside paired `Steer` / `Queue` buttons (`submit("steer")` / `submit("followUp")`). When not streaming, a single `Send`.
- Registers itself with `registerComposerFocus` on mount; the callback focuses the textarea and moves the caret to the end. Cleared to `undefined` on unmount.
- Textarea a11y: `aria-autocomplete="list"` and `aria-activedescendant={"slash-item-" + active}` when the menu is open; placeholder swaps to `"Steer the current turn…"` while streaming.

#### Key internal detail

`DRAFT_SAVE_DEBOUNCE_MS = 400`. `IS_MAC` is sniffed from `navigator.userAgent` (`/Mac|iP(?:hone|ad|od)/`) purely to render `MOD_KEY` as `⌘` vs `Ctrl` in the hint — the actual key handling accepts `ctrlKey || metaKey` on every platform. `patchDraft(patch: Partial<DraftState>)` merges against `store.state.draft`, never a render-time copy.

### `webview/src/components/SlashMenu.tsx`

Slash-command completion: context detection, fuzzy ranking, and the passive dropdown.

| Export | Kind | Signature |
|---|---|---|
| `SlashItem` | interface | `{ name: string; description?: string; hint?: string; source: string; matchedAlias?: string; score: number }` |
| `SlashContext` | interface | `{ stage: "command" \| "subcommand"; term: string; start: number; end: number; command?: SlashCommand }` |
| `SlashState` | interface | `{ context: SlashContext; items: SlashItem[]; groups: Array<{ source: string; items: SlashItem[] }> }` |
| `slashContext` | function | `slashContext(text: string, caret: number, commands: SlashCommand[]): SlashContext \| null` |
| `slashItems` | function | `slashItems(commands: SlashCommand[], context: SlashContext): SlashState \| null` |
| `useSlashItems` | hook | `useSlashItems(text: string, caret: number): SlashState \| null` |
| `completion` | function | `completion(text: string, context: SlashContext, item: SlashItem): { text: string; caret: number }` |
| `SlashMenu` | function component | `SlashMenu(props: { state: SlashState; activeIndex: number; onPick(item: SlashItem): void; onHover(index: number): void }): ReactElement` |

- **Trigger rules** (`slashContext`): the draft must start with `/` at position 0 — a slash mid-message never opens the menu. If the caret is at or before the first whitespace, the stage is `"command"` and the replacement range is `[0, firstBreak)` with `term` = text after the slash. Past that token, the menu only reopens when the typed command (matched case-insensitively against `name` **or** any `alias`) declares a non-empty `subcommands` array; then the range is the next whitespace-delimited token. A newline inside the gap between command and subcommand kills the context, as does a caret outside `[start, end]`. `SlashState.items` is the flattened group order, so an index maps 1:1 onto a visible row.
- `scoreOf(candidate, term)` (private) — `0` for an empty term (everything matches, original order preserved); exact 1000; prefix 800 (all prefix hits score alike, so the stable sort falls back to the order omp advertised — `/mo` offers `/model` before `/move`); substring at index `i>0` → `500 - i`; subsequence → `200 - haystack.length`; otherwise `null` (no match).
- `slashItems` — builds candidates via `commandItems` or `subcommandItems`, returns `null` on zero matches, sorts descending by score (stable, so ties keep host order), then buckets by `source` with each group positioned at its best match.
  - `commandItems` — `hint` comes from `command.input?.hint`; `source` defaults to `"commands"`. An alias hit scores `aliasScore - 1` and only wins if it beats the name score, so the canonical name wins ties; the winning alias is recorded in `matchedAlias` for display.
  - `subcommandItems` — `hint` comes from `subcommand.usage`; `source` is `` `/${command.name}` ``.
- `useSlashItems` — `useMemo` over `[commands, text, caret]`; composes `slashContext` then `slashItems`.
- `completion` — inserts `/name` at the command stage or bare `name` at the subcommand stage. If the character right after the replacement range is already a non-newline space, it reuses that space instead of doubling up and advances the returned caret past it; otherwise it appends its own trailing space.
- `SlashMenu` — deliberately **passive**: it is not focusable and handles no keys. The textarea keeps focus and `Composer` drives selection through `activeIndex`/`onPick`/`onHover`, which keeps arrow/Enter handling in one place instead of racing a second focusable widget. An effect scrolls `[data-active="true"]` into view (`block: "nearest"`) whenever `activeIndex` changes. Item `onMouseDown` calls `event.preventDefault()` so the click can never steal focus from the textarea. Rows carry `role="option"`, `aria-selected`, and `id={"slash-item-" + index}` to match the composer's `aria-activedescendant`.

### `webview/src/components/DialogHost.tsx`

The single blocking surface. Every dialog here is an `extension_ui_request` the agent is parked on.

| Export | Kind | Signature |
|---|---|---|
| `DialogHost` | function component | `DialogHost(): ReactElement \| null` |

Not memoized. Internal: `DialogCard`, `useDeadline`, `ApprovalBody`, `SelectBody`, `ConfirmBody`, `InputBody`, `EditorBody`.

- `DialogHost` — shows only the head of the queue. It tracks locally-`answered` ids and renders `pending[0] ?? dialogs[0]`, so a dialog we have already answered stays on screen until the host closes it or the next one arrives. That is what stops the `ask` multi-select loop from flashing the overlay on every toggle. An effect prunes `answered` ids the host has since dropped. Returns `null` when there are no dialogs.
- `DialogCard({ dialog, queued, sent, onAnswered })` — `DialogCardProps` is `{ dialog: UiDialog; queued: number; sent: boolean; onAnswered(id: string): void }`. `respond` is idempotent via `sentRef` (one answer per dialog, ever) and posts `{ type: "dialogAnswer", id, answer }`. Escape is bound at the **window in capture phase** so no focus trap or nested handler can swallow the one keystroke that guarantees the agent gets unblocked; it responds `{ kind: "cancelled" }`. Header shows the kind label, a spinner once `sent`, the countdown chip (turning `chip-err` at ≤10 s), and an `N more` chip for queued requests.
- **The four dialog kinds** (plus approval as a fifth branch). `KIND` maps `select→"Choose"`, `confirm→"Confirm"`, `input→"Input"`, `editor→"Compose"`, defaulting to `"Request"`; when `dialog.approval` is set (only possible on `method === "select"`) the label becomes `"Approval"` and body selection short-circuits to `ApprovalBody`.
  - `ApprovalBody({ dialog, approval, respond })` — props type `ApprovalBodyProps = { dialog: UiDialog; approval: NonNullable<UiDialog["approval"]>; respond: Respond }`. Focuses **Deny** on mount. Approve/deny labels are picked out of `dialog.options` (first option whose lowercase starts with `"approve"`, else `options[0]`, else `"Approve"`; deny is the first option that is not the approve label, else `"Deny"`) and echoed back byte-for-byte because the server compares with `===`. Renders `approval.toolName` (or `"this tool"`), an optional `approval.reason` callout, and `approval.detail` falling back to the raw `dialog.title` when the host's parse came back thin. Hint: "Esc denies".
  - `SelectBody({ dialog, respond })` — a `role="listbox"` div that takes focus on mount. Keys: ArrowDown/ArrowUp wrap, Home/End jump to the ends, Enter and Space pick the active row, and digits `1`–`9` jump directly to that index. The active row is scrolled into view on change. `MULTI_SELECT_TALLY = /^\((\d+) selected\)\s*/` is stripped off the title and re-rendered as a chip. Options equal to `OTHER_OPTION` (`"Other (type your own)"`) get a `free text` marker; options ending in `"Done selecting"` get their own class. A zero-option dialog renders an explicit "cancel to release the turn" message rather than a dead panel. Row keys are `` `${index}\u0000${option}` `` so duplicate labels are safe.
  - `ConfirmBody({ dialog, respond })` — Yes/No; **Yes** is focused on mount. Answers `{ kind: "confirmed", confirmed: boolean }`.
  - `InputBody({ dialog, respond })` — single-line `<input>` seeded from `dialog.prefill ?? ""`, focused and select-all'd on mount. Enter submits `{ kind: "value", value }`.
  - `EditorBody({ dialog, respond })` — `<textarea>` seeded from `dialog.prefill ?? ""`, focused with the caret at the end. **Ctrl/⌘+Enter** submits (plain Enter is a newline). When `dialog.promptStyle === true`, the title is split at the first newline: line one becomes a strong heading and the remainder — a pre-rendered ASCII radio list — is rendered as a `<pre>` context block rather than a heading.
- `Respond` (module-private type alias) — `(answer: DialogAnswer) => void`.
- `useDeadline(dialog, respond): number | null` — returns milliseconds remaining, or `null` for an open-ended dialog. Deadline is `(dialog.createdAt || mount time) + dialog.timeout`, only when `timeout` is a finite positive number. Ticks every 500 ms; on expiry it fires exactly once (`fired` latch) and auto-responds `{ kind: "cancelled" }`. `respond` is held in a ref so a changing callback identity cannot restart the timer.

### `webview/src/components/SessionBar.tsx`

Per-session chrome: name, status banner, and the new/resume/branch/overflow menus.

| Export | Kind | Signature |
|---|---|---|
| `SessionBar` | function component | `SessionBar(): ReactElement` |

Not memoized. Internal: `Mark` (the omp π-in-a-rounded-square SVG), `statusChipClass`, and `type Menu = "resume" | "branch" | "overflow"`.

- `SessionBar` — one `Menu` state drives three `Popover`s, each anchored to its own button ref and `align="right"`. `toggle(kind)` closes when re-clicked, and on open **also** posts the fetch the menu needs: `{ type: "requestSessions" }` for resume, `{ type: "requestBranchPoints" }` for branch. The list renders whatever has arrived so far, showing `"Loading sessions…"` until the host answers.
- **Rename.** The title is a button until clicked, then becomes a controlled `<input>` (`renameDraft: string | null`) with `autoFocus` and select-on-focus. Enter and blur both `commitRename`, which posts `{ type: "setSessionName", name }` only when the trimmed value is non-empty *and* different from the current name. Escape cancels and `stopPropagation`s so no outer Escape handler also fires. Display name is `session.sessionName ?? session.workspaceName`, falling back to `"Untitled session"`.
- **Status banner.** `agentStatus === "ready"` renders nothing; `starting`/`restarting` render a spinner banner; anything else renders an `role="alert"` error banner with `statusDetail` (or `"omp exited."` / `"omp failed to start."`) and a Restart button.
- **Resume popover.** One row per `savedSessions` entry keyed by `entry.path`; label is `entry.name || entry.firstMessage || entry.id.slice(0, 8)`; meta shows a status chip (hidden for `"unknown"`, coloured by `statusChipClass`: `error`→`chip-err`, `aborted`/`interrupted`→`chip-warn`, `pending`→`chip-accent`, else plain), `formatRelativeTime(entry.modified)` and a message count. The current entry is marked and its click is a no-op; others post `{ type: "switchSession", path }`.
- **Branch popover.** One row per `branchPoints` entry posting `{ type: "branch", entryId }`; empty state reads "No earlier messages to branch from."
- **Overflow popover.** Six actions, each closing the menu first: `resetSession` ("Clear this session's history, same agent"), `compact` (disabled while `session.isCompacting`), `exportHtml`, `loginProvider`, then after a separator `restartAgent` and `showLog`.
- Header also carries a `newSession` icon button and a streaming spinner (`role="status"`) while `session.isStreaming`.

### `webview/src/components/SessionSwitcher.tsx`

Project + session switcher for the top of every chat surface.

| Export | Kind | Signature |
|---|---|---|
| `SessionSwitcher` | function component | `SessionSwitcher(): ReactElement` |

Not memoized. Internal: `sessionLabel(entry: SessionEntry): string` — `entry.name?.trim() || "Session #" + entry.ordinal`, because the agent names sessions as it goes and until then the mint ordinal is the only identifier. Also `removeTitle(label: string, owned: number): string` — the remove button's tooltip, which names how many sessions go with the project (`"Remove X"` when it owns none).

- `SessionSwitcher` — reads `projects`, `sessions`, `activeSessionId`, `sessionStatuses`. The collapsed tab shows the active project's `label` (falling back to `active.projectLabel`, then `"Project"`), the active session label, the project's `branch`, and the active session's badges — a spinner for `isStreaming`, a dot for `hasPendingDialog` — plus a chevron. The tab's `title` is the project `cwd`.
- The popover groups sessions under their project. Each group header carries a per-project "start another session" button posting `{ type: "newSession", projectId }`; a project with no sessions shows "No sessions yet." Session rows post `{ type: "selectSession", id }` (skipped when already active) and carry the same `sessionStatus` badges — a `streaming` spinner row and an `approval` chip — which is the whole point of the switcher: seeing what a *background* session is doing. Each row is its own live agent process, so several sessions can run per project and several projects side by side.
- Close buttons post `{ type: "closeSession", id }` and are hidden entirely when `sessions.length <= 1`, since the window always keeps one session and the host would refuse. Each group header also carries a `ICON_TRASH` button posting `{ type: "removeProjectFolder", projectId }`, hidden unless some *other* project owns a session — the same condition the host refuses on.
- A trailing separator and an "Add folder…" item (leading `ICON_FOLDER_ADD` glyph in a `.row`) post `{ type: "addProjectFolder" }`.

### `webview/src/components/StatusBar.tsx`

omp's status line rebuilt as clickable chips.

| Export | Kind | Signature |
|---|---|---|
| `StatusBar` | function component | `StatusBar(): ReactElement` |

Not memoized. Every segment is responsible for its own silence — a segment with no value renders nothing rather than a zero, so the strip stays short until the session has something to report.

- **Model chip** — rendered when `session.model` exists or `models` is non-empty; label is `provider/id` or `"select model"`. Opens a `Popover` whose entries are grouped by `model.provider` (missing/empty provider bucketed as `"other"`) and sorted by `provider.localeCompare`, memoized on `models`. Picking posts `{ type: "setModel", provider, modelId }`.
- **Thinking chip** — cycles through `THINKING_CYCLE = ["off","minimal","low","medium","high","xhigh","max"]`; `"inherit"` is deliberately excluded because it is what you get, never what you pick. The next level is `(indexOf(current) + 1) % length` — an `undefined` current gives index `-1`, so the first click lands on `"off"`. Labels come from `THINKING_LABEL` (`inherit→auto`, `off→off`, `minimal→min`, `low→low`, `medium→med`, `high→high`, `xhigh→xhi`, `max→max`). Posts `{ type: "setThinkingLevel", level }`.
- **Context chip** — shown only when `session.contextUsage` exists and there are used tokens or a positive percent. Renders `formatContextUsage(...)`, a fill bar clamped to `[2, 100]`% (omitted when percent is unknown), an `auto` marker when `autoCompactionEnabled`, and `data-level` from `contextLevel(percent, contextWindow)`. Clicking **toggles auto-compaction** — `{ type: "setAutoCompaction", enabled: !session.autoCompactionEnabled }` — which is not obvious from the chip's content.
- **Throughput chip** — `tokensPerSecond.toFixed(1) + " tok/s"`, only when finite and `> 0`.
- **Fast chip** — always rendered. `fastModeEnabled` (the session setting) and `fastModeActive` (what the provider actually does) can legitimately disagree — a provider can refuse fast mode, or serve at priority regardless — so the chip shows the *effective* state (`chip-accent` follows `fastModeActive`, `aria-pressed` follows `fastModeEnabled`), sets `data-mismatch`, and puts the discrepancy in the tooltip. Clicking posts `{ type: "setFastMode", enabled: !session.fastModeEnabled }`.
- **Session id chip** — first 8 characters; clicking posts `{ type: "copyText", text: session.sessionId }`.
- Trailing workspace name, titled with `session.cwd`.
- `finite(value: unknown): number` (private) — coerces non-finite/non-number wire values to `0` so a bad number cannot paint a bar.

### `webview/src/components/TodoPanel.tsx`

The task plan panel, fed by `chat.todoPhases`.

| Export | Kind | Signature |
|---|---|---|
| `TodoPanel` | function component | `TodoPanel(): ReactElement \| null` |

Internal: `PhaseBlock` (**`memo`-wrapped with a custom comparator**), `TodoRow`, `summarize`, `tasksOf`, `samePhase`, and `interface Summary { total: number; done: number; blocked: number; current: string }`.

- `TodoPanel` — returns `null` when the summary total is 0, so the panel is invisible until the agent writes a plan. Header is a collapse toggle showing a progress bar (`round(done/total*100)`), `done/total done`, the first in-progress task's content when collapsed, and a `N blocked` chip. Phase names are only rendered when there is more than one phase.
- `summarize(phases): Summary` — `current` is the content of the **first** `in_progress` task encountered.
- `tasksOf(phase)` — defensive: returns `[]` unless `phase.tasks` is an array, and filters to entries with a string `content`.
- `PhaseBlock({ phase, showName })` — props type `PhaseBlockProps = { phase: TodoPhase; showName: boolean }`. Memoized with `samePhase`, which compares `showName`, then phase identity, then name, then each task's `content`/`status`/`blocker` pairwise. This exists because the host resends the whole phase array on every todo write; without it a single task flipping would re-render every row in a long plan. Open state is `override ?? (showName ? !untouched : true)` — a multi-phase plan folds phases where every task is still `pending` down to one line until touched; a single-phase plan is always open. Rows are keyed `` `${phase.name}\u0000${task.content}` ``.
- `TodoRow({ task })` — glyphs from `BOX` (`pending`/`in_progress`→`☐`, `completed`→`☑`, `abandoned`→`☒`, `blocked`→`⊘`, default `☐`); `STRUCK` marks `completed` and `abandoned`. The `todo-strike-in` animation class is applied **only** when a task transitions to `completed` while mounted (tracked in a `previousStatus` ref) — tasks already done at mount render struck without animating. `in_progress` boxes get a `pulse` class. A blocked task appends `" (blocked: {blocker})"`. `BOX`/`STRUCK` are indexed loosely by `Record<string, …>` because the wire can carry a status this build has never heard of.

### `webview/src/components/SubagentPanel.tsx`

Live subagent tree with per-agent progress.

| Export | Kind | Signature |
|---|---|---|
| `SubagentPanel` | function component | `SubagentPanel(): ReactElement \| null` |

Not memoized. Internal: `interface Node { agent: SubagentState; children: Node[] }`, `buildTree`, `AgentRow`.

- `SubagentPanel` — `null` when there are no subagents. Header counts running/queued/failed by scanning `subagents` and toggles the body. Roots come from `useMemo(() => buildTree(subagents), [subagents])`.
- `buildTree(agents: readonly SubagentState[]): Node[]` — groups by `parentToolCallId`. Deliberately forgiving: a parent id that is missing from the set, or equal to the agent's own id, is ignored; a second pass walks each parent chain (bounded by `byId.size` hops) and drops any edge that closes a cycle. Everything that loses its parent lands in the root list, because a fan-out is more useful rendered flat than silently dropped. Siblings are sorted recursively by `agent.index ?? 0`.
- `AgentRow({ node })` — shows `#index`, agent name (default `"agent"`), a status chip from `STATUS_CHIP` (`running→chip-accent` with a spinner, `completed→chip-ok`, `failed→chip-err`, `aborted→chip-warn`, `pending→chip`), the `currentTool`, then meta: tool count with a `⚒` suffix, a context gauge whose `data-level` comes from `contextLevel(percent, budget)` (percent clamped to 100, omitted when `contextWindow` is absent), `formatCost(agent.cost)` and `formatDuration(agent.durationMs)`. Settled agents (`SETTLED` = completed/failed/aborted) get `data-dim`. The row is a `<button>` posting `{ type: "revealSubagent", sessionFile }` only when `agent.sessionFile` is a non-empty string; otherwise a plain `<div>`. Tooltip prefers `description`, then `task`, then `lastIntent`. Children recurse into a nested `<ul>`.

### `webview/src/components/Toasts.tsx`

Transient notifications fed by the store's `notify` arm.

| Export | Kind | Signature |
|---|---|---|
| `Toasts` | function component | `Toasts(): ReactElement \| null` |

Not memoized. Internal: `ToastRow`.

- `Toasts` — `null` when empty; otherwise a scrolling stack keyed by `toast.id`.
- `ToastRow({ toast }: { toast: Toast })` — auto-dismisses **only** `level === "info"` toasts after `INFO_TTL_MS` (6000) via `store.dismissToast(toast.id)`; warnings and errors persist until acknowledged. `role` is `"alert"` for errors and `"status"` otherwise. Marks come from `MARK` (`info→•`, `warning→!`, `error→✕`, default `•`). Every row carries an explicit dismiss button.

### `webview/src/components/Markdown.tsx`

The markdown pipeline. This is the hottest component in the app, and the file is structured around that.

| Export | Kind | Signature |
|---|---|---|
| `Markdown` | memoized component | `React.memo(({ text, compact }: { text: string; compact?: boolean }) => ReactElement)` |

- `Markdown` — **`memo`-wrapped**. Returns an empty fragment for empty text. Wraps `<ReactMarkdown>` in a `MarkdownBoundary` inside `div.md` (or `div.md md-compact`).
- **Everything is module scope on purpose.** `REMARK_PLUGINS` (`remarkGfm`, `remarkMath`), `REHYPE_PLUGINS` and `COMPONENTS` are hoisted constants: `Markdown` re-renders on every streaming delta of its message, and a fresh plugin array or component map would rebuild the unified processor each time. Note this is *not* lazy loading — the markdown/KaTeX/highlight stack is in the main chunk; only Mermaid (reached via `CodeBlock`) is dynamically imported.
- `REHYPE_PLUGINS` = `[rehypeLoneDisplayMath, [rehypeKatex, { throwOnError: false, strict: "ignore", errorColor: "#f05653" }], rehypeHighlight]`. KaTeX must not throw because half-written `$…` mid-stream is normal. `rehypeHighlight` runs with its default `detect: false`, so an unlabelled fence is left unhighlighted rather than guessed at.
- `rehypeLoneDisplayMath` (private plugin) — remark-math only treats a multi-line `$$` fence as display math, so a whole equation written on one `$$…$$` line renders inline and squashed. This walks the hast tree and, for any `<p>` whose only meaningful child is a single `.math-inline` element, rewrites the paragraph to a `<div>` (KaTeX's display wrapper is block-level and may not sit inside a `<p>`) and relabels the child `["math","math-display"]`. Mid-sentence `$$x$$` is untouched. It runs in hast rather than mdast because rehype-katex keys off those class names, not the mdast node type.
- `COMPONENTS` overrides:
  - `pre` → `Fence` — takes over the `<pre>` so `CodeBlock` owns the chrome, extracts the fence language from the `language-*` class on the inner `<code>`, collects the raw text for copy/line-count, and passes the **already-highlighted** `code` element through as children so rehype-highlight's spans survive.
  - `code` → `Code` — adds `md-code`. Inline styling is done with the CSS selector `:not(pre) > code` rather than a prop, because react-markdown 10 no longer reports inline-ness and the structural selector cannot be fooled by a fence with no language.
  - `a` → `Anchor` — the webview must never navigate away. `#`-fragments stay in-document (that is how GFM footnotes jump back and forth); `http(s):` links `preventDefault` and post `{ type: "openExternal", url }`; anything else degrades to a plain `<span>`.
  - `img` → `Image` — only `https://` or `data:image/…;` survive; otherwise the alt text renders as faint prose, or nothing. `loading="lazy"`.
  - `table` → `Table` — wraps in a scroll container (`div.md-table-wrap`).
- `urlTransform` — overrides react-markdown's default, which drops `data:` URLs, to allow `data:image/*` on `<img src>` (the host CSP permits `data:` and `https:` for `img-src`). Everything else falls through to `defaultUrlTransform`, coercing a rejected URL to `""`.
- `MarkdownBoundary` (private class component, props `{ text: string; children: ReactNode }`) — error boundary that degrades a throw anywhere in the pipeline to a raw `<pre>` of the source plus a "markdown failed to render" note, so a malformed payload can never blank the transcript. It recovers in `componentDidUpdate` when `text` changes rather than remounting on a key, so the next streamed delta clears the failure.

### `webview/src/components/CodeBlock.tsx`

Fenced-code chrome: language label, copy, collapse, and the Mermaid hand-off.

| Export | Kind | Signature |
|---|---|---|
| `CodeBlock` | function component | `CodeBlock({ language, text, children }: { language: string; text: string; children?: ReactNode }): ReactElement` |

Not memoized.

- `CodeBlock` — when `language === "mermaid"` it returns `<Mermaid source={code} />` immediately and renders no chrome of its own (`Mermaid` renders an equivalent head bar itself). Otherwise: a header with the language, a `N lines` count (only past the threshold) and a Copy button; the `<pre>` body; and a show-more/less toggle.
- Strips exactly one trailing newline (`remark-rehype` terminates the fence body with one, and it is not a line).
- Blocks longer than `COLLAPSED_LINES` (28) are clipped with an inline `maxHeight: calc(var(--md-fence-line) * 28)` and get a `Show N more line(s)` / `Show less` button; the singular/plural is handled.
- Copy posts `{ type: "copyText", text: code }` and flips the label to `Copied` for 1400 ms; the timer handle lives in a ref and is cleared both on re-copy and on unmount.
- Renders `children` (react-markdown's pre-highlighted `<code>`) when provided, falling back to `<code>{code}</code>` for direct callers.
- `countLines(text)` (private) — counts via repeated `indexOf("\n")` rather than `split("\n").length`, because splitting a 5000-line tool dump allocates an array that is immediately discarded.

### `webview/src/components/Mermaid.tsx`

Diagram rendering, lazily loaded and globally serialized.

| Export | Kind | Signature |
|---|---|---|
| `Mermaid` | function component | `Mermaid({ source }: { source: string }): ReactElement` |

Not memoized.

- **Lazy loading.** `mermaid` is pulled in with a dynamic `await import("mermaid")` inside the render effect, so it stays out of the main chunk — most sessions never render a diagram at all.
- **Serialization.** A module-level `queue: Promise<unknown>` chains every render (`queue = queue.then(render, render)` — the rejection handler is the same function, so one failure cannot stall the chain). Mermaid's layout engines are synchronous, so a 20-diagram fan-out rendering at once would lock the frame; this forces one at a time.
- **Debounce.** Each effect waits `SETTLE_MS` (150) before enqueueing, letting a streaming fence stop changing before any work is paid for. Cleanup clears the timeout and flips a `live` flag checked at every await boundary.
- **Theme.** `isLightTheme()` reads `document.body.classList` for `vscode-light` / `vscode-high-contrast-light`. A `MutationObserver` on `document.body`'s `class` attribute keeps it current, because VS Code swaps the theme class in place rather than reloading. Theme is a dep of the render effect, so the diagram re-renders on theme change. Font family and size are lifted from the computed body style (fallbacks `sans-serif` / `13`).
- `mermaid.initialize` is called with `{ startOnLoad: false, theme: light ? "default" : "dark", securityLevel: "strict", suppressErrorRendering: true, fontFamily, fontSize }`.
- **Cleanup.** Ids are `omp-mermaid-{n}` from a module counter. A `finally` block removes both `#id` and `#d{id}` from the document, because `mermaid.render` builds scratch nodes in the document and leaves them behind when it throws.
- **States.** Failure renders the head bar plus the raw source in a `<pre>` and "diagram failed to render"; pending renders a spinner and "rendering diagram…" with no head bar, since it is transient; success renders the head bar and `dangerouslySetInnerHTML` — the one sanctioned use in the webview, justified because the markup is mermaid's own output, not model or tool text.
- **Escape hatches.** A diagram scaled to fit the sidebar is often unreadable, so a fence-style head bar (`.md-fence-head`, label `mermaid`) carries two buttons, present in both the success and failure states:
  - **Copy** posts `{ type: "copyText", text: source }` — the *source*, not the SVG — and flips its label to `Copied` for 1400 ms; the timer handle lives in a ref cleared on re-copy and on unmount.
  - **Open** posts `{ type: "openDiagram", source, svg, background }`, which the host opens full size in an editor tab. `background` is the frame's computed `backgroundColor`, falling back to the body's when the frame has painted nothing (a computed colour ending in `, 0)` is transparent) — the image preview has no theme, so the file has to carry its own backdrop.

### `webview/src/components/Thinking.tsx`

A reasoning block: collapsed once settled, tailing while live.

| Export | Kind | Signature |
|---|---|---|
| `Thinking` | function component | `Thinking({ text, streaming }: { text: string; streaming?: boolean }): ReactElement \| null` |

Not memoized.

- Returns `null` when `config.showThinking` is off, and also when the body is blank — opus-5 emits encrypted reasoning as `{ thinking: "", thinkingSignature }`, and an empty block has nothing to say whether streaming or not. Both guards run *after* the hooks, so hook order is stable.
- `expanded = streaming || open`: a live block auto-expands, but only to its **last `TAIL_LINES` (40) lines**, so watching the model think never pushes the answer off screen. Once the user manually opens it (`open`), the full body renders even while streaming. When streaming ends it collapses back to the header unless opened. Reasoning is context, not the answer, which is why the settled default is collapsed.
- Header shows a caret, "Thinking", a spinner while live, `formatNumber(words)` words (titled with the exact character count), and `formatDuration(elapsedMs)` once at least a second has passed.
- Elapsed time starts on the first streaming render (`startRef` latched from 0 to `Date.now()`) and ticks once a second; it resets when streaming stops.
- `tailLines(text, lines)` and `countWords(text)` (private) — both scan without allocating: `tailLines` walks backwards with `lastIndexOf("\n")`, `countWords` counts whitespace-delimited runs by char code (space/LF/tab/CR) instead of splitting.

### `webview/src/components/Popover.tsx`

A floating panel anchored to a trigger element, portalled to `document.body` so no transcript ancestor can clip or stack it.

| Export | Kind | Signature |
|---|---|---|
| `Popover` | function component | `Popover({ anchor, onClose, children, align }: PopoverProps): ReactElement \| null` |

`PopoverProps` (not exported):

```ts
interface PopoverProps {
	anchor: HTMLElement | null;
	onClose(): void;
	children: ReactNode;
	align?: "left" | "right";   // default "left"
}
```

- **Open/closed is driven entirely by `anchor`**: a `null` anchor renders `null` and drops the stale placement so the next open measures from scratch. Callers pass `open ? ref.current : null`.
- **Positioning.** Measured, not declared. `measure()` reads the anchor's `getBoundingClientRect()` and the panel's `scrollHeight + 2` — the *unclamped* content height, so applying our own `maxHeight` back onto the panel cannot feed the flip decision. It places below the anchor when the content fits below **or** the space below is at least the space above; otherwise it flips above, clamping `top` to `VIEWPORT_MARGIN`. `maxHeight` is `Math.max(MIN_HEIGHT, availableSpace)`. Horizontally, `align: "right"` aligns the panel's right edge to the anchor's right edge, `"left"` to its left edge, then clamps into `[VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN]`. The placement setter returns the previous object when nothing changed, so measurement cannot loop. **First paint is a measuring pass** rendered at `top:0,left:0` with `visibility: "hidden"`.
- **Re-measure / dismiss.** A `ResizeObserver` on the panel re-measures when its content changes; `window resize` re-measures. Escape (document, capture phase) closes and both `preventDefault`s and `stopPropagation`s — Escape in the composer means something else entirely. `pointerdown` (capture) closes on any click outside the panel, **except** clicks on the anchor itself, whose own handler already toggles. `scroll` (capture) closes rather than reprojecting — cheaper and less jarring than chasing the anchor every frame — but scrolling *inside* the panel is explicitly exempted.
- **Focus.** On open, focuses the first `FOCUSABLE` descendant (or the panel itself, which is `tabIndex={-1}`) with `preventScroll: true`. On close it returns focus to the anchor **only if the panel still owns focus** — closing because the user clicked elsewhere must not steal it back — and only when `anchor.isConnected`.
- **Tab trap.** `onPanelKeyDown` cycles Tab/Shift+Tab between the first and last visible focusable descendants (filtered by `offsetParent !== null`, plus the currently-focused element). With no focusable children, Tab is simply swallowed.
- `onClose` is mirrored into a ref each render, so the document-level listeners stay stable even though callers pass inline arrows.

#### Key internal detail

`VIEWPORT_MARGIN = 8`, `ANCHOR_GAP = 4`, `MIN_HEIGHT = 120`. `FOCUSABLE` is `a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])`.

### `webview/src/components/Icon.tsx`

The chrome's icon primitive and its glyph set.

| Export | Kind | Signature |
|---|---|---|
| `Icon` | function component | `Icon({ path, nodes }: { path: string; nodes?: Array<[number, number]> }): ReactElement` |
| `ICON_NEW` | const | `string` |
| `ICON_RESUME` | const | `string` |
| `ICON_BRANCH` | const | `string` |
| `ICON_BRANCH_NODES` | const | `Array<[number, number]>` |
| `ICON_OVERFLOW` | const | `string` |
| `ICON_CLOSE` | const | `string` |
| `ICON_CHEVRON` | const | `string` |
| `ICON_FOLDER_ADD` | const | `string` |
| `ICON_TRASH` | const | `string` |

Not memoized.

- `Icon` — one stroked `<path>` on a 16×16 viewBox rendered at 14×14, `strokeWidth="1.4"`, round caps and joins, `fill="none"`, `stroke="currentColor"`, `aria-hidden` and `focusable="false"`. Optional `nodes` render as `r="1.4"` circles at the given `[cx, cy]` pairs, keyed `"cx,cy"` — that is what makes graph-like glyphs possible without a second component. Sharing this primitive is what keeps every bar's icons on the same stroke weight and cap style.
- Glyph set, exact values:
  - `ICON_NEW` = `"M8 3.2v9.6M3.2 8h9.6"` — a plus.
  - `ICON_RESUME` = `"M8 2.3a5.7 5.7 0 1 0 0 11.4 5.7 5.7 0 1 0 0-11.4M8 4.9V8.2l2.5 1.5"` — a clock; two half-arcs make the ring, then the hands.
  - `ICON_BRANCH` = `"M5 5.3v5.4M10.9 6.3v.5c0 1.3-1 1.8-2.4 2-1.3.2-2.7.5-3.5 1.9"`, paired with `ICON_BRANCH_NODES` = `[[5, 3.7], [5, 12.3], [10.9, 4.8]]` — the only glyph that uses the `nodes` prop.
  - `ICON_OVERFLOW` = `"M8 3.4h.01M8 8h.01M8 12.6h.01"` — zero-length segments with round caps, i.e. three dots.
  - `ICON_CLOSE` = `"M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"` — an X.
  - `ICON_CHEVRON` = `"M4.8 6.4 8 9.6l3.2-3.2"` — a down chevron.
  - `ICON_FOLDER_ADD` = `"M2.6 12.6V4.2h3.2l1.4 1.8h6.2v6.6zM8 7.9v2.8M6.6 9.3h2.8"` — a closed folder outline with a plus centred in its body.
  - `ICON_TRASH` = `"M2.8 4.6h10.4M6.4 4.6V3.2h3.2v1.4M4.2 4.6l.6 8.2h6.4l.6-8.2"` — lid, handle, then the tapered can.

---

## 5. Tool Call Renderers

`webview/src/components/tools/` turns a `ToolCallState` into a card in the transcript. `ToolCard` owns the frame (status, title, summary, meta, timer, expand toggle, output notices, images); a per-tool `ToolRenderer` from `registry.ts` supplies the interior. `detail.ts` is the defensive accessor layer over the untyped `details` wire channel, and `parts.tsx` holds the presentational primitives every renderer composes from.

### `webview/src/components/tools/types.ts`

The renderer contract. Both interfaces are type-only; the module emits no runtime code.

| Export | Kind | Signature |
|---|---|---|
| `ToolBodyProps` | interface | `{ call: ToolCallState; expanded: boolean }` |
| `ToolRenderer` | interface | `{ title?(call): ReactNode; summary?(call): ReactNode; meta?(call): ReactNode; body(props: ToolBodyProps): ReactNode; hideName?: boolean; defaultExpanded?: boolean }` |

- `ToolBodyProps.expanded` — renderers cap their *own* output when collapsed (each body picks its own collapsed/expanded line limits); the frame never clips.
- `ToolRenderer.title` — replaces the tool name in the header. Falls back to `call.name`.
- `ToolRenderer.summary` — the one-line "what did this do", rendered in the header and therefore visible while collapsed. Returning `null` lets `call.intent` show instead.
- `ToolRenderer.meta` — extra right-aligned header content, placed before the elapsed-time readout (used for chips: exit codes, match counts, provider names, subagent tallies).
- `ToolRenderer.body` — the only required member. A plain function component taking `ToolBodyProps`.
- `ToolRenderer.hideName` — suppress the tool name entirely because the body carries its own header (only `bashRenderer` sets this).
- `ToolRenderer.defaultExpanded` — open on arrival even when the call succeeded. No renderer in-tree currently sets it; errors auto-expand regardless.

### `webview/src/components/tools/registry.ts`

Tool name → renderer lookup, mirroring omp's own `toolRenderers` registry.

| Export | Kind | Signature |
|---|---|---|
| `toolRenderers` | const | `Record<string, ToolRenderer>` |
| `rendererFor` | function | `rendererFor(name: string): ToolRenderer` |
| `genericRenderer` | const (re-export) | `ToolRenderer` — re-exported from `./generic` |

The complete mapping, exactly as declared:

| Tool name | Renderer | Module |
|---|---|---|
| `apply_patch` | `editRenderer` | `fs.tsx` |
| `ast_grep` | `grepRenderer` | `search.tsx` |
| `bash` | `bashRenderer` | `shell.tsx` |
| `browser` | `browserRenderer` | `web.tsx` |
| `edit` | `editRenderer` | `fs.tsx` |
| `glob` | `globRenderer` | `search.tsx` |
| `grep` | `grepRenderer` | `search.tsx` |
| `lsp` | `lspRenderer` | `web.tsx` |
| `read` | `readRenderer` | `fs.tsx` |
| `task` | `taskRenderer` | `agentic.tsx` |
| `todo` | `todoRenderer` | `agentic.tsx` |
| `web_search` | `webSearchRenderer` | `web.tsx` |
| `write` | `writeRenderer` | `fs.tsx` |
| *(anything else)* | `genericRenderer` | `generic.tsx` |

- Two aliases share a renderer: `apply_patch` is `edit` behind a different wire name (the renderer branches on `call.name` for its title), and `ast_grep` shares grep's result shape (same branch-on-name for the title).
- `rendererFor` never returns `undefined`; an unknown name falls through to `genericRenderer`.

### `webview/src/components/tools/ToolCard.tsx`

The shared frame around every tool call. Sole export is the card component; everything else in the module is internal.

| Export | Kind | Signature |
|---|---|---|
| `ToolCard` | component | `ToolCard({ call }: { call: ToolCallState }): ReactElement` |

Card anatomy, in DOM order:

- Root `div.tool-card.tool-card-{status}` with `data-tool={call.name}`. The status suffix is one of `pending` / `running` / `success` / `error` / `skipped`.
- `div.tool-head` — clicking anywhere toggles expansion, except when the click target is inside an `a` or `button` (`event.target.closest("a,button")` short-circuits), so path links and the caret don't double-fire.
  - **Status icon** (`StatusIcon`): `pending`/`running` → `span.spinner`; `error` → `✕`; `skipped` → `•`; anything else → `✓`.
  - **Title**: `span.tool-name` containing `renderer.title?.(call) ?? call.name`. Omitted entirely when `renderer.hideName === true`.
  - **Summary**: `span.tool-summary.truncate` with `renderer.summary?.(call)`. When the summary is `null` and `call.intent` is set, the intent renders instead in `span.tool-summary.truncate.faint`.
  - `span.spacer`, then `renderer.meta?.(call)`.
  - **Timer**: `span.tool-elapsed.faint.mono`, driven by the internal `useElapsed(call)` hook. It ticks on a 1000 ms `setInterval` only while the call is pending/running. Returns `""` when `startedAt` is undefined, or when a settled call took under 1000 ms — sub-second successes are suppressed as noise, but a running call always shows something.
  - **Caret**: `button.icon-btn.tool-toggle` with `aria-expanded` and an `aria-label` of `"Collapse tool output"` / `"Expand tool output"`, rendering `▾` / `▸`.
- `div.tool-body`
  - `RendererBoundary` wrapping `<Body call expanded />`, with `<GenericBody call expanded />` as the fallback.
  - `OutputNotes` with the pre-narrowed `truncation`, `diagnostics`, `limits`, `artifactId`.
  - `div.tool-images` with one `img.tool-image` per image block from `resultImages(liveResult(call))`, `src={dataUrl(image)}`, alt `Tool output N`.

#### Expansion state

```ts
const expansionByCall = new Map<string, boolean>();
```

Module-level, keyed by `call.toolCallId`. Expansion is a user decision, not conversation state, so it must survive the transcript virtualising a card out of the DOM and back. Initial state is `expansionByCall.get(id) ?? (renderer.defaultExpanded === true || call.status === "error")`. A separate effect opens the card when an error lands *after* mount, but only if `expansionByCall.get(id) === undefined` — i.e. the user has not already made a call on this card. `toggle()` writes the map and the local state together. The map is never pruned.

#### `RendererBoundary`

A `Component<BoundaryProps, { failed: boolean }>` class error boundary; `BoundaryProps` is `{ resetKey: string; fallback: ReactNode; children: ReactNode }`. `getDerivedStateFromError` flips `failed`; `componentDidCatch` logs `"omp: tool renderer failed, falling back to the generic card"` with the component stack; `componentDidUpdate` clears `failed` when `resetKey` changes, so a settled result can retry a renderer that threw on a partial one. `ToolCard` passes a `resetKey` of `` `${call.status}:${call.endedAt ?? 0}` ``. A malformed `details` therefore degrades to the generic card instead of blanking the transcript.

#### `safe` and header-field isolation

A React boundary only catches its *children*, but the header pieces and the notes tail are computed in `ToolCard`'s own render and touch the same untyped `details`. Every one of them is wrapped in an internal `safe<T>(compute: () => T, fallback: T): T` which catches, logs `"omp: tool card field failed"`, and returns the fallback — a field that throws on access must cost that field, not the card. Applied to `detailsOf`, `truncationOf`, `diagnosticsOf`, `limitNotices`, `artifactFor`, `resultImages`, and each of `title` / `summary` / `meta`. Shared empty constants `NO_IMAGES` / `NO_LIMITS` avoid per-render allocation.

#### Artifact discovery

`artifactFor(call, truncationArtifact)` prefers `truncation.artifactId`; otherwise it matches `/\[raw output: artifact:\/\/(\d+)\]/` against only the **last 1024 characters** of the result text, so a 50 KiB streaming bash tail is not re-scanned on every update.

### `webview/src/components/tools/detail.ts`

Defensive access to the untyped `details` channel plus omp's output-notice grammar. `details` is `any` on the wire and third-party/MCP tools can violate every contract, so nothing here casts a field into shape: a wrong-typed value narrows to `undefined` and the caller renders less rather than throwing.

| Export | Kind | Signature |
|---|---|---|
| `asRecord` | function | `asRecord(value: unknown): Record<string, unknown> \| undefined` |
| `str` | function | `str(value: unknown): string \| undefined` |
| `text` | function | `text(value: unknown): string \| undefined` |
| `num` | function | `num(value: unknown): number \| undefined` |
| `bool` | function | `bool(value: unknown): boolean \| undefined` |
| `list` | function | `list(value: unknown): readonly unknown[]` |
| `strings` | function | `strings(value: unknown): string[]` |
| `records` | function | `records(value: unknown): Record<string, unknown>[]` |
| `liveResult` | function | `liveResult(call: ToolCallState): AgentToolResult \| undefined` |
| `detailsOf` | function | `detailsOf(call: ToolCallState): Record<string, unknown> \| undefined` |
| `argsOf` | function | `argsOf(call: ToolCallState): Record<string, unknown>` |
| `resultText` | function | `resultText(result: AgentToolResult \| undefined): string` |
| `resultImages` | function | `resultImages(result: AgentToolResult \| undefined): ImageContent[]` |
| `dataUrl` | function | `dataUrl(image: { data: string; mimeType?: string }): string` |
| `Truncation` | interface | `{ totalLines?: number; outputLines?: number; totalBytes?: number; artifactId?: string }` |
| `metaOf` | function | `metaOf(details: Record<string, unknown> \| undefined): Record<string, unknown> \| undefined` |
| `truncationOf` | function | `truncationOf(details: Record<string, unknown> \| undefined): Truncation \| undefined` |
| `diagnosticsOf` | function | `diagnosticsOf(details: Record<string, unknown> \| undefined): { summary: string; messages: string[] } \| undefined` |
| `limitNotices` | function | `limitNotices(details: Record<string, unknown> \| undefined): string[]` |
| `StrippedOutput` | interface | `{ text: string; artifactId?: string }` |
| `stripOutputNotices` | function | `stripOutputNotices(raw: string): StrippedOutput` |
| `countLines` | function | `countLines(value: string): number` |
| `LineWindow` | interface | `{ text: string; omitted: number }` |
| `tailLines` | function | `tailLines(value: string, count: number): LineWindow` |
| `splitLines` | function | `splitLines(value: string, limit: number): { lines: string[]; omitted: number }` |
| `resolvePath` | function | `resolvePath(base: string \| undefined, relative: string): string` |

- `asRecord` — rejects `null` and arrays, so an array field never masquerades as an object.
- `str` vs `text` — `str` accepts any string including `""`; `text` treats the empty string as absent. Renderers use `text` for anything they would display and `str` where an empty value is meaningful (e.g. a diff body, `write` content).
- `num` — requires `Number.isFinite`, so `NaN`/`Infinity` narrow to `undefined`.
- `list` — non-arrays yield a shared `NO_ITEMS` constant, not a fresh `[]`.
- `strings` / `records` — filter-and-narrow variants of `list`; `records` drops non-object entries.
- `liveResult` — the freshest envelope: a settled `call.result` wins over the rolling `call.partialResult`.
- `argsOf` — returns a shared `NO_ARGS` singleton when `call.args` is undefined; callers must not mutate it.
- `resultText` — concatenates only `{ type: "text", text: string }` blocks, newline-joined. Non-text blocks are skipped.
- `resultImages` — filters `{ type: "image", data: string }` blocks; returns a shared `NO_IMAGES` constant when there are none.
- `dataUrl` — defaults `mimeType` to `image/png`.
- `truncationOf` / `diagnosticsOf` — `meta.truncation` and `meta.diagnostics` are canonical; `read`/`grep`/`glob` also keep a legacy top-level copy, so both look at `meta.X` first then `details.X`. `diagnosticsOf` returns `undefined` only when both summary and messages are empty, and defaults the summary to `"Diagnostics"`.
- `limitNotices` — reads `meta.limits` and emits one string per tripped limit, mapping `matchLimit` → `"matches"`, `resultLimit` → `"results"`, `headLimit` → `"head lines"`. Format is `"{reached} {label} limit reached"`, or `"… — retry with {suggestion}"` when `suggestion` is present. `limits.columnTruncated.maxColumn` adds `"Lines truncated to N columns"`.
- `stripOutputNotices` — drops omp's appended notices from the *tail* of a tool's text output and hands back any `artifact://` id they carried. The card re-renders their content as styled rows, so showing them verbatim would duplicate them. Two passes: a trailing `Diagnostics (…)` / `LSP Diagnostics (…)` header found within the **last 40 lines** truncates everything from there to the end; then trailing blank lines and lines matching any of the 14 internal `NOTICE_PATTERNS` are peeled off (showing-lines banners, `[Read artifact://…]`, `[raw output: artifact://N]`, limit-reached lines, column-truncation lines, `Command exited with code N`, timeout/kill lines, `Backgrounded as job …`, wall-time lines, `[Truncated…]`). The artifact id comes from `/\[raw output: artifact:\/\/(\d+)\]/` over the whole buffer, or `/artifact:\/\/([A-Za-z0-9_-]+)/` on a stripped line.
- `countLines` — charcode scan, no allocation; `""` → `0`.
- `tailLines` — last `count` lines found by repeated `lastIndexOf("\n")` rather than splitting the whole buffer, because a 50 KiB bash tail is re-sent on every streaming update and the collapsed view must stay O(window). `omitted` counts the dropped prefix.
- `splitLines` — splits to at most `limit` lines; anything past the limit is *reported* in `omitted`, not built into the array. Both helpers strip one trailing newline first.
- `resolvePath` — joins a display-relative tool path onto its search base for `openFile`. Returns `relative` untouched when the base is empty or when `relative` already matches `/^(?:[A-Za-z]:[\\/]|[\\/]|[a-z][a-z0-9+.-]*:\/\/)/` (drive-letter, POSIX-absolute, or URI scheme). Inserts `/` only when the base does not already end in a separator.

### `webview/src/components/tools/parts.tsx`

Presentational pieces every tool card is assembled from. All are React components.

| Export | Kind | Signature |
|---|---|---|
| `Section` | component | `Section({ label?: string; meta?: ReactNode; children: ReactNode })` |
| `CodeBlock` | component | `CodeBlock({ text: string; limit?: number })` — `limit` defaults to `400` |
| `NumberedCode` | component | `NumberedCode({ text: string; startLine?: number; lineNumbers?: Array<number \| null>; limit?: number; onLine?: (line: number) => void })` — `startLine` defaults to `1`, `limit` to `400` |
| `MoreRow` | component | `MoreRow({ count: number; label?: string })` — `label` defaults to `"more lines"` |
| `PathLink` | component | `PathLink({ path: string; line?: number; label?: ReactNode; className?: string })` |
| `ExternalLink` | component | `ExternalLink({ url: string; label?: ReactNode })` |
| `ArtifactLink` | component | `ArtifactLink({ artifactId: string })` |
| `Note` | component | `Note({ kind?: "info" \| "warn" \| "error"; children: ReactNode })` — `kind` defaults to `"info"` |
| `Stats` | component | `Stats({ items: Array<[string, ReactNode]> })` |
| `OutputNotes` | component | `OutputNotes({ truncation: Truncation \| undefined; diagnostics: { summary: string; messages: string[] } \| undefined; limits: string[]; artifactId: string \| undefined })` |
| `Empty` | component | `Empty({ children: ReactNode })` |

- `Section` — renders the `div.tool-section-head` bar only when `label` or `meta` is present.
- `CodeBlock` — plain monospace `<pre>`. Never HTML: every byte here is untrusted. Feeds `text` through `splitLines(text, limit)` and appends a `MoreRow` for the remainder. Returns `null` when there is nothing to show.
- `NumberedCode` — file content with the card's own gutter. The model-facing text carries hashline anchors and `NNN:` prefixes; this renders the clean text instead. Per row the number is `lineNumbers[index]` when provided, else `startLine + index`; a `null` entry renders `⋯` and disables the gutter button. The gutter button is also disabled when `onLine` is undefined. Empty lines render a single space to preserve row height.
- `MoreRow` — renders `null` for `count <= 0`; formats with `toLocaleString()`.
- `PathLink` — a `button.tool-link` that posts `{ type: "openFile", path }`, or `{ type: "openFile", path, line }` when `line` is given. `title` is `path` or `path:line`. `className` is appended to `tool-link`.
- `ExternalLink` — posts `{ type: "openExternal", url }`.
- `ArtifactLink` — posts `{ type: "openArtifact", url: "artifact://<artifactId>" }`, labelled "View full output".
- `Stats` — `label value` pairs for a card's stats tail; renders `null` when `items` is empty; keyed by label.
- `OutputNotes` — the truncation / artifact / diagnostics / limits tail every card shares. It takes **already-narrowed** values because it renders outside the renderer boundary and must never touch a raw `details` object itself. Renders `null` when there is nothing to say. A truncation note only shows when `totalLines` is defined, reading `"Showing X of Y lines (bytes)"` with the artifact link appended after a `·`; when there is no truncation but there *is* an artifact, the link stands alone in an info note. Each limit string becomes its own warn note (keyed by the string). Diagnostics render as a warn note with the summary and, if present, the messages in a `CodeBlock` capped at 20 lines.
- `Empty` — italic placeholder row (`div.tool-empty.faint`).

### `webview/src/components/tools/fs.tsx`

Filesystem tools: `read`, `write`, `edit` / `apply_patch`.

| Export | Kind | Signature |
|---|---|---|
| `readRenderer` | const | `ToolRenderer` |
| `writeRenderer` | const | `ToolRenderer` |
| `editRenderer` | const | `ToolRenderer` |

- `readRenderer` — title is the literal `"Read"`. Summary prefers `args.path`, then `details.resolvedPath`, then `details.url`; a `kind === "url"` payload (or a label matching a URI scheme) renders an `ExternalLink` to `finalUrl ?? url ?? label`, otherwise a `PathLink` to `resolvedPath ?? label` with the line set only when `displayContent.startLine > 1`.
  - Body reads an internal `ReadView` off `details`: `kind` (default `"file"`), `resolvedPath`, `url`, `finalUrl`, `contentType`, `method`, `notes[]`, `isDirectory`, `fileSize`, `totalLines`, `conflictCount`, `displayReadTargets[]`, `suffixResolution.{from,to}`, and `displayContent.{text,startLine,lineNumbers}` (non-numeric `lineNumbers` entries become `null`).
  - Rendering order: a `N targets` section of `PathLink`s when more than one target; a suffix-resolution info note (`from → to`); a warn note for `conflictCount > 0`; for URL reads a `method / ExternalLink / contentType` row; a joined `notes` info note; then the content; then a `lines` / `size` stats tail.
  - Content selection: `displayContent` → `NumberedCode`; a directory listing or URL read → plain `CodeBlock`; otherwise the stripped result text goes through the internal `withoutHashlineAnchors`, which drops a leading `[path#TAG]` anchor line and lifts `NNN:` prefixes into gutter numbers — but only when at least **80%** of the lines carry the prefix, otherwise the text is left alone. Line limit is 14 collapsed / 1000 expanded. Gutter clicks post `openFile` against `resolvedPath ?? args.path`. Pending/running shows `Reading…`.
- `writeRenderer` — title `"Write"`; summary is a `PathLink` to `details.resolvedPath ?? args.path`.
  - Body prefers `args.content` and renders it as `NumberedCode` (limit 10 collapsed / 600 expanded) with a `lines` / `size` stats tail, where size is the UTF-8 byte length via `new TextEncoder()`. `details.madeExecutable` adds a "Made executable (shebang detected)" note. When `content` has not arrived it falls back to `call.partialArgs` under a "Content (streaming)" section, then to the stripped result text.
- `editRenderer` — title branches on the wire name: `"Apply patch"` for `apply_patch`, `"Edit"` otherwise.
  - Entries: `details.perFileResults[]` when present (multi-file edits fan out), else the root `details` treated as a single entry. Each entry pulls `path`, `sourcePath`, `move`, `op`, `diff`, `oldText`, `newText`, `firstChangedLine`, `snapshotsPruned`, `isError`, and `displayErrorText ?? errorText`.
  - Summary: for multiple entries, `"N files"` plus an error chip counting `isError` entries. For a single entry, an optional `sourcePath →` prefix, a `PathLink` to `path ?? move` at `firstChangedLine`, and `+added` / `−removed` counts obtained by running the diff parser with limit `0` (counts only, no rows built).
  - Body: per entry an `EditHeader` (path links, an op chip when `op` is neither undefined nor `"update"`, and an "Open diff" button that posts `{ type: "openDiff", title: "<basename> (omp edit)", oldText, newText, path }` when both texts are present), an error note, then the diff. Paths are hidden in the header for a lone edit whose path already sits in the card summary, unless it is a rename. With no diff: `op === "delete"` shows a warn note plus the old content (6 / 200 lines); a rename shows "Renamed without content changes"; otherwise "No textual changes." `snapshotsPruned` adds "Snapshots pruned — full diff unavailable".
  - Diff parsing recognises `@@ -a,b +c,d @@` hunk headers (which reset the old/new line counters), `+++`/`---`/`diff `/`\` meta lines, `+` adds, `-` removes, and context. Rows are capped at 18 collapsed / 1200 expanded with the remainder reported as "more diff lines"; a single trailing empty context row from a trailing newline is dropped.
  - While streaming, or with no entries, the body shows `args.input ?? call.partialArgs` under a "Patch" section, else `Preparing edit…`, else the stripped result text.

### `webview/src/components/tools/shell.tsx`

`bash` — the command card: `$ command` above a rolling output tail.

| Export | Kind | Signature |
|---|---|---|
| `bashRenderer` | const | `ToolRenderer` |

- Sets `hideName: true` and supplies no `title`/`summary`: the body carries its own `$ command` header.
- `meta` chips, in precedence order: `timed out` (warn) → `exit N` (error, for any non-zero exit code) → `job <id>` (accent) → nothing.
- The internal `BashView` narrows `details`: `exitCode`, `timedOut`, `wallTimeMs`, `timeoutSeconds`, `requestedTimeoutSeconds`, `timeoutDisabled`, `terminalId`, plus `async.jobId` and `async.state`.
- Command recovery: `args.command` when parsed, otherwise a regex over `call.partialArgs` (`/"command"\s*:\s*"((?:[^"\\]|\\.)*)/`) re-parsed through `JSON.parse` to unescape, falling back to the raw capture. `args.env` is rendered as a `KEY="value" ` prefix on the command line. `args.cwd` renders as an `in <cwd>` line.
- Output: the result text is stripped of notices, windowed with `tailLines` (10 collapsed / 1200 expanded) because every streaming update re-sends the whole rolling tail, then run through `stripAnsi`. The section meta shows `…N earlier lines`. Empty output shows `Running…` while in flight, `No output.` once settled.
- Notes: a timeout warn note ("the command was killed, not failed") and a backgrounded-job info note with the job id and state.
- Stats tail: `exit` (only when non-zero), `wall`, `timeout` (`off` when disabled, else `Ns`, or `Ns (requested Ms)` when the granted timeout differs from the requested one), and `terminal`.

### `webview/src/components/tools/search.tsx`

`grep` / `ast_grep` / `glob` — match listings with clickable rows.

| Export | Kind | Signature |
|---|---|---|
| `grepRenderer` | const | `ToolRenderer` |
| `globRenderer` | const | `ToolRenderer` |

- Both share an internal `SearchView` over `details`: `matchCount`, `fileCount`, `files[]`, `fileMatches[{path,count}]`, `displayContent`, a link base of `cwd ?? searchPath ?? scopePath`, `missingPaths[]`, `truncated`, `error`, and legacy limit notes. The legacy notes (`fileLimitReached`, `perFileLimitReached`, `resultLimitReached`, `linesTruncated`) are only collected when `meta.limits` is absent — the card frame renders `meta.limits`, so exactly one of the two ever shows.
- `grepRenderer` — title `"AST grep"` for `ast_grep`, else `"Grep"`. Summary is `args.pattern` plus `in <scope>` from `args.path ?? details.scopePath`. Meta is a chip reading `"N matches · M files"` (singularised), accented unless `matchCount === 0`.
  - Body parses `details.displayContent` using omp's display grammar — `# dir`, `## file`, and `*NN│text` / ` NN│text` rows — into clickable rows. File paths are joined onto the current `# dir` unless already absolute or already prefixed, then resolved against the view base. A `*` marker flags a real match row (`tool-match-hit`); line rows post `openFile` with the line number. Unrecognised non-blank lines fall through as plain text rows. Limit is 12 collapsed / 800 expanded.
  - Without `displayContent` it falls back to a `fileMatches` list (path + count per row), then to `No matches.` when `matchCount === 0`, then to the raw stripped output in a `CodeBlock`. `error` and `missingPaths` render as notes above the listing.
- `globRenderer` — title `"Glob"`; summary is `args.path ?? details.scopePath`; meta is a chip reading `"N files"` from `fileCount`, falling back to `files.length`.
  - Body lists `details.files` as `PathLink` rows resolved against the view base (12 collapsed / 1000 expanded), with a "more files" row for the remainder, or `No files matched.` Pending/running shows `Globbing…`.

### `webview/src/components/tools/web.tsx`

`lsp`, `web_search`, `browser`.

| Export | Kind | Signature |
|---|---|---|
| `lspRenderer` | const | `ToolRenderer` |
| `webSearchRenderer` | const | `ToolRenderer` |
| `browserRenderer` | const | `ToolRenderer` |

- `lspRenderer` — title is `LSP <action>` from `details.action ?? args.action`, trimmed. Summary is `args.file` (as a `PathLink` at `args.line`) else `args.symbol` / `args.query` as plain text. Meta chips `details.serverName`. Body is just the stripped output in a `CodeBlock` (12 / 600), with `Querying language server…` while in flight and `No results.` when empty.
- `webSearchRenderer` — title `"Web search"`; summary is `args.query`; meta chips `details.response.provider` unless it is absent or the string `"none"`.
  - Body reads `details.response`: `answer` (rendered through `<Markdown compact />`), `searchQueries[]` (rendered as chips), and `sources[]` narrowed to `{ title (defaulting to the url), url, snippet?, author? }` — entries without a `url` are dropped. Sources are capped at 3 collapsed / 40 expanded under a `"N source(s)"` section, each showing an `ExternalLink` title, the raw url, the snippet, and the author. `details.error` renders as an error note. Without an answer the stripped result text is shown as a fallback `CodeBlock` (8 / 400). `No results.` only when answer, sources, error and fallback are all empty.
- `browserRenderer` — title is `Browser <action>` from `details.action ?? args.action`, trimmed. Summary is an `ExternalLink` to `details.url ?? args.url`. Meta chips `details.name` unless it is absent or `"main"` (the default page).
  - Body shows `args.code` under a "Code" section (10 / 400), `details.observation.title` as a faint row, `details.result` under a "Result" section (8 / 400) — or the stripped output when there is no `result` — and `details.screenshots[]`. Each screenshot uses inline `data` (via `dataUrl`, defaulting to `image/png`) when present, otherwise falls back to a `PathLink` to its `path`. Empty on all four → `Driving the browser…` while running, `No output.` otherwise.

### `webview/src/components/tools/agentic.tsx`

`task` — the subagent fan-out panel — and `todo` — the phase/task tree.

| Export | Kind | Signature |
|---|---|---|
| `taskRenderer` | const | `ToolRenderer` |
| `todoRenderer` | const | `ToolRenderer` |

- `taskRenderer` — title `"Task"`.
  - Rows come from `details.progress[]` when non-empty (live wins over settled), else `details.results[]`. A progress row carries `id`, `agent` (default `"agent"`), `name ?? description`, `status` (validated against `pending`/`running`/`completed`/`failed`/`aborted`, defaulting to `running`), `task ?? assignment`, `lastIntent`, `currentTool`, `toolCount`, `tokens`, `contextTokens`, `contextWindow`, `cost`, `durationMs`, `resolvedModel`, `error`, retry state from `retryState ?? retryFailure`, and nested rows from `inflightTaskDetails` — recursion is hard-capped at **depth 2**. A result row derives status instead: `aborted` → `aborted`, an `error` or non-zero `exitCode` → `failed`, else `completed`; its cost comes from `usage.cost.total` and its error falls back to `abortReason`.
  - `tokens` is a lifetime billing counter and is deliberately **not** comparable to `contextWindow`; the context gauge uses `contextTokens` / `contextWindow` only, clamped to 0–100% and coloured by the shared `contextLevel` helper.
  - Each row renders a status chip, the name and agent kind, the context gauge, a stats strip (`N tools`, formatted tokens, cost, duration), an activity line (`currentTool` + `lastIntent`, falling back to the assignment text), retry and error notes, and — once the row is past `pending` and has an `id` — `output` and `transcript` links posting `openArtifact` with `agent://<id>` and `history://<id>`. Nested rows indent by 14 px per level.
  - Summary: the first four row names joined, with `+N` for the rest; before any rows exist it falls back to `args.tasks.length` subagents, else `args.name ?? args.agent`. Meta: a `done/total` ok chip plus a `N failed` error chip counting `failed` and `aborted`.
  - Body caps at 8 collapsed / 64 expanded, prefixes a background-job note from `details.async.jobId`, and shows `Spawning subagents…` / the raw output when there are no rows.
- `todoRenderer` — title `"Todo"`.
  - Reads `details.phases[]`, each `{ name (default "Tasks"), tasks[] }`, each task `{ content, status, blocker? }` with status validated against `pending` / `in_progress` / `completed` / `abandoned` / `blocked` and defaulting to `pending`. Glyphs are `○ ▸ ✓ ✗ ⏸` respectively.
  - Summary: an optional `details.op` chip plus `done/total done` counted across all phases; `null` when there are no tasks.
  - Body budgets **8 tasks total** when collapsed (unlimited when expanded), spending the budget phase by phase and dropping whole phases once it is exhausted; the shortfall is reported as "more tasks". A rejected update (`liveResult(call).isError`) renders the stripped output — or `"Todo update rejected."` — as an error note above the tree. No phases at all → the raw output, or `No todos.`

### `webview/src/components/tools/generic.tsx`

The fallback card: any tool without a dedicated renderer, and any renderer that threw (`ToolCard` uses `GenericBody` as its boundary fallback).

| Export | Kind | Signature |
|---|---|---|
| `argumentSummary` | function | `argumentSummary(args: Record<string, unknown>, max?: number): string` — `max` defaults to `3` |
| `GenericBody` | component | `GenericBody({ call, expanded }: ToolBodyProps)` |
| `genericRenderer` | const | `ToolRenderer` |

- `argumentSummary` — a scalar-only preview such as `path="src/app.ts" limit=20`. Skips the `i` intent key and anything prefixed `__`, stops after `max` entries, clips strings at 60 characters with an ellipsis, renders arrays as `key[len]` and objects as `key{…}`, and drops `null`/`undefined`.
- `GenericBody` — expanded shows a pretty-printed "Arguments" `CodeBlock` (200 lines, `__`-prefixed keys removed, falling back to a comma-joined key list if the args are cyclic/unserialisable); collapsed shows a one-line `argumentSummary(args, 6)`. Streaming args (no `call.args` but a `call.partialArgs`) render raw under their own section. Output is the stripped result text, windowed with `tailLines(…, 4)` when collapsed and capped at 8 / 2000 lines. Everything empty → `No output.`
- `genericRenderer` — no `title` (so `ToolCard` shows the raw tool name), summary is `argumentSummary(argsOf(call))` at the default max of 3, body is `GenericBody`.

### `webview/src/components/tools/tools.css`

Every class in this file is namespaced `tool-*` and composes with `theme.css` atoms (`row`, `spacer`, `mono`, `faint`, `muted`, `truncate`, `chip`, `chip-ok`/`chip-err`/`chip-warn`/`chip-accent`, `btn`, `icon-btn`, `spinner`) rather than restating them; all colours come from CSS custom properties, so the cards follow the VS Code theme. Names are structural and mirror the component tree — `tool-card` / `tool-card-{status}` for the frame, `tool-head` / `tool-body` / `tool-section` for layout, and per-renderer families `tool-code-*`, `tool-diff-*`, `tool-edit-*`, `tool-cmd-*`, `tool-match-*`, `tool-list-*`, `tool-agent-*`, `tool-gauge-*`, `tool-todo-*`, `tool-source-*`, `tool-note-{info|warn|error}`, `tool-image(s)`. Status and state are encoded as a suffix on the base class (`tool-card-error`, `tool-diff-add`, `tool-todo-completed`) so renderers only ever concatenate a known token.

#### Adding a tool renderer

1. Pick or create the module in this directory that matches the tool's family (`fs`, `shell`, `search`, `web`, `agentic`) — a genuinely new family gets a new file with a one-line header comment naming the tools it covers.
2. Write a body component typed `({ call, expanded }: ToolBodyProps)`. Read the payload **only** through `detail.ts` helpers (`detailsOf`, `argsOf`, `liveResult`, `resultText`, `asRecord`/`text`/`num`/`bool`/`records`/`strings`) — never index `details` directly, and never cast. Narrow the whole payload into a local view interface in one function, the way `readView` / `bashView` / `searchView` / `agentRows` do.
3. Handle the in-flight states explicitly: `call.status === "pending" || call.status === "running"` should render an `<Empty>…</Empty>` placeholder, and if the tool streams arguments, recover them from `call.partialArgs`.
4. Choose collapsed and expanded line limits from `expanded` and pass them to `CodeBlock` / `NumberedCode` / `MoreRow`. Use `tailLines` for rolling output that is re-sent wholesale on each update, `splitLines` for a fixed buffer.
5. Build the interior from `parts.tsx` only — `Section`, `CodeBlock`, `NumberedCode`, `PathLink`, `ExternalLink`, `Note`, `Stats`, `MoreRow`, `Empty`. Never emit HTML from tool output; run `stripOutputNotices` over result text so the frame's `OutputNotes` does not duplicate it.
6. Export a `const fooRenderer: ToolRenderer = { title?, summary?, meta?, body }`. Add `hideName: true` only if the body renders its own header, and `defaultExpanded: true` only if the card is useless collapsed. Keep `summary` to a single truncating row and `meta` to chips.
7. Register it in `registry.ts`: add the wire name to `toolRenderers` (the object is alphabetical) and add an alias entry if the tool ships under a second name. No other wiring is needed — `rendererFor` and `ToolCard` pick it up automatically.
8. Add any new classes to `tools.css` under the `tool-` namespace, composing with the existing theme atoms.

---

## 6. Build, Configuration, and Dev Tooling

Everything outside `src/` and `webview/` that defines *how the extension is built, declared to VS Code, and exercised outside the extension host*: the manifest, the two independent bundlers (esbuild for the Node extension, Vite for the React webview), the three-project TypeScript layout, packaging exclusions, and the `scripts/` harness used to drive real `omp` processes without VS Code.

### `package.json`

Extension manifest plus npm script surface. `main` is `./dist/extension.js` (the esbuild output); the webview bundle is loaded from `dist/webview` at runtime, not referenced here.

#### Identity and engines

| Field | Value |
|---|---|
| `name` / `displayName` | `omp-ui` / `OMP` |
| `version` | `0.1.0` |
| `publisher` | `omp` |
| `license` | `MIT` |
| `private` | `true` |
| `main` | `./dist/extension.js` |
| `engines.vscode` | `^1.104.0` |
| `engines.node` | `>=20` |
| `categories` | `["AI", "Chat", "Programming Languages"]` |
| `keywords` | `["omp", "oh my pi", "coding agent", "ai"]` |
| `activationEvents` | `[]` — **empty**. Activation is driven entirely by `contributes.views`: registering the `omp.chatView` webview view in the `omp` view container is an implicit activation event, so the extension wakes when the user opens the OMP activity-bar container (or invokes a contributed command). There is no `onStartupFinished`, so a user who never opens the view never pays activation cost. |

#### npm scripts

| Script | Exact command | What it does |
|---|---|---|
| `build` | `npm run build:extension && npm run build:webview` | Full production build: extension bundle, then webview bundle. Sequential — the two outputs are independent, but `&&` gates the webview build on extension success. |
| `build:extension` | `node esbuild.mjs --production` | Runs the esbuild driver in production mode (minified, no sourcemap) → `dist/extension.js`. |
| `build:webview` | `vite build` | Vite production build of `webview/` → `dist/webview/`. |
| `watch` | `concurrently -k -n ext,web -c blue,magenta "node esbuild.mjs --watch" "vite build --watch"` | Runs both bundlers in watch mode side by side. `-k` kills all children when one dies; `-n ext,web` labels the two streams; `-c blue,magenta` colors them. The extension side takes `--watch` (handled by `esbuild.mjs`); the webview side uses Vite's own `--watch`. |
| `typecheck` | `tsc -p tsconfig.extension.json --noEmit && tsc -p tsconfig.webview.json --noEmit` | Type-checks both projects. Neither bundler type-checks (esbuild and Vite both strip types), so this is the *only* type gate. `--noEmit` is redundant with `tsconfig.base.json` but passed explicitly. |
| `smoke` | `esbuild scripts/smoke-rpc.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/smoke-rpc.cjs && node dist/smoke-rpc.cjs` | Bundles and runs the RPC smoke test against a real `omp`. Accepts a prompt via `npm run smoke -- "say hello"`. |
| `smoke:sessions` | `esbuild scripts/smoke-sessions.ts --bundle --platform=node --target=node20 --format=cjs --alias:vscode=./scripts/harness/vscode-stub.ts --outfile=dist/smoke-sessions.cjs && node dist/smoke-sessions.cjs` | Same, for the multi-session smoke test. The `--alias:vscode=./scripts/harness/vscode-stub.ts` flag is what lets production `src/` code that imports `vscode` link outside the extension host. |
| `package` | `npm run build && vsce package --no-dependencies` | Produces a `.vsix`. `--no-dependencies` is safe because `dependencies` is empty — everything is bundled. |
| `vscode:prepublish` | `npm run build` | VS Code's standard pre-package hook; makes `vsce package` rebuild even if invoked directly. |

- **There is no `record` script.** `scripts/record-session.ts` documents its own invocation as `npm run record -- "your prompt"`, but no such entry exists in `scripts`. It must be run by bundling it manually, mirroring the `smoke:sessions` command line (it needs the same `--alias:vscode=./scripts/harness/vscode-stub.ts`). Likewise `scripts/serve-harness.mjs` has no npm script; it is run directly as `node scripts/serve-harness.mjs [port]`.

#### `contributes.viewsContainers`

One activity-bar container:

| id | title | icon |
|---|---|---|
| `omp` | `OMP` | `media/omp.svg` |

#### `contributes.views`

One webview view inside the `omp` container:

| id | name | type | icon | contextualTitle |
|---|---|---|---|---|
| `omp.chatView` | `Chat` | `webview` | `media/omp.svg` | `OMP` |

#### `contributes.commands`

Every command uses category `OMP`, so they surface in the palette as `OMP: <title>`.

| Command id | Title | Icon |
|---|---|---|
| `omp.openChat` | Open Chat in Editor | `$(comment-discussion)` |
| `omp.focusChat` | Focus Chat | — |
| `omp.newSession` | New Session | `$(add)` |
| `omp.resumeSession` | Resume Session... | `$(history)` |
| `omp.abort` | Abort Current Turn | `$(debug-stop)` |
| `omp.selectModel` | Select Model... | — |
| `omp.loginProvider` | Sign in to Provider... | — |
| `omp.compact` | Compact Conversation | — |
| `omp.exportHtml` | Export Session to HTML | — |
| `omp.restartAgent` | Restart Agent Process | `$(debug-restart)` |
| `omp.showLog` | Show Log | `$(output)` |
| `omp.addSelectionToChat` | Add Selection to Chat | — |
| `omp.addProjectFolder` | Add Project Folder... | `$(new-folder)` |
| `omp.removeProjectFolder` | Remove Project Folder... | `$(trash)` |
| `omp.resetSession` | Reset Conversation | — |
| `omp.closeSession` | Close Session | — |

- `omp.abort`, `omp.selectModel`, `omp.loginProvider`, and `omp.removeProjectFolder` are declared but appear in **no** menu contribution — they reach the user only through the command palette (and, for abort, the webview's own UI; for folder removal, the switcher's per-project button).

#### `contributes.menus`

`view/title` — all entries gated on `when: "view == omp.chatView"`. Three groups control placement: `navigation@N` renders as inline title-bar icons; `1_agent@N` and `9_debug@N` fall into the `...` overflow menu, with `9_` sorting last.

| Group | Order | Command |
|---|---|---|
| `navigation` | `@1` | `omp.newSession` |
| `navigation` | `@2` | `omp.resumeSession` |
| `navigation` | `@3` | `omp.openChat` |
| `navigation` | `@4` | `omp.addProjectFolder` |
| `1_agent` | `@1` | `omp.restartAgent` |
| `1_agent` | `@2` | `omp.compact` |
| `1_agent` | `@3` | `omp.exportHtml` |
| `1_agent` | `@4` | `omp.resetSession` |
| `1_agent` | `@5` | `omp.closeSession` |
| `9_debug` | `@1` | `omp.showLog` |

`editor/context` — `omp.addSelectionToChat`, group `omp@1`, `when: "editorHasSelection"`.

`commandPalette` — `omp.focusChat` with `when: "false"`, i.e. explicitly **hidden** from the palette. It exists purely as a keybinding target and an internal `executeCommand` hook.

#### `contributes.keybindings`

| Command | Key | Mac | When |
|---|---|---|---|
| `omp.focusChat` | `ctrl+shift+alt+o` | `cmd+shift+alt+o` | — |
| `omp.addSelectionToChat` | `ctrl+shift+alt+l` | `cmd+shift+alt+l` | `editorHasSelection` |

#### `contributes.configuration`

Title `OMP`. Every property, with its real default:

| Key | Type | Default | Description |
|---|---|---|---|
| `omp.executablePath` | `string` | `"omp"` | *(markdownDescription)* Path to the `omp` executable. Resolved on `PATH` when not absolute. |
| `omp.extraArgs` | `array` of `string` | `[]` | *(markdownDescription)* Extra CLI arguments appended to `omp --mode rpc-ui` (for example `["--advisor"]`). |
| `omp.model` | `string` | `""` | *(markdownDescription)* Model pattern passed as `--model` on startup. Empty uses omp's own default. |
| `omp.thinkingLevel` | `string` enum | `""` | Thinking level passed as `--thinking` on startup. Empty uses omp's own default. Enum: `""`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`. |
| `omp.approvalMode` | `string` enum | `""` | *(markdownDescription)* Tool approval mode, passed as `--approval-mode` on startup. omp itself defaults to `yolo`, so approval prompts only appear if you pick `write` or `always-ask` here (or set `tools.approvalMode` in your omp config). Enum: `""`, `always-ask`, `write`, `yolo`. |
| `omp.subagentSubscription` | `string` enum | `"progress"` | How much subagent detail to stream into the UI. Enum: `off`, `progress`, `events`. |
| `omp.showThinking` | `boolean` | `true` | Render the model's thinking blocks. |
| `omp.autoScroll` | `boolean` | `true` | Follow the bottom of the transcript while the agent streams. |
| `omp.sendKeybinding` | `string` enum | `"enter"` | *(markdownDescription)* Which key sends a message. With `enter`, use `Shift+Enter` for a newline. Enum: `enter`, `ctrl+enter`. |
| `omp.followActiveEditor` | `boolean` | `false` | *(markdownDescription)* Automatically switch the OMP chat to the project folder containing the active editor. |

- `omp.approvalMode` carries `enumDescriptions` aligned to its enum, in order: *"Use omp's own configured default, which is 'yolo' unless you set tools.approvalMode in your omp config."* (`""`), *"Ask before every write and command."* (`always-ask`), *"Ask before commands only."* (`write`), *"Auto-approve everything."* (`yolo`).
- The `""` sentinel is the recurring pattern for `model`, `thinkingLevel`, and `approvalMode`: empty means *don't pass the flag at all*, deferring to omp's own config rather than baking a VS Code-side default that would silently override it.

#### Dependencies

`dependencies` is **empty** — nothing ships unbundled. All runtime libraries are `devDependencies` because both bundlers inline them.

| Package | Range | Role |
|---|---|---|
| `@types/node` | `^22.13.0` | Extension-side types. |
| `@types/react`, `@types/react-dom` | `^19.2.0` | Webview types. |
| `@types/vscode` | `^1.104.0` | Matches `engines.vscode`. |
| `@vitejs/plugin-react` | `^5.1.0` | Vite React plugin. |
| `@vscode/vsce` | `^3.9.0` | `.vsix` packaging. |
| `concurrently` | `^9.2.0` | Drives the dual `watch`. |
| `esbuild` | `^0.28.0` | Extension bundler + smoke-script bundler. |
| `highlight.js` | `^11.11.1` | Code highlighting (via `rehype-highlight`). |
| `katex` | `^0.16.25` | Math rendering (via `rehype-katex`). |
| `mermaid` | `^11.16.0` | Diagram rendering. Largest single dependency — the reason `chunkSizeWarningLimit` is raised to 3000 in the Vite config. |
| `react`, `react-dom` | `^19.2.0` | Webview runtime. |
| `react-markdown` | `^10.1.0` | Markdown renderer. |
| `rehype-highlight` | `^7.0.2` | Syntax highlighting plugin. |
| `rehype-katex` | `^7.0.1` | Math rendering plugin. |
| `remark-gfm` | `^4.0.1` | GitHub-flavored markdown. |
| `remark-math` | `^6.0.0` | Math syntax parsing. |
| `typescript` | `^5.9.0` | Typecheck only. |
| `vite` | `^8.2.0` | Webview bundler. |

### `esbuild.mjs`

Bundles the extension host code. A plain ESM script, no exports — invoked as `node esbuild.mjs [--production] [--watch]`.

Flags are read straight off `process.argv`:

```js
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
```

Build options, verbatim:

```js
const options = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "dist/extension.js",
	platform: "node",
	target: "node20",
	format: "cjs",
	external: ["vscode"],
	sourcemap: !production,
	minify: production,
	logLevel: "info",
};
```

- `format: "cjs"` is mandatory — VS Code loads extension `main` via CommonJS `require`.
- `external: ["vscode"]` is the only external; the `vscode` module is injected by the extension host at runtime and must never be bundled.
- `sourcemap` and `minify` are strict inverses of `--production`: dev builds get maps and readable output, production gets minified with no map. `.vscodeignore` also strips `**/*.map` from the package.
- `--watch` takes the `context()` path and calls `ctx.watch()`; the script then stays alive with no explicit dispose. Without `--watch` it is a one-shot `build()`. Top-level `await` is used in both branches, which is why this file is `.mjs`.

### `vite.config.ts`

Bundles the React webview. Source comment states the rationale: *"The webview is loaded from disk through `Webview.asWebviewUri`, never from a dev server, so emit plain relative assets with predictable names."*

```ts
export default defineConfig({
	plugins: [react()],
	root: "webview",
	base: "./",
	build: {
		outDir: "../dist/webview",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: false,
		chunkSizeWarningLimit: 3000,
		rollupOptions: {
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
});
```

- `root: "webview"` means `outDir` is resolved *relative to `webview/`*, hence the `../` in `../dist/webview`.
- `base: "./"` emits relative asset URLs so the HTML can be rewritten through `asWebviewUri` without absolute-path breakage.
- `entryFileNames` and `assetFileNames` are deliberately **hash-free** (`[name].js`, `[name][extname]`), which is what lets `scripts/serve-harness.mjs` regex the built `index.html` for `assets/index.js` and `assets/index.css`, and what lets the extension's URI rewriting target stable filenames. Only *chunks* carry `[hash]`.
- `emptyOutDir: true` is required because `outDir` sits outside `root`; Vite otherwise refuses to clean it.
- `sourcemap: false` unconditionally — even in the `vite build --watch` dev loop.
- `chunkSizeWarningLimit: 3000` (kB) suppresses the size warning that `mermaid` would otherwise trip.
- `target: "es2022"` here vs `ES2023` in `tsconfig.base.json`: the type checker allows newer syntax than the emitted bundle, so Vite downlevels what tsc accepts.

### `tsconfig.json`

Solution-style root. Emits nothing itself; exists so an editor opening the repo root resolves both projects.

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.extension.json" }, { "path": "./tsconfig.webview.json" }]
}
```

### `tsconfig.base.json`

Shared compiler options for both projects. No `include`/`files` of its own.

| Option | Value | Note |
|---|---|---|
| `target` | `ES2023` | |
| `module` / `moduleResolution` | `ESNext` / `bundler` | Both projects are bundler-fed; esbuild downlevels the extension to CJS. |
| `strict` | `true` | |
| `noUncheckedIndexedAccess` | `true` | Why `arr[i]` is `T \| undefined` throughout the codebase. |
| `noImplicitOverride` | `true` | |
| `noFallthroughCasesInSwitch` | `true` | |
| `exactOptionalPropertyTypes` | `false` | Explicitly disabled. |
| `verbatimModuleSyntax` | `true` | Forces `import type` for type-only imports. |
| `isolatedModules` | `true` | Required for single-file transpilation by esbuild/Vite. |
| `skipLibCheck` | `true` | |
| `esModuleInterop` | `true` | |
| `resolveJsonModule` | `true` | |
| `forceConsistentCasingInFileNames` | `true` | |
| `sourceMap` | `true` | Inert alongside `noEmit`. |
| `noEmit` | `true` | tsc is a checker only; both bundlers own emit. |

### `tsconfig.extension.json`

Extension-host project.

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024"],
    "types": ["node", "vscode"]
  },
  "include": ["src/**/*.ts"]
}
```

- No `DOM` lib — the extension host has no DOM, so accidental browser-API use is a compile error.
- Covers all of `src/`, **including `src/shared/`**, which is therefore checked twice (once here under Node types, once in the webview project under DOM types). That double-check is what enforces the shared layer's environment neutrality.
- `.ts` only — no `.tsx` glob, so no JSX can live under `src/`.

### `tsconfig.webview.json`

Webview project.

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["webview/**/*.ts", "webview/**/*.tsx", "src/shared/**/*.ts"]
}
```

- `types: ["vite/client"]` deliberately omits `node` and `vscode`, so the webview cannot reach for extension-host APIs.
- `jsx: "react-jsx"` — no `import React` needed in `.tsx`.
- Reaches *across* into `src/shared/**/*.ts` rather than duplicating those files, which is how the protocol/model types stay single-sourced between the two processes. Note it pulls in `src/shared/` only — no other `src/` subtree is visible to webview code.

### `.vscodeignore`

Controls `.vsix` contents. Excludes all sources and configs — effectively only `dist/` (minus dev artifacts), `media/`, `package.json`, and license/readme ship.

Excluded: `.gitignore`, `.vscode/**`, `.vscode-test/**`, `src/**`, `webview/**`, `scripts/**`, `node_modules/**`, `esbuild.mjs`, `vite.config.ts`, `tsconfig*.json`, `**/*.map`, `**/*.ts`, `*.vsix`.

Then, dev-only build outputs inside `dist/`: `dist/webview/harness.html`, `dist/*.cjs`, `dist/recorded-session.json`.

#### Key internal detail

The file carries a load-bearing comment about vsce's negation semantics:

> Dev-only build outputs. `dist/` is otherwise shipped wholesale, and a `!dist/**` negation would silently re-include these: vsce applies negations after every ignore pattern, so a negation always wins regardless of line order.

I.e. the three trailing entries must remain *plain ignores* — converting the block to an allowlist with `!dist/**` would ship the harness HTML, the bundled smoke `.cjs` files, and any recorded session.

### `.vscode/tasks.json`

Two npm tasks, `version: "2.0.0"`.

| Label | Type | Script | Background | Problem matcher |
|---|---|---|---|---|
| `npm: build` | `npm` | `build` | no | `["$tsc"]` |
| `npm: watch` | `npm` | `watch` | `true` | `["$esbuild-watch"]` |

- `npm: build` is referenced by `launch.json` as `preLaunchTask`.
- `$tsc` on the `build` task is nominal — `build` runs the bundlers, not `tsc`, so it emits no tsc-format diagnostics. Real type errors surface only via `npm run typecheck`.
- `$esbuild-watch` is contributed by the esbuild Problem Matchers extension, not by VS Code core — without it the background task never reports "ready".

### `.vscode/launch.json`

One configuration, `version: "0.2.0"`.

| Field | Value |
|---|---|
| `name` | `Run OMP Extension` |
| `type` | `extensionHost` |
| `request` | `launch` |
| `args` | `["--extensionDevelopmentPath=${workspaceFolder}"]` |
| `outFiles` | `["${workspaceFolder}/dist/**/*.js"]` |
| `preLaunchTask` | `npm: build` |

- `preLaunchTask` is the **production** `build`, not `watch` — F5 always runs a minified, sourcemap-less bundle. For breakpoint debugging you want `npm: watch` running separately (which produces `sourcemap: true` output matching `outFiles`).

### `scripts/smoke-rpc.ts`

End-to-end smoke test for the RPC bridge, outside VS Code. Spawns a real `omp --mode rpc-ui`, drives one prompt through the same `OmpRpcClient` and `applyEvent` reducer the extension uses, and prints the transcript that would render.

**Run:** `npm run smoke -- "say hello"`. Prompt is `process.argv.slice(2).join(" ")`, defaulting to `"Reply with exactly: bridge ok"`.

**Environment:** requires a real `omp` on `PATH`, or `OMP_PATH` pointing at one. It does *not* import `vscode`, so it needs no stub alias — hence the simpler bundle command versus `smoke:sessions`.

Client construction:

```ts
new OmpRpcClient(
	{ executable: process.env.OMP_PATH ?? "omp", extraArgs: ["--no-session"], cwd: process.cwd(), log: … },
	{ onSessionEvent, onSubagentFrame, onUiRequest, onCommands, onSessionInfo, onConfigUpdate, onCommandOutput, onExtensionError, onStderr, onExit },
)
```

Steps:
1. `await client.start()`, then log ready latency and `client.protocolVersion`.
2. `request("get_state")` → prints `model.provider/model.id` and `sessionId`.
3. `request("get_available_models")` → prints model count.
4. Arms a `Promise.withResolvers<void>()` plus a **120 s** timeout (`"no terminal agent_end within 120s"`).
5. `request("prompt", { message: prompt })` → prints `ack.agentInvoked`. **If `agentInvoked === false` it clears the timeout and does not wait** — a prompt that never invoked the agent will never produce `agent_end`.
6. Otherwise awaits terminal `agent_end` (`event.isTerminal !== false`).
7. Prints `--- rendered transcript ---`: per assistant item, each `text` block in full, each `thinking` block truncated to 80 chars with `…`, each `toolCall` by name, followed by a footer line `[model · N tokens · $cost]` with cost to 4 decimals. User items print as `user: <text>`. Any other item kind prints `kind: <JSON sliced to 120 chars>`. Then one `tool <name> -> <status>` line per entry in `chat.toolCalls`.
8. `await client.dispose()`.

Also logged live as callbacks fire: `[tool] <toolName>` on `tool_execution_start`, `[subagent] <type>`, `[ui] <method>`, `[commands] N available`, `[session] <sessionId> <title>`, `[output] <text>`, `[extension] <extensionPath>: <error>`, raw stderr passthrough, and `[exit] code=… signal=…`.

- **UI requests are auto-answered** so an approval gate cannot hang the run: `select` responds with `request.options[0] ?? ""`, `confirm` responds `confirmed: true`, `input` and `editor` respond `cancelled: true`.
- `extraArgs: ["--no-session"]` — this script deliberately writes no session file.
- On failure: prints `smoke failed: <message>`, disposes the client, sets `process.exitCode = 1` (does not hard-exit, so the client teardown can finish).

### `scripts/smoke-sessions.ts`

End-to-end smoke test for the multiplexing layer. Drives the production `SessionManager` with `vscode` stubbed: two live sessions in the *same* project plus one in a second project, each a real `omp --mode rpc-ui` process, all prompted concurrently. Asserts sessions stay independent, background badges reach every surface, and focus/close behave.

**Run:** `npm run smoke:sessions`. Takes no arguments.

**Environment:** requires a real `omp` (via `OMP_PATH` or `PATH`, read by the stub's `CONFIG`). Must be bundled with `--alias:vscode=./scripts/harness/vscode-stub.ts`. It sets `harness.CONFIG.extraArgs = []` at module scope, **overriding the stub's `["--no-session"]` default**, because the test asserts on real `sessionFile` values — this run *does* write to the session store.

Notable symbols:

| Symbol | Kind | Signature |
|---|---|---|
| `check` | function | `check(label: string, ok: boolean, detail?: string): void` |
| `Recorder` | class | `new Recorder(name: string, surface: ChatSurface)` |

- `check` — prints `ok  <label>` or `FAIL <label>` (plus ` — <detail>` when given) and pushes failing labels onto a module-level `failures: string[]`.
- `Recorder` — a bound webview stand-in that subscribes to a `ChatSurface` and records every `HostMessage`.
  - `readonly name: string`, `readonly surface: ChatSurface`, `readonly messages: HostMessage[]`
  - `ready(): Promise<void>` — sends `{ type: "ready" }`.
  - `submit(text: string): Promise<void>` — sends `{ type: "submit", text, images: [] }`.
  - `text(): string` — concatenates every `text_delta` delta from `message_update` events across all recorded `events` frames.
  - `last<T extends HostMessage["type"]>(type: T): Extract<HostMessage, { type: T }> | undefined` — most recent message of a type, searching backwards.
  - `settled(timeoutMs: number): Promise<void>` — polls `messages` every **50 ms** for a terminal `agent_end` (`isTerminal !== false`); rejects with `` `${name}: no agent_end within ${timeoutMs}ms` ``.

Scenario, in order:
1. Constructs `SessionManager` with the stub log channel and a fake `diffs` store (`{ store: () => ({ toString: () => "" }) }`). Installs a fake `manager.panels = { open, close }` recording ids into `opened[]` / `closed[]`.
2. Registers project A = `process.cwd()` (label `omp-ui`) and project B = a fresh `mkdtempSync(path.join(tmpdir(), "omp-smoke-"))` (label `scratch`).
3. Creates `a1`, `a2` in A and `b1` in B. Binds a `sidebar` recorder to `manager.sidebar()` and pinned panel recorders to `manager.surface(a2)` and `manager.surface(b1)`; sends `ready` to each.
4. Starts all three controllers concurrently via `Promise.all`.
5. Submits `"Reply with exactly: ALPHA" / "BETA" / "GAMMA"` concurrently, then awaits all three `settled(180_000)` — **180 s** per session.
6. Exercises focus switching (`selectSession`), the resume list (`requestSessions`), webview-originated `newSession` / `selectSession` / `closeSession` / `resetSession`, manager-level `closeSession`, and `removeProject` (refusal, then a real removal followed by re-adding the folder).
7. `manager.dispose()`, then sleeps **800 ms** because "Controller teardown is async and detached from `dispose()`".

Assertions (`check` labels), which double as the specification of the multiplexing contract:

- two sessions in one project get distinct ids
- roster lists both projects and all three sessions (`projects.length === 2 && sessions.length === 3`)
- sidebar follows the first session (`activeSessionId === a1`)
- pinned panel reports its own session as active
- all three agents reached ready (`agentStatus === "ready"`)
- each session runs in its project's cwd
- same-project sessions own separate session files
- a background session's streaming badge reaches the sidebar (both an `isStreaming: true` and an `isStreaming: false` `sessionStatus` for `a2`)
- session A1 / A2 / B1 transcript holds only its own answer (cross-contamination check: A1 has `ALPHA` and not `BETA`, A2 has `BETA` and not `ALPHA`, B1 has `GAMMA`)
- selecting a session opens its panel
- sidebar re-hydrates with the newly active session (a `workspace` message with the new `activeSessionId` *and* a `snapshot` whose `session.sessionFile` matches)
- pinned panel is unaffected by the sidebar's focus
- resume list comes from the project's session store
- a pinned panel's `newSession` lands in that panel's project (and `ordinal === 2`)
- the spawned session is focused and revealed
- `selectSession` from the sidebar re-focuses a session
- `resetSession` reuses the agent but starts a new session file (stays `ready`, new non-empty `sessionFile` differing from the pre-reset one)
- `closeSession` from the sidebar drops the session
- closing a session closes its panel
- closed session leaves the roster
- **the last session cannot be closed** (`sessions().length === 1` after attempting)
- refusing to close the last session warns the user (a `notify` message with `level === "warning"`)
- new session lands in the requested project
- **ordinals keep climbing instead of being reused** — a recycled slot cannot inherit a stale label
- **the project holding every session cannot be removed** (roster and session count unchanged)
- refusing to remove the last project warns the user (a `notify` message with `level === "warning"`)
- removing a project drops it from the roster
- removing a project closes every session it owned
- removing a project closes its panels (`closed[]` contains the removed sessions)
- focus moves off a removed project's session (active id becomes the surviving session)
- **a re-added folder mints ordinals from scratch** — nothing of a removed project survives

Exit: prints `all session checks passed` or `<n> check(s) failed`, then `process.exit(failures.length === 0 ? 0 : 1)`. A thrown error prints `smoke failed: <stack>` and exits 1.

### `scripts/record-session.ts`

Records a real omp session as the exact `HostMessage` stream the webview sees, so the webview can be replayed against real agent traffic instead of hand-written fixtures.

**Run:** documented in its own header as `npm run record -- "your prompt"` — **but that npm script does not exist**; bundle it the way `smoke:sessions` does (it needs the same `--alias:vscode=./scripts/harness/vscode-stub.ts`). Prompt is `process.argv.slice(2).join(" ")`, defaulting to `"Summarize this repository in three bullets."`.

**Environment:** real `omp` (via the stub's `OMP_PATH ?? "omp"`). Output path from `process.env.RECORD_OUT`, default `dist/recorded-session.json` (which `.vscodeignore` excludes from the `.vsix`).

Internal type:

```ts
interface Frame {
	atMs: number;
	message: HostMessage;
}
```

Steps:
1. Constructs the production `ChatController` with the stub log channel, a stub `diffs` store, and a synthetic `workspaceFolder` of `{ uri: { fsPath: process.cwd() }, name: "omp-ui", index: 0 }`.
2. `controller.subscribe(...)` pushes every message as a `Frame` stamped with `Date.now() - started`, resolving a `Promise.withResolvers` on terminal `agent_end`.
3. `handleWebviewMessage({ type: "ready" })`, then `controller.start()`.
4. Prints `prompting…`, submits `{ type: "submit", text: prompt, images: [] }`.
5. Waits for terminal `agent_end` with a **240 s** timeout (`"no terminal agent_end within 240s"`).
6. Sleeps **1500 ms** to "let trailing state refreshes land", then appends a final synthetic frame `{ type: "snapshot", snapshot: controller.snapshot(), draft: controller.draft }`.
7. Prints `captured <n> frames`, then `items=… toolCalls=…`, then `model=<provider>/<id> commands=… models=…`.
8. `mkdirSync` on the directory portion of `outputPath` (derived by `slice(0, lastIndexOf("/"))` — so `RECORD_OUT` **must use forward slashes and contain at least one**), writes tab-indented JSON, prints `wrote <path>`.
9. `controller.dispose()`, then sleeps **800 ms** for detached async client teardown.

Exit: `process.exit(0)` on success; on failure prints `record failed: <message>` and exits 1.

### `scripts/serve-harness.mjs`

Serves the built webview over HTTP with a stubbed VS Code bridge, so a recorded session can be replayed through the actual renderer in a real browser.

**Run:** `node scripts/serve-harness.mjs [port]`. Default port **5199**, bound to `127.0.0.1` only. Requires `npm run build:webview` to have produced `dist/webview/index.html` first — it reads that file at startup and throws if absent.

Behavior:
1. `ROOT = join(process.cwd(), "dist", "webview")`; `PORT = Number(process.argv[2] ?? 5199)`.
2. Reads the built `index.html` and regexes out the real asset paths: `/src="([^"]*assets\/index\.js)"/` and `/href="([^"]*assets\/index\.css)"/`, falling back to `./assets/index.js` and `./assets/index.css`. This works only because the Vite config emits hash-free entry/asset names.
3. Generates the harness HTML and **writes it to `dist/webview/harness.html`** at startup (excluded from the `.vsix`).
4. Starts an HTTP server. `/` maps to `harness.html`; any other path is resolved under `ROOT` with a `target.startsWith(ROOT)` traversal guard, 404 `"not found"` otherwise. Responses carry `cache-control: no-store`, and `harness.html` additionally gets the CSP header. Logs `harness ready on http://127.0.0.1:<PORT>/`.

The page body is `<body class="vscode-dark">` with a single `<div id="root">`, mirroring what VS Code injects. Globals defined by the nonce'd inline script:

| Global | Purpose |
|---|---|
| `window.__posted` | Array collecting every `postMessage` the webview sends host-ward. |
| `window.acquireVsCodeApi()` | Returns `{ postMessage, getState: () => undefined, setState: () => {} }`. |
| `window.__deliver(message)` | Dispatches a `MessageEvent("message", { data: message })` — the replay entry point for host→webview frames. |
| `window.__errors` | Collects `error` event messages and `unhandledrejection` reasons. |
| `window.__csp` | Collects `securitypolicyviolation` events as `"<violatedDirective> blocked <blockedURI>"`. |

#### Key internal detail — CSP parity

The nonce is the fixed literal `harnessNonce0123456789abcdef` and `ORIGIN` is `http://127.0.0.1:${PORT}`. The policy deliberately mirrors what `renderHtml` emits in `src/view/chat-view.ts`, per the source comment: *"the harness exercises the same nonce + strict-dynamic constraints a real webview imposes; a violation here is a violation in VS Code."*

```
default-src 'none';
img-src <ORIGIN> data: https:;
font-src <ORIGIN> data:;
style-src <ORIGIN> 'unsafe-inline';
script-src 'nonce-<NONCE>' 'strict-dynamic';
connect-src 'none'
```

MIME map (anything else → `application/octet-stream`): `.html`, `.js`, `.css`, `.json`, `.woff`, `.woff2`, `.ttf`, `.svg`.

### `scripts/harness/vscode-stub.ts`

Minimal stand-in for the `vscode` module, wired in via esbuild's `--alias:vscode=`. Per the file header: *"Only the surface the controller touches on the record path is implemented; anything else throws loudly rather than silently returning a plausible value."*

| Export | Kind | Signature |
|---|---|---|
| `Disposable` | class | `new Disposable(callOnDispose: () => void)` |
| `EventEmitter` | class | `new EventEmitter<T>()` |
| `Uri` | const | `{ file, parse, joinPath, from }` |
| `workspace` | const | see below |
| `window` | const | see below |
| `env` | const | `{ openExternal(): Promise<true>; clipboard: { writeText(): Promise<undefined> } }` |
| `commands` | const | `{ registerCommand(): Disposable; executeCommand(): Promise<undefined> }` |
| `Position` | class | `new Position(line: number, character: number)` |
| `Range` | class | `new Range(start: Position, end: Position)` |
| `Selection` | class | `class Selection extends Range {}` |
| `TextEditorRevealType` | const | `{ InCenterIfOutsideViewport: 2 }` |
| `harness` | const | `{ createLogChannel, CONFIG }` |

Faked `vscode` API surfaces, by namespace:

- `Disposable` — `dispose(): void` invokes the constructor callback. Static `Disposable.from(...items: Array<{ dispose(): unknown }>): Disposable` disposes each item in order.
- `EventEmitter<T>` — private `#listeners: Set<(value: T) => void>`. `readonly event = (listener: (value: T) => void) => Disposable` is an **arrow property**, so it is safe to detach and pass around like the real `Event<T>`. `fire(value: T): void` iterates listeners; `dispose(): void` clears the set.
- `Uri` — `file(path)` → `{ scheme: "file", fsPath, path, toString }`; `parse(value)` → scheme is `value.split(":")[0] ?? ""` with `fsPath`/`path` set to the raw value; `joinPath(base, ...segments)` joins with `/` (POSIX-only — this stub does not handle Windows separators); `from({ scheme, path })` spreads and adds `fsPath: parts.path`.
- `workspace` — `workspaceFolders: undefined`; `getConfiguration(_section)` → `{ get<T>(key, fallback?): T | undefined }` reading from the module-level `CONFIG` (the section argument is **ignored**; keys are looked up unprefixed, so `omp.model` is read as `model`); `asRelativePath(value)` → `String(value)`; `registerTextDocumentContentProvider()` and `onDidChangeConfiguration()` return no-op `Disposable`s. **Throws:** `openTextDocument()` — `"openTextDocument is not available in the harness"`; `fs.readFile()` — `"fs.readFile is not available in the harness"`.
- `window` — `createOutputChannel()` → `createLogChannel()`; `showInformationMessage`, `showWarningMessage`, `showErrorMessage`, `showOpenDialog`, `showQuickPick` all resolve `undefined`; `registerWebviewViewProvider()` returns a no-op `Disposable`; `activeTextEditor: undefined`. **Throws:** `showTextDocument()`, `createWebviewPanel()`.
- `env` — `openExternal()` resolves `true`; `clipboard.writeText()` resolves `undefined`.
- `commands` — `registerCommand()` returns a no-op `Disposable`; `executeCommand()` resolves `undefined`.
- Editor value types — `Position`, `Range`, `Selection` (an empty subclass of `Range`), and `TextEditorRevealType` with only `InCenterIfOutsideViewport: 2`.

Not faked at all (so any use throws a module-resolution or `undefined` error rather than misbehaving): `languages`, `debug`, `tasks`, `extensions`, `authentication`, `ViewColumn`, `ThemeIcon`, `MarkdownString`, `CancellationTokenSource`, `ProgressLocation`.

#### Key internal detail — `CONFIG` defaults

The non-exported `CONFIG` record backs `workspace.getConfiguration().get()`. It is reachable and mutable through `harness.CONFIG` (which `smoke-sessions.ts` uses to clear `extraArgs`).

```ts
const CONFIG: Record<string, unknown> = {
	executablePath: process.env.OMP_PATH ?? "omp",
	extraArgs: ["--no-session"],
	model: "",
	thinkingLevel: "",
	approvalMode: "",
	subagentSubscription: "progress",
	showThinking: true,
	autoScroll: true,
	sendKeybinding: "enter",
};
```

These mirror the `contributes.configuration` defaults with two divergences: `executablePath` honors `OMP_PATH`, and `extraArgs` defaults to `["--no-session"]` so harness runs do not litter the session store. `followActiveEditor` is absent — callers get the `fallback` argument they passed instead.

#### Key internal detail — log channel

`createLogChannel()` (module-private, re-exported only via `harness`) returns `{ info, warn, error, debug, trace, appendLine, show, dispose }`, which is the subset of `LogOutputChannel` the controller touches. All write methods are **silent unless `process.env.HARNESS_VERBOSE` is set**, in which case they `console.log("[<level>] <message>")`. `appendLine` maps to level `info`. `show` and `dispose` are no-ops. Set `HARNESS_VERBOSE=1` to see agent-side logging during smoke or record runs.
