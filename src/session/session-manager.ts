import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { ChatController, type ControllerDeps } from "../chat/controller";
import type {
  HostMessage,
  ProjectEntry,
  SessionEntry,
  SessionStatus,
  WebviewMessage,
} from "../shared/bridge";

/**
 * The minimal surface a webview binding needs. Every webview — sidebar or
 * editor panel — binds to one of these; see {@link SessionManager.sidebar} and
 * {@link SessionManager.surface}.
 */
export interface ChatSurface {
  subscribe(listener: (message: HostMessage) => void): vscode.Disposable;
  handleWebviewMessage(message: WebviewMessage): Promise<void>;
}

interface ManagedSession {
  entry: SessionEntry;
  controller: ChatController;
  /** The manager's own subscription to this controller's host messages. */
  subscription: vscode.Disposable;
  status: SessionStatus;
  /** Mirror of the controller's private dialog set, for badge tracking. */
  dialogCount: number;
}

/**
 * A bound webview. `pinned` is the session an editor panel is fixed to;
 * `undefined` means the surface follows whichever session is active (the
 * sidebar).
 */
interface BoundSurface {
  pinned: string | undefined;
  listener: (message: HostMessage) => void;
}

/** Editor-panel control, wired by `extension.ts` to avoid a circular import. */
export interface SessionPanels {
  open(sessionId: string): void;
  close(sessionId: string): void;
}

/** Dependencies shared by every session's controller. */
export interface SessionManagerDeps {
  output: vscode.LogOutputChannel;
  diffs: ControllerDeps["diffs"];
  agentEnv?: ControllerDeps["agentEnv"];
}

/**
 * Owns the registered projects and every *live session* running against them.
 *
 * A project is just a `cwd`. A session is one {@link ChatController}, and
 * therefore one `omp --mode rpc-ui` child process with its own on-disk session
 * file — so a project can host several concurrent sessions, and several
 * projects can run at once. Controllers spawn lazily: a session created but
 * never focused costs nothing until `start()`.
 *
 * Webviews attach through {@link sidebar} (follows the active session) or
 * {@link surface} (pinned to one session). The manager fans a controller's
 * host messages out to the surfaces showing that session, and broadcasts the
 * project/session roster plus per-session badges to all of them.
 */
export class SessionManager implements vscode.Disposable {
  #deps: SessionManagerDeps;
  #projects = new Map<string, ProjectEntry>();
  /** Registration order, so the switcher lists projects predictably. */
  #projectOrder: string[] = [];
  #sessions = new Map<string, ManagedSession>();
  /** Creation order, so the switcher lists sessions predictably. */
  #sessionOrder: string[] = [];
  /** Monotonic per project: ordinals are never reused, so labels stay stable. */
  #minted = new Map<string, number>();
  #activeId: string | undefined;
  #surfaces = new Set<BoundSurface>();
  #changed = new vscode.EventEmitter<void>();
  #disposed = false;

  /** Fires when the project/session roster or a session's name changes. */
  readonly onDidChangeSessions = this.#changed.event;

  /** Editor panels for sessions. Set by `extension.ts`. */
  panels: SessionPanels | undefined;

  constructor(deps: SessionManagerDeps) {
    this.#deps = deps;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /** Register a project (idempotent). Creates no session on its own. */
  registerProject(entry: ProjectEntry): ProjectEntry {
    const existing = this.#projects.get(entry.id);
    if (existing) return existing;
    this.#projects.set(entry.id, entry);
    this.#projectOrder.push(entry.id);
    this.#broadcastWorkspace();
    void this.#refreshBranch(entry.id);
    return entry;
  }

  /** All registered projects, in registration order. */
  projects(): ProjectEntry[] {
    return this.#projectOrder
      .map((id) => this.#projects.get(id))
      .filter((entry): entry is ProjectEntry => entry !== undefined);
  }

  /**
   * Register a project/worktree that isn't a VS Code workspace folder, via the
   * native open-folder dialog, then start a session in it.
   */
  async addFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Add project",
    });
    const fsPath = picked?.[0]?.fsPath;
    if (!fsPath) return;
    this.registerProject({
      id: fsPath,
      cwd: fsPath,
      label: path.basename(fsPath),
    });
    const id = this.createSession(fsPath);
    if (id) this.selectSession(id);
  }

  /**
   * Drop a project from the roster and terminate every session it owns.
   *
   * Refused when the project holds the window's last live session, for the
   * same reason {@link closeSession} refuses: the switcher always shows one.
   * The mint counter goes with the project — nothing of it survives, so a
   * folder added again later starts from `#1`.
   */
  removeProject(projectId: string): void {
    const project = this.#projects.get(projectId);
    if (!project) return;

    const owned = this.#sessionOrder.filter(
      (id) => this.#sessions.get(id)?.entry.projectId === projectId,
    );
    if (owned.length > 0 && owned.length === this.#sessionOrder.length) {
      this.#broadcast({
        type: "notify",
        level: "warning",
        message: `Cannot remove ${project.label}: it holds the only open session.`,
      });
      return;
    }

    // Where the active session sat, so focus can land on whatever takes its
    // slot rather than jumping to the top of the roster.
    const activeIndex = this.#sessionOrder.indexOf(this.#activeId ?? "");
    const droppedActive = owned.includes(this.#activeId ?? "");

    for (const id of owned) {
      const session = this.#sessions.get(id);
      if (!session) continue;
      this.#sessionOrder.splice(this.#sessionOrder.indexOf(id), 1);
      this.#sessions.delete(id);
      session.subscription.dispose();
      session.controller.dispose();
      this.panels?.close(id);
    }

    this.#projects.delete(projectId);
    this.#projectOrder.splice(this.#projectOrder.indexOf(projectId), 1);
    this.#minted.delete(projectId);

    if (droppedActive) {
      this.#activeId =
        this.#sessionOrder[Math.min(activeIndex, this.#sessionOrder.length - 1)];
      this.#onActiveChanged();
      return;
    }
    this.#broadcastWorkspace();
    this.#changed.fire();
  }

  /**
   * Ask which registered project to drop, then {@link removeProject} it. The
   * command-palette twin of the switcher's per-project remove button.
   */
  async removeFolder(): Promise<void> {
    const projects = this.projects();
    if (projects.length === 0) return;
    const picked = await vscode.window.showQuickPick(
      projects.map((project) => ({
        label: project.label,
        description: project.cwd,
        id: project.id,
      })),
      {
        title: "Remove project folder",
        placeHolder: "Its sessions are closed and their agents terminated",
      },
    );
    if (picked) this.removeProject(picked.id);
  }

  /**
   * Find the registered project whose cwd contains `uri`, if any. Used by the
   * `followActiveEditor` setting to auto-switch the chat.
   */
  findProjectForUri(uri: vscode.Uri): string | undefined {
    const fsPath = uri.fsPath;
    if (!fsPath) return undefined;
    for (const id of this.#projectOrder) {
      const project = this.#projects.get(id);
      if (!project) continue;
      const relative = path.relative(project.cwd, fsPath);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Make some session of `projectId` active without opening a panel, creating
   * one if the project has none yet.
   */
  focusProject(projectId: string): void {
    if (!this.#projects.has(projectId)) return;
    const existing = this.#sessionOrder.find(
      (id) => this.#sessions.get(id)?.entry.projectId === projectId,
    );
    const id = existing ?? this.createSession(projectId);
    if (id) this.setActive(id);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Create an additional session in `projectId`. The controller — and its
   * agent process — spawns on first focus, not here.
   */
  createSession(projectId: string): string | undefined {
    const project = this.#projects.get(projectId);
    if (!project) return undefined;

    const ordinal = (this.#minted.get(projectId) ?? 0) + 1;
    this.#minted.set(projectId, ordinal);
    const id = `${projectId}#${ordinal}`;

    const controller = new ChatController({
      output: this.#deps.output,
      diffs: this.#deps.diffs,
      agentEnv: this.#deps.agentEnv,
      workspaceFolder: undefined,
      cwd: project.cwd,
      label: project.label,
    });

    const session: ManagedSession = {
      entry: { id, projectId, projectLabel: project.label, ordinal },
      controller,
      subscription: controller.subscribe((message) =>
        this.#forwardFromController(id, message),
      ),
      status: { id, isStreaming: false, hasPendingDialog: false },
      dialogCount: 0,
    };
    this.#sessions.set(id, session);
    this.#sessionOrder.push(id);

    // The first session becomes active so the sidebar has something to show.
    if (this.#activeId === undefined) this.#activeId = id;

    this.#broadcastWorkspace();
    this.#changed.fire();
    return id;
  }

  /** All live sessions, in creation order. */
  sessions(): SessionEntry[] {
    return this.#sessionOrder
      .map((id) => this.#sessions.get(id)?.entry)
      .filter((entry): entry is SessionEntry => entry !== undefined);
  }

  /** The entry for a session id, or undefined. */
  sessionEntry(id: string): SessionEntry | undefined {
    return this.#sessions.get(id)?.entry;
  }

  get activeSessionId(): string | undefined {
    return this.#activeId;
  }

  /** The active session's controller (falls back to the oldest session). */
  active(): ChatController {
    const controller = this.controller(this.#activeId);
    if (controller) return controller;
    const first = this.#sessionOrder[0];
    const fallback = first ? this.#sessions.get(first) : undefined;
    if (!fallback) throw new Error("No OMP session is open.");
    this.#activeId = fallback.entry.id;
    return fallback.controller;
  }

  /** Look up a controller by session id. */
  controller(id: string | undefined): ChatController | undefined {
    if (id === undefined) return undefined;
    return this.#sessions.get(id)?.controller;
  }

  /**
   * Make `id` the active session for the sidebar and open/focus its editor
   * panel. Starting the agent is idempotent, and the sidebar only sends `ready`
   * once, so a freshly focused session needs an explicit kick.
   */
  selectSession(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    const changed = this.#activeId !== id;
    this.#activeId = id;
    void session.controller.start();
    if (changed) this.#onActiveChanged();
    this.panels?.open(id);
  }

  /** Set the active session without opening a panel (used on panel focus). */
  setActive(id: string): void {
    if (!this.#sessions.has(id) || this.#activeId === id) return;
    this.#activeId = id;
    void this.#sessions.get(id)?.controller.start();
    this.#onActiveChanged();
  }

  /**
   * Start another session in `projectId` (defaulting to the project of the
   * session the request came from), focus it, and open its panel so the two
   * conversations are visible side by side.
   */
  newSession(projectId?: string): string | undefined {
    const target =
      projectId ??
      this.#sessions.get(this.#activeId ?? "")?.entry.projectId ??
      this.#projectOrder[0];
    if (!target) return undefined;
    const id = this.createSession(target);
    if (id) this.selectSession(id);
    return id;
  }

  /**
   * Terminate a session's agent and drop it from the switcher. The window
   * always keeps at least one session, so closing the last one is refused.
   */
  closeSession(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    if (this.#sessionOrder.length <= 1) {
      this.#broadcast({
        type: "notify",
        level: "warning",
        message: "Cannot close the only open session.",
      });
      return;
    }

    const index = this.#sessionOrder.indexOf(id);
    this.#sessionOrder.splice(index, 1);
    this.#sessions.delete(id);
    session.subscription.dispose();
    session.controller.dispose();
    this.panels?.close(id);

    if (this.#activeId === id) {
      // Prefer the neighbour that took this session's slot, else the last one.
      this.#activeId =
        this.#sessionOrder[Math.min(index, this.#sessionOrder.length - 1)];
      this.#onActiveChanged();
      return;
    }
    this.#broadcastWorkspace();
    this.#changed.fire();
  }

  // -------------------------------------------------------------------------
  // Webview surfaces
  // -------------------------------------------------------------------------

  /** A surface that always shows the active session (the sidebar view). */
  sidebar(): ChatSurface {
    return this.#makeSurface(undefined);
  }

  /** A surface pinned to one session (an editor panel). */
  surface(sessionId: string): ChatSurface {
    return this.#makeSurface(sessionId);
  }

  #makeSurface(pinned: string | undefined): ChatSurface {
    const bound: BoundSurface = { pinned, listener: () => {} };
    return {
      subscribe: (listener) => {
        bound.listener = listener;
        this.#surfaces.add(bound);
        return new vscode.Disposable(() => this.#surfaces.delete(bound));
      },
      handleWebviewMessage: (message) => this.#route(bound, message),
    };
  }

  /** The session a surface is currently showing. */
  #sessionFor(surface: BoundSurface): ManagedSession | undefined {
    const id = surface.pinned ?? this.#activeId;
    return id === undefined ? undefined : this.#sessions.get(id);
  }

  async #route(
    surface: BoundSurface,
    message: WebviewMessage,
  ): Promise<void> {
    // Roster-level messages are the manager's own; everything else belongs to
    // the session this surface shows.
    switch (message.type) {
      case "selectSession":
        this.selectSession(message.id);
        return;
      case "newSession":
        this.newSession(
          message.projectId ?? this.#sessionFor(surface)?.entry.projectId,
        );
        return;
      case "closeSession":
        this.closeSession(message.id);
        return;
      case "addProjectFolder":
        await this.addFolder();
        return;
      case "removeProjectFolder":
        this.removeProject(message.projectId);
        return;
      default:
        break;
    }

    const session = this.#sessionFor(surface);
    if (!session) return;
    if (message.type === "ready") {
      // The roster is not part of the controller's snapshot, so push it too.
      surface.listener(this.#workspaceMessage(surface));
      for (const other of this.#sessions.values()) {
        surface.listener({ type: "sessionStatus", ...other.status });
      }
    }
    await session.controller.handleWebviewMessage(message);
  }

  /** Notify every session's webviews of a UI-config change. */
  notifyAllConfigChanged(): void {
    for (const session of this.#sessions.values()) {
      session.controller.notifyConfigChanged();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A controller published a host message; fan it out to its surfaces. */
  #forwardFromController(id: string, message: HostMessage): void {
    const session = this.#sessions.get(id);
    if (!session) return;

    const renamed = this.#trackName(session, message);
    if (this.#trackStatus(session, message)) {
      this.#broadcast({ type: "sessionStatus", ...session.status });
    }
    if (renamed) {
      this.#broadcastWorkspace();
      this.#changed.fire();
    }

    for (const surface of this.#surfaces) {
      if (this.#sessionFor(surface) === session) surface.listener(message);
    }
  }

  /** Keep the switcher's session label in step with the agent's title. */
  #trackName(session: ManagedSession, message: HostMessage): boolean {
    const name =
      message.type === "snapshot"
        ? message.snapshot.session.sessionName
        : message.type === "session"
          ? message.session.sessionName
          : undefined;
    if (name === undefined || name === session.entry.name) return false;
    session.entry = { ...session.entry, name };
    return true;
  }

  /** Update a session's compact status from a host message. */
  #trackStatus(session: ManagedSession, message: HostMessage): boolean {
    const before = session.status;
    let isStreaming = before.isStreaming;
    let hasPendingDialog = before.hasPendingDialog;

    switch (message.type) {
      case "snapshot":
        session.dialogCount = message.snapshot.dialogs.length;
        isStreaming = message.snapshot.session.isStreaming;
        hasPendingDialog = session.dialogCount > 0;
        break;
      case "session":
        isStreaming = message.session.isStreaming;
        break;
      case "dialogOpen":
        session.dialogCount += 1;
        hasPendingDialog = true;
        break;
      case "dialogClose":
        session.dialogCount = Math.max(0, session.dialogCount - 1);
        hasPendingDialog = session.dialogCount > 0;
        break;
      default:
        return false;
    }

    if (
      isStreaming === before.isStreaming &&
      hasPendingDialog === before.hasPendingDialog
    ) {
      return false;
    }
    session.status = { id: session.entry.id, isStreaming, hasPendingDialog };
    return true;
  }

  /** The active session changed: re-hydrate every following surface. */
  #onActiveChanged(): void {
    const active = this.#sessions.get(this.#activeId ?? "");
    for (const surface of this.#surfaces) {
      surface.listener(this.#workspaceMessage(surface));
      if (surface.pinned !== undefined || !active) continue;
      surface.listener({
        type: "snapshot",
        snapshot: active.controller.snapshot(),
        draft: active.controller.draft,
      });
    }
    this.#changed.fire();
  }

  #workspaceMessage(surface: BoundSurface): HostMessage {
    return {
      type: "workspace",
      projects: this.projects(),
      sessions: this.sessions(),
      activeSessionId: surface.pinned ?? this.#activeId,
    };
  }

  #broadcast(message: HostMessage): void {
    for (const surface of this.#surfaces) surface.listener(message);
  }

  #broadcastWorkspace(): void {
    for (const surface of this.#surfaces) {
      surface.listener(this.#workspaceMessage(surface));
    }
  }

  /** Read the project's current git branch (if any) and update its entry. */
  async #refreshBranch(id: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) return;
    const branch = await readGitBranch(project.cwd);
    if (!branch || this.#disposed || !this.#projects.has(id)) return;
    this.#projects.set(id, { ...project, branch });
    this.#broadcastWorkspace();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#surfaces.clear();
    this.#changed.dispose();
    for (const session of this.#sessions.values()) {
      session.subscription.dispose();
      session.controller.dispose();
    }
    this.#sessions.clear();
    this.#sessionOrder.length = 0;
    this.#projects.clear();
    this.#projectOrder.length = 0;
  }
}

/**
 * Best-effort read of the current git branch for a working tree, without
 * shelling out to `git`. Handles both a normal `.git` directory and a
 * worktree's `.git` file (which points at the real gitdir). Returns the branch
 * name, a short SHA when in detached HEAD, or undefined when not a git tree.
 */
async function readGitBranch(cwd: string): Promise<string | undefined> {
  const gitPath = path.join(cwd, ".git");
  let isDir: boolean;
  try {
    const info = await stat(gitPath);
    isDir = info.isDirectory();
  } catch {
    return undefined;
  }
  let headPath: string;
  if (isDir) {
    headPath = path.join(gitPath, "HEAD");
  } else {
    // Worktree: .git is a file pointing to the real gitdir.
    let content: string;
    try {
      content = await readFile(gitPath, "utf8");
    } catch {
      return undefined;
    }
    const match = /gitdir:\s*(.+)/.exec(content);
    if (!match) return undefined;
    const gitdir = match[1];
    if (!gitdir) return undefined;
    headPath = path.join(gitdir.trim(), "HEAD");
  }
  try {
    const head = await readFile(headPath, "utf8");
    const refMatch = /ref:\s*refs\/heads\/(.+)/.exec(head);
    const refName = refMatch?.[1];
    if (refName) return refName.trim();
    const sha = head.trim();
    return sha.length > 8 ? sha.slice(0, 8) : sha;
  } catch {
    return undefined;
  }
}
