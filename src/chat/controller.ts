import { readdir } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { OmpRpcClient, RpcClientError } from "../rpc/client";
import { listSessions } from "../session/session-store";
import type {
	AgentStatus,
	DialogAnswer,
	DraftState,
	HostMessage,
	SessionSnapshot,
	UiConfig,
	UiDialog,
	UiSnapshot,
	WebviewMessage,
} from "../shared/bridge";
import type { ChatState, SubagentState } from "../shared/chat-model";
import {
	applyEvent,
	applyMessages,
	createChatState,
	todosFromToolCall,
} from "../shared/chat-model";
import { isRecord } from "../shared/guards";
import type {
	AgentSessionEvent,
	ImageContent,
	LoginProvider,
	Model,
	RpcExtensionUIRequest,
	RpcSubagentFrame,
	SlashCommand,
	ThinkingLevel,
} from "../shared/protocol";
import { APPROVE_LABEL, DENY_LABEL } from "../shared/protocol";
import { openDiagram } from "../view/diagram-preview";
import type { DiffContentProvider } from "../view/diff-provider";

/** Streaming deltas are coalesced into one postMessage per frame budget. */
const EVENT_FLUSH_MS = 33;

export interface ControllerDeps {
  output: vscode.LogOutputChannel;
  diffs: DiffContentProvider;
  workspaceFolder: vscode.WorkspaceFolder | undefined;
  /**
   * Override the working directory the agent runs in. Defaults to the workspace
   * folder's path, or `process.cwd()` when no folder is open. Set this so a
   * project can be an arbitrary worktree directory that is not a VS Code
   * workspace folder.
   */
  cwd?: string;
  /**
   * Override the label shown in the UI. Defaults to the workspace folder name.
   * Useful for worktrees, where two folders share a repo name but differ by
   * branch.
   */
  label?: string;
  /**
   * Extra environment for the agent process, keyed by the session's cwd. Used
   * to inject the IDE-bridge address so the agent's MCP client can reach *this*
   * window, and to tell it which session's working directory it is serving.
   */
  agentEnv?: (cwd: string) => Record<string, string>;
}

/**
 * Owns one agent process plus the authoritative conversation state, and pushes
 * updates to every attached webview.
 *
 * Views come and go — VS Code disposes a hidden webview — so all durable state
 * lives here and is replayed as a snapshot whenever a view (re)attaches.
 */
export class ChatController implements vscode.Disposable {
  #client: OmpRpcClient | undefined;
  #chat: ChatState = createChatState();
  #commands: SlashCommand[] = [];
  #models: Model[] = [];
  #dialogs = new Map<string, UiDialog>();
  #subagents = new Map<string, SubagentState>();
  #draft: DraftState = { text: "", images: [] };
  #listeners = new Set<(message: HostMessage) => void>();
  #pendingEvents: AgentSessionEvent[] = [];
  #flushTimer: NodeJS.Timeout | undefined;
  #starting: Promise<void> | undefined;
  #disposed = false;

  #session: SessionSnapshot;

  constructor(private readonly deps: ControllerDeps) {
    const cwd = deps.cwd ?? deps.workspaceFolder?.uri.fsPath ?? process.cwd();
    this.#session = {
      agentStatus: "starting",
      isStreaming: false,
      isCompacting: false,
      fastModeEnabled: false,
      fastModeActive: false,
      autoCompactionEnabled: true,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      tokensPerSecond: null,
      queuedMessageCount: 0,
      cwd,
      workspaceName: deps.label ?? deps.workspaceFolder?.name ?? "workspace",
    };
  }

  // -----------------------------------------------------------------------
  // View attachment
  // -----------------------------------------------------------------------

  subscribe(listener: (message: HostMessage) => void): vscode.Disposable {
    this.#listeners.add(listener);
    return new vscode.Disposable(() => this.#listeners.delete(listener));
  }

  snapshot(): UiSnapshot {
    return {
      chat: this.#chat,
      session: this.#session,
      commands: this.#commands,
      models: this.#models,
      dialogs: [...this.#dialogs.values()],
      subagents: [...this.#subagents.values()],
      config: readUiConfig(),
    };
  }

  get draft(): DraftState {
    return this.#draft;
  }

  #post(message: HostMessage): void {
    for (const listener of this.#listeners) listener(message);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Idempotent: concurrent callers share one startup. */
  start(): Promise<void> {
    if (this.#starting) return this.#starting;
    this.#starting = this.#startAgent().catch((error) => {
      this.#setStatus("error", describe(error));
      this.deps.output.error(`failed to start omp: ${describe(error)}`);
    });
    return this.#starting;
  }

  async restart(): Promise<void> {
    this.#setStatus("restarting");
    await this.#client?.dispose();
    this.#client = undefined;
    this.#starting = undefined;
    this.#chat = createChatState();
    this.#dialogs.clear();
    this.#subagents.clear();
    this.#pushSnapshot();
    await this.start();
  }

  async #startAgent(): Promise<void> {
    const config = vscode.workspace.getConfiguration("omp");
    const extraArgs: string[] = [];
    const model = config.get<string>("model")?.trim();
    if (model) extraArgs.push("--model", model);
    const thinking = config.get<string>("thinkingLevel")?.trim();
    if (thinking) extraArgs.push("--thinking", thinking);
    const approval = config.get<string>("approvalMode")?.trim();
    if (approval) extraArgs.push("--approval-mode", approval);
    extraArgs.push(...(config.get<string[]>("extraArgs") ?? []));

    const client = new OmpRpcClient(
      {
        executable: config.get<string>("executablePath")?.trim() || "omp",
        extraArgs,
        cwd: this.#session.cwd,
        env: this.deps.agentEnv?.(this.#session.cwd),
        log: (message) => this.deps.output.info(message),
      },
      {
        onSessionEvent: (event) => this.#onSessionEvent(event),
        onSubagentFrame: (frame) => this.#onSubagentFrame(frame),
        onUiRequest: (request) => this.#onUiRequest(request),
        onCommands: (commands) => {
          this.#commands = commands;
          this.#post({ type: "commands", commands });
        },
        onSessionInfo: (info) => {
          this.#session = {
            ...this.#session,
            sessionName: info.title ?? this.#session.sessionName,
            sessionId: info.sessionId ?? this.#session.sessionId,
          };
          this.#post({ type: "session", session: this.#session });
        },
        onConfigUpdate: (update) => {
          this.#session = {
            ...this.#session,
            model: (update.model as Model | undefined) ?? this.#session.model,
            thinkingLevel:
              (update.thinkingLevel as ThinkingLevel | undefined) ??
              this.#session.thinkingLevel,
          };
          this.#post({ type: "session", session: this.#session });
        },
        onCommandOutput: (text) => this.#post({ type: "commandOutput", text }),
        onExtensionError: (frame) =>
          this.deps.output.warn(
            `extension ${frame.extensionPath} failed on ${frame.event}: ${frame.error}`,
          ),
        onStderr: (text) => {
          const trimmed = text.trimEnd();
          if (trimmed) this.deps.output.warn(trimmed);
        },
        onExit: (code, signal) => {
          this.#client = undefined;
          this.#starting = undefined;
          for (const id of this.#dialogs.keys())
            this.#post({ type: "dialogClose", id });
          this.#dialogs.clear();
          this.#setStatus(
            "exited",
            `omp exited (code=${code ?? "null"} signal=${signal ?? "none"})`,
          );
        },
      },
    );

    this.#client = client;
    this.#setStatus("starting");
    await client.start();
    this.#setStatus("ready");

    await this.#refreshState();
    void this.#refreshModels();
    void client
      .request("set_subagent_subscription", {
        level: vscode.workspace
          .getConfiguration("omp")
          .get<
            "off" | "progress" | "events"
          >("subagentSubscription", "progress"),
      })
      .catch((error) =>
        this.deps.output.warn(
          `subagent subscription failed: ${describe(error)}`,
        ),
      );
    await this.#hydrateMessages();
  }

  #setStatus(agentStatus: AgentStatus, statusDetail?: string): void {
    this.#session = { ...this.#session, agentStatus, statusDetail };
    this.#post({ type: "session", session: this.#session });
  }

  #pushSnapshot(): void {
    this.#post({
      type: "snapshot",
      snapshot: this.snapshot(),
      draft: this.#draft,
    });
  }

  // -----------------------------------------------------------------------
  // Agent -> UI
  // -----------------------------------------------------------------------

  #onSessionEvent(event: AgentSessionEvent): void {
    this.#chat = applyEvent(this.#chat, event);

    // A `todo` tool result is the only authoritative todo snapshot the agent
    // publishes mid-run; `get_state` would otherwise lag a full round trip.
    if (event.type === "tool_execution_end" && event.toolName === "todo") {
      const phases = todosFromToolCall(event.result);
      if (phases) {
        this.#chat = { ...this.#chat, todoPhases: phases };
        this.#post({ type: "todos", phases });
      }
    }

    if (event.type === "agent_start") {
      this.#session = { ...this.#session, isStreaming: true };
      this.#post({ type: "session", session: this.#session });
    } else if (event.type === "agent_end" && event.isTerminal !== false) {
      this.#session = { ...this.#session, isStreaming: false };
      this.#post({ type: "session", session: this.#session });
      void this.#refreshState();
    } else if (event.type === "model_changed") {
      void this.#refreshState();
    }

    this.#pendingEvents.push(event);
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      if (this.#pendingEvents.length === 0) return;
      const events = this.#pendingEvents;
      this.#pendingEvents = [];
      this.#post({ type: "events", events });
    }, EVENT_FLUSH_MS);
  }

  #onSubagentFrame(frame: RpcSubagentFrame): void {
    if (frame.type === "subagent_lifecycle") {
      const payload = frame.payload;
      const existing = this.#subagents.get(payload.id);
      // Terminal agents are dropped from the agent's own registry, so the
      // completed history only survives if the host keeps it.
      this.#subagents.set(payload.id, {
        ...existing,
        id: payload.id,
        index: payload.index,
        agent: payload.agent,
        description: payload.description,
        parentToolCallId: payload.parentToolCallId,
        sessionFile: payload.sessionFile ?? existing?.sessionFile,
        status: payload.status === "started" ? "running" : payload.status,
        lastUpdate: Date.now(),
      });
    } else if (frame.type === "subagent_progress") {
      const payload = frame.payload;
      const progress = payload.progress;
      const existing = this.#subagents.get(progress.id);
      this.#subagents.set(progress.id, {
        ...existing,
        id: progress.id,
        index: progress.index,
        agent: progress.agent,
        description: progress.description ?? existing?.description,
        task: progress.task,
        status: progress.status,
        parentToolCallId:
          payload.parentToolCallId ?? existing?.parentToolCallId,
        sessionFile: payload.sessionFile ?? existing?.sessionFile,
        toolCount: progress.toolCount,
        tokens: progress.tokens,
        contextTokens: progress.contextTokens,
        contextWindow: progress.contextWindow,
        cost: progress.cost,
        durationMs: progress.durationMs,
        currentTool: progress.currentTool,
        lastIntent: progress.lastIntent,
        resolvedModel: progress.resolvedModel,
        lastUpdate: Date.now(),
      });
    } else {
      return;
    }
    this.#post({ type: "subagents", subagents: [...this.#subagents.values()] });
  }

  #onUiRequest(request: RpcExtensionUIRequest): void {
    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor": {
        const dialog = toDialog(request);
        this.#dialogs.set(dialog.id, dialog);
        this.#post({ type: "dialogOpen", dialog });
        return;
      }
      case "cancel":
        this.#dialogs.delete(request.targetId);
        this.#post({ type: "dialogClose", id: request.targetId });
        return;
      case "notify":
        this.#post({
          type: "notify",
          level: request.notifyType ?? "info",
          message: request.message,
        });
        return;
      case "open_url":
        void this.#openLoginUrl(
          request.url,
          request.launchUrl,
          request.instructions,
        );
        return;
      case "set_editor_text":
        this.#draft = { ...this.#draft, text: request.text };
        this.#post({ type: "setComposerText", text: request.text });
        return;
      // Terminal-shaped chrome with no webview analogue. Fire-and-forget by
      // contract, so dropping them cannot stall the agent.
      case "setStatus":
      case "setWidget":
      case "setTitle":
        return;
    }
  }

  async #openLoginUrl(
    url: string,
    launchUrl: string | undefined,
    instructions: string | undefined,
  ): Promise<void> {
    this.deps.output.info(`login: opening ${url}`);
    await vscode.env.openExternal(vscode.Uri.parse(launchUrl ?? url));
    const copy = "Copy link";
    const message =
      instructions ?? "Complete the sign-in in your browser, then return here.";
    const choice = await vscode.window.showInformationMessage(
      `OMP sign-in: ${message}`,
      copy,
    );
    if (choice === copy) await vscode.env.clipboard.writeText(launchUrl ?? url);
  }

  // -----------------------------------------------------------------------
  // UI -> agent
  // -----------------------------------------------------------------------

  async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    try {
      await this.#handle(message);
    } catch (error) {
      const detail =
        error instanceof RpcClientError
          ? `${error.command}: ${error.message}`
          : describe(error);
      this.deps.output.error(detail);
      this.#post({ type: "notify", level: "error", message: detail });
    }
  }

  async #handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.#pushSnapshot();
        void this.start();
        return;

      case "submit":
        await this.#submit(message.text, message.images, message.behavior);
        return;

      case "abort":
        await this.#require().request("abort");
        return;

      case "dialogAnswer":
        this.#answerDialog(message.id, message.answer);
        return;

      case "setModel":
        await this.#require().request("set_model", {
          provider: message.provider,
          modelId: message.modelId,
        });
        await this.#refreshState();
        return;

      case "setThinkingLevel":
        await this.#require().request("set_thinking_level", {
          level: message.level,
        });
        await this.#refreshState();
        return;

      case "setFastMode": {
        const data = await this.#require().request("set_fast_mode", {
          enabled: message.enabled,
        });
        this.#session = {
          ...this.#session,
          fastModeEnabled: data.enabled,
          fastModeActive: data.active,
        };
        this.#post({ type: "session", session: this.#session });
        return;
      }

      case "setAutoCompaction":
        await this.#require().request("set_auto_compaction", {
          enabled: message.enabled,
        });
        await this.#refreshState();
        return;

      case "setSteeringMode":
        await this.#require().request("set_steering_mode", {
          mode: message.mode,
        });
        await this.#refreshState();
        return;

      case "setTodos": {
        const data = await this.#require().request("set_todos", {
          phases: message.phases,
        });
        this.#chat = { ...this.#chat, todoPhases: data.todoPhases };
        this.#post({ type: "todos", phases: data.todoPhases });
        return;
      }

      case "compact":
        await this.#require().request("compact");
        await this.#refreshState();
        return;

      case "resetSession": {
        const data = await this.#require().request("new_session");
        if (data.cancelled) {
          this.#post({
            type: "notify",
            level: "warning",
            message: "New session was cancelled by an extension.",
          });
          return;
        }
        this.#chat = createChatState();
        this.#subagents.clear();
        await this.#refreshState();
        this.#pushSnapshot();
        return;
      }

      case "switchSession": {
        const data = await this.#require().request("switch_session", {
          sessionPath: message.path,
        });
        if (data.cancelled) {
          this.#post({
            type: "notify",
            level: "warning",
            message: "Session switch was cancelled by an extension.",
          });
          return;
        }
        this.#subagents.clear();
        await this.#refreshState();
        await this.#hydrateMessages();
        this.#pushSnapshot();
        return;
      }

      case "requestSessions":
        this.#post({
          type: "savedSessions",
          sessions: await listSessions({
            cwd: this.#session.cwd,
            currentSessionFile: this.#session.sessionFile,
          }),
        });
        return;

      case "setSessionName":
        await this.#require().request("set_session_name", {
          name: message.name,
        });
        await this.#refreshState();
        return;

      case "requestBranchPoints": {
        const data = await this.#require().request("get_branch_messages");
        this.#post({ type: "branchPoints", messages: data.messages });
        return;
      }

      case "branch": {
        const data = await this.#require().request("branch", {
          entryId: message.entryId,
        });
        if (data.cancelled) {
          this.#post({
            type: "notify",
            level: "warning",
            message: "Branch was cancelled by an extension.",
          });
          return;
        }
        await this.#refreshState();
        await this.#hydrateMessages();
        this.#pushSnapshot();
        if (data.text) this.#post({ type: "setComposerText", text: data.text });
        return;
      }

      case "exportHtml": {
        const data = await this.#require().request("export_html");
        const open = "Open";
        const choice = await vscode.window.showInformationMessage(
          `Exported session to ${data.path}`,
          open,
        );
        if (choice === open)
          await vscode.env.openExternal(vscode.Uri.file(data.path));
        return;
      }

      case "restartAgent":
        await this.restart();
        return;

      case "refreshState":
        await this.#refreshState();
        return;

      case "saveDraft":
        this.#draft = message.draft;
        return;

      case "openFile":
        await this.openFile(message.path, message.line, message.column);
        return;

      case "openDiff": {
        const left = this.deps.diffs.store("before", message.oldText);
        const right = this.deps.diffs.store("after", message.newText);
        await vscode.commands.executeCommand(
          "vscode.diff",
          left,
          right,
          message.title,
        );
        return;
      }

      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;

      case "openArtifact":
        await this.#openArtifact(message.url);
        return;

      case "openDiagram":
        await openDiagram(message);
        return;

      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        this.#post({
          type: "notify",
          level: "info",
          message: "Copied to clipboard.",
        });
        return;

      case "revealSubagent": {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(message.sessionFile),
        );
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }

      case "pickImages": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: "Attach",
          filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
        });
        if (!picked?.length) return;
        const images: ImageContent[] = [];
        for (const uri of picked) {
          const bytes = await vscode.workspace.fs.readFile(uri);
          images.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: mimeForPath(uri.fsPath),
          });
        }
        this.#draft = {
          ...this.#draft,
          images: [...this.#draft.images, ...images],
        };
        this.#pushSnapshot();
        return;
      }

      case "showLog":
        this.deps.output.show(true);
        return;

      case "loginProvider":
        await this.loginProvider();
        return;
    }
  }

  /**
   * Open a spilled tool artifact.
   *
   * `artifact://<id>` names a file in the session's sibling artifact directory
   * — `<sessionFile without .jsonl>/<id>.<kind>` — so it resolves on disk with
   * no round trip through the agent.
   */
  async #openArtifact(url: string): Promise<void> {
    const id = /^artifact:\/\/([\w.-]+)/.exec(url)?.[1];
    const sessionFile = this.#session.sessionFile;
    if (!id || !sessionFile) {
      this.#post({
        type: "notify",
        level: "warning",
        message: `Cannot resolve ${url} without a saved session.`,
      });
      return;
    }
    const directory = sessionFile.replace(/\.jsonl$/, "");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      names = [];
    }
    const match = names.find(
      (name) => name === id || name.startsWith(`${id}.`),
    );
    if (!match) {
      this.#post({
        type: "notify",
        level: "warning",
        message: `Artifact ${id} is no longer on disk.`,
      });
      return;
    }
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(directory, match)),
    );
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async #submit(
    text: string,
    images: ImageContent[],
    behavior: "steer" | "followUp" | undefined,
  ): Promise<void> {
    const client = this.#require();
    this.#draft = { text: "", images: [] };
    const payload = { message: text, ...(images.length > 0 ? { images } : {}) };

    if (!this.#session.isStreaming) {
      await client.request("prompt", payload);
      return;
    }
    // Streaming requires an explicit queue policy; steering interrupts the
    // current turn, follow-up waits for it.
    await client.request("prompt", {
      ...payload,
      streamingBehavior: behavior ?? "steer",
    });
  }

  #answerDialog(id: string, answer: DialogAnswer): void {
    const client = this.#client;
    this.#dialogs.delete(id);
    this.#post({ type: "dialogClose", id });
    if (!client) return;
    switch (answer.kind) {
      case "value":
        client.respondToUi({
          type: "extension_ui_response",
          id,
          value: answer.value,
        });
        return;
      case "confirmed":
        client.respondToUi({
          type: "extension_ui_response",
          id,
          confirmed: answer.confirmed,
        });
        return;
      case "cancelled":
        client.respondToUi({
          type: "extension_ui_response",
          id,
          cancelled: true,
        });
        return;
    }
  }

  // -----------------------------------------------------------------------
  // Commands invoked from VS Code chrome
  // -----------------------------------------------------------------------

  /** Start a fresh conversation in this session's existing agent process. */
  async resetSession(): Promise<void> {
    await this.handleWebviewMessage({ type: "resetSession" });
  }

  async abort(): Promise<void> {
    await this.handleWebviewMessage({ type: "abort" });
  }

  async compact(): Promise<void> {
    await this.handleWebviewMessage({ type: "compact" });
  }

  async exportHtml(): Promise<void> {
    await this.handleWebviewMessage({ type: "exportHtml" });
  }

  appendToComposer(text: string): void {
    this.#draft = {
      ...this.#draft,
      text: this.#draft.text ? `${this.#draft.text}\n${text}` : text,
    };
    this.#post({ type: "appendComposerText", text });
    this.#post({ type: "focusComposer" });
  }

  async pickAndSwitchSession(): Promise<void> {
    const sessions = await listSessions({
      cwd: this.#session.cwd,
      currentSessionFile: this.#session.sessionFile,
    });
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(
        "No saved omp sessions for this workspace yet.",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: session.name,
        description: session.current ? "current" : session.status,
        detail: `${new Date(session.modified).toLocaleString()} · ${session.messageCount} messages`,
        session,
      })),
      { title: "Resume omp session", matchOnDetail: true },
    );
    if (!picked) return;
    await this.handleWebviewMessage({
      type: "switchSession",
      path: picked.session.path,
    });
  }

  async pickModel(): Promise<void> {
    if (this.#models.length === 0) await this.#refreshModels();
    const picked = await vscode.window.showQuickPick(
      this.#models.map((model) => ({
        label: model.name,
        description: `${model.provider}/${model.id}`,
        detail: model.contextWindow
          ? `${Math.round(model.contextWindow / 1000)}K context`
          : undefined,
        model,
      })),
      { title: "Select omp model", matchOnDescription: true },
    );
    if (!picked) return;
    await this.handleWebviewMessage({
      type: "setModel",
      provider: picked.model.provider,
      modelId: picked.model.id,
    });
  }

  /**
   * Ask the agent which providers it can authenticate with, let the user pick
   * one, then start that provider's login flow. The agent drives the actual
   * OAuth redirect through `open_url` (see `#openLoginUrl`), so this only
   * needs to kick the request off and report failures.
   */
  async loginProvider(): Promise<void> {
    const client = this.#client;
    if (!client?.running) {
      void vscode.window.showWarningMessage(
        "omp is not running. Restart the agent process first.",
      );
      return;
    }
    let providers: LoginProvider[];
    try {
      providers = (await client.request("get_login_providers")).providers;
    } catch (error) {
      this.deps.output.warn(`login providers unavailable: ${describe(error)}`);
      void vscode.window.showWarningMessage(
        `Could not list login providers: ${describe(error)}`,
      );
      return;
    }
    if (providers.length === 0) {
      void vscode.window.showInformationMessage(
        "No login providers are available.",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      providers.map((provider) => ({
        label: provider.name,
        description: provider.authenticated
          ? "signed in"
          : provider.available
            ? undefined
            : "unavailable",
        provider,
      })),
      { title: "Sign in to a provider", matchOnDescription: true },
    );
    if (!picked) return;
    if (!picked.provider.available) {
      void vscode.window.showWarningMessage(
        `${picked.provider.name} is not available right now.`,
      );
      return;
    }
    if (picked.provider.authenticated) {
      const again = "Sign in again";
      const choice = await vscode.window.showInformationMessage(
        `Already signed in to ${picked.provider.name}. Sign in again?`,
        again,
      );
      if (choice !== again) return;
    }
    try {
      await client.request("login", { providerId: picked.provider.id });
    } catch (error) {
      this.deps.output.error(`login failed: ${describe(error)}`);
      void vscode.window.showErrorMessage(
        `Sign-in with ${picked.provider.name} failed: ${describe(error)}`,
      );
    }
  }

  async openFile(
    target: string,
    line?: number,
    column?: number,
  ): Promise<void> {
    const uri = vscode.Uri.file(target);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
    });
    if (line === undefined) return;
    const position = new vscode.Position(
      Math.max(0, line - 1),
      Math.max(0, (column ?? 1) - 1),
    );
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  notifyConfigChanged(): void {
    this.#post({ type: "config", config: readUiConfig() });
  }

  // -----------------------------------------------------------------------
  // Refresh helpers
  // -----------------------------------------------------------------------

  async #refreshState(): Promise<void> {
    const client = this.#client;
    if (!client?.running) return;
    const state = await client.request("get_state");
    this.#session = {
      ...this.#session,
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      sessionFile: state.sessionFile,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      fastModeEnabled: state.fastModeEnabled,
      fastModeActive: state.fastModeActive,
      autoCompactionEnabled: state.autoCompactionEnabled,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      tokensPerSecond: state.tokensPerSecond,
      queuedMessageCount: state.queuedMessageCount,
      contextUsage: state.contextUsage,
    };
    if (state.todoPhases) {
      this.#chat = { ...this.#chat, todoPhases: state.todoPhases };
      this.#post({ type: "todos", phases: state.todoPhases });
    }
    this.#post({ type: "session", session: this.#session });
  }

  async #refreshModels(): Promise<void> {
    const client = this.#client;
    if (!client?.running) return;
    try {
      const data = await client.request("get_available_models");
      this.#models = data.models;
      this.#post({ type: "models", models: this.#models });
    } catch (error) {
      this.deps.output.warn(`model list unavailable: ${describe(error)}`);
    }
  }

  async #hydrateMessages(): Promise<void> {
    const client = this.#client;
    if (!client?.running) return;
    try {
      const data = await client.request("get_messages");
      this.#chat = applyMessages(this.#chat, data.messages);
      this.#pushSnapshot();
    } catch (error) {
      this.deps.output.warn(
        `could not load session history: ${describe(error)}`,
      );
    }
  }

  #require(): OmpRpcClient {
    const client = this.#client;
    if (!client?.running)
      throw new Error(
        "omp is not running. Use “OMP: Restart Agent Process” to start it again.",
      );
    return client;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#flushTimer);
    this.#listeners.clear();
    void this.#client?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readUiConfig(): UiConfig {
  const config = vscode.workspace.getConfiguration("omp");
  return {
    showThinking: config.get<boolean>("showThinking", true),
    autoScroll: config.get<boolean>("autoScroll", true),
    sendKeybinding: config.get<"enter" | "ctrl+enter">(
      "sendKeybinding",
      "enter",
    ),
  };
}

/**
 * Tool approval arrives as an ordinary `select` whose options are exactly
 * Approve/Deny and whose multi-line title is a pre-rendered prompt. Recovering
 * the tool name lets the webview render a real approval card instead of a
 * generic question.
 */
function parseApproval(title: string, options: string[]): UiDialog["approval"] {
  if (
    options.length !== 2 ||
    options[0] !== APPROVE_LABEL ||
    options[1] !== DENY_LABEL
  )
    return undefined;
  const lines = title.split("\n");
  const first = lines[0] ?? "";
  const match = /^Allow tool:\s*(.+)$/.exec(first);
  if (!match) return undefined;
  const reasonLine = lines.find((line) => line.startsWith("Reason: "));
  return {
    toolName: match[1] ?? "tool",
    reason: reasonLine?.slice("Reason: ".length),
    detail: lines
      .slice(1)
      .filter((line) => !line.startsWith("Reason: "))
      .join("\n")
      .trim(),
  };
}

function toDialog(request: RpcExtensionUIRequest): UiDialog {
  const base = { id: request.id, title: "", createdAt: Date.now() };
  switch (request.method) {
    case "select":
      return {
        ...base,
        method: "select",
        title: request.title,
        options: request.options,
        timeout: request.timeout,
        approval: parseApproval(request.title, request.options),
      };
    case "confirm":
      return {
        ...base,
        method: "confirm",
        title: request.title,
        message: request.message,
        timeout: request.timeout,
      };
    case "input":
      return {
        ...base,
        method: "input",
        title: request.title,
        placeholder: request.placeholder,
        timeout: request.timeout,
      };
    case "editor":
      return {
        ...base,
        method: "editor",
        title: request.title,
        prefill: request.prefill,
        promptStyle: request.promptStyle,
      };
    default:
      return { ...base, method: "input", title: "Input" };
  }
}

function mimeForPath(file: string): string {
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const byExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return byExtension[extension] ?? "image/png";
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string")
    return error.message;
  return String(error);
}
