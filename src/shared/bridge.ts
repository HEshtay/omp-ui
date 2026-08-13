/**
 * Message protocol between the extension host and the chat webview.
 *
 * The host owns the agent process and the authoritative conversation state;
 * the webview is a renderer that replays a snapshot on attach and then folds
 * forwarded events with the same reducer. Nothing here touches the RPC wire
 * directly — the host translates.
 */

import type { ChatState, SubagentState } from "./chat-model";
import type {
	AgentSessionEvent,
	ContextUsage,
	ImageContent,
	Model,
	QueueMode,
	SessionStats,
	SlashCommand,
	ThinkingLevel,
	TodoPhase,
} from "./protocol";

// ---------------------------------------------------------------------------
// Shared view models
// ---------------------------------------------------------------------------

export type AgentStatus =
  | "starting"
  | "ready"
  | "restarting"
  | "exited"
  | "error";

export interface SessionSnapshot {
  agentStatus: AgentStatus;
  /** Populated when `agentStatus` is `error` or `exited`. */
  statusDetail?: string;
  sessionId?: string;
  sessionName?: string;
  sessionFile?: string;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  fastModeEnabled: boolean;
  fastModeActive: boolean;
  autoCompactionEnabled: boolean;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  tokensPerSecond: number | null;
  queuedMessageCount: number;
  contextUsage?: ContextUsage;
  stats?: SessionStats;
  cwd: string;
  workspaceName: string;
}

/** A blocking `extension_ui_request` awaiting the user. */
export interface UiDialog {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  promptStyle?: boolean;
  timeout?: number;
  /** Set when this `select` is the tool-approval gate rather than a plain question. */
  approval?: { toolName: string; reason?: string; detail: string };
  createdAt: number;
}

export type DialogAnswer =
  | { kind: "value"; value: string }
  | { kind: "confirmed"; confirmed: boolean }
  | { kind: "cancelled" };

export interface SessionListEntry {
  path: string;
  id: string;
  name: string;
  firstMessage: string;
  modified: number;
  created: number;
  messageCount: number;
  size: number;
  status:
    | "complete"
    | "interrupted"
    | "aborted"
    | "error"
    | "pending"
    | "unknown";
  current: boolean;
}

/**
 * A registered project/worktree sessions can run in.
 *
 * A project is just a `cwd` plus display metadata; it owns no agent process.
 * The id is the resolved folder path, so registration survives reloads.
 */
export interface ProjectEntry {
  id: string;
  cwd: string;
  label: string;
  branch?: string;
}

/**
 * A live session: one `ChatController`, and therefore one
 * `omp --mode rpc-ui` child process, running in its project's `cwd`.
 *
 * Several sessions can share a project, so ids are minted by the host rather
 * than derived from the path. `ordinal` is the mint counter, used as a stable
 * fallback label until the agent reports a session name.
 */
export interface SessionEntry {
  id: string;
  projectId: string;
  /** The project's label, denormalised so the switcher needs no lookup. */
  projectLabel: string;
  ordinal: number;
  name?: string;
}

/** Compact live status of a session, forwarded to the switcher for badges. */
export interface SessionStatus {
  id: string;
  isStreaming: boolean;
  /** A blocking approval/input dialog is awaiting the user. */
  hasPendingDialog: boolean;
}

/**
 * A workspace snapshot taken immediately before a turn, offered back as a
 * revert target.
 *
 * omp's own `checkpoint`/`rewind` tools move the conversation pointer and
 * deliberately leave the filesystem alone, so a file-level undo can only exist
 * out here. `itemId` binds the snapshot to the user message it precedes, which
 * the host resolves by turn ordinal once the reducer has minted that item.
 */
export interface CheckpointEntry {
  /** Commit sha of the snapshot tree. */
  id: string;
  itemId?: string;
  createdAt: number;
  /** Clipped first line of the prompt that followed. */
  label: string;
}

export interface UiConfig {
  showThinking: boolean;
  autoScroll: boolean;
  sendKeybinding: "enter" | "ctrl+enter";
}

export interface UiSnapshot {
  chat: ChatState;
  session: SessionSnapshot;
  commands: SlashCommand[];
  models: Model[];
  dialogs: UiDialog[];
  subagents: SubagentState[];
  config: UiConfig;
  checkpoints: CheckpointEntry[];
}

/** Composer text the user is drafting, persisted across webview disposal. */
export interface DraftState {
  text: string;
  images: ImageContent[];
}

// ---------------------------------------------------------------------------
// Host -> webview
// ---------------------------------------------------------------------------

export type HostMessage =
  | { type: "snapshot"; snapshot: UiSnapshot; draft: DraftState }
  | { type: "events"; events: AgentSessionEvent[] }
  | { type: "session"; session: SessionSnapshot }
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "models"; models: Model[] }
  | { type: "todos"; phases: TodoPhase[] }
  | { type: "subagents"; subagents: SubagentState[] }
  | { type: "dialogOpen"; dialog: UiDialog }
  | { type: "dialogClose"; id: string }
  | { type: "config"; config: UiConfig }
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  | { type: "commandOutput"; text: string }
  | { type: "setComposerText"; text: string }
  | { type: "appendComposerText"; text: string }
  /** The project's saved sessions on disk, for the resume menu. */
  | { type: "savedSessions"; sessions: SessionListEntry[] }
  | { type: "branchPoints"; messages: Array<{ entryId: string; text: string }> }
  | { type: "checkpoints"; checkpoints: CheckpointEntry[] }
  | {
      type: "workspace";
      projects: ProjectEntry[];
      sessions: SessionEntry[];
      /** The session this webview is showing. */
      activeSessionId?: string;
    }
  | {
      type: "sessionStatus";
      id: string;
      isStreaming: boolean;
      hasPendingDialog: boolean;
    }
  | { type: "focusComposer" };

// ---------------------------------------------------------------------------
// Webview -> host
// ---------------------------------------------------------------------------

export type WebviewMessage =
  | { type: "ready" }
  | {
      type: "submit";
      text: string;
      images: ImageContent[];
      behavior?: "steer" | "followUp";
    }
  | { type: "abort" }
  | { type: "dialogAnswer"; id: string; answer: DialogAnswer }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: ThinkingLevel }
  | { type: "setFastMode"; enabled: boolean }
  | { type: "setAutoCompaction"; enabled: boolean }
  | { type: "setSteeringMode"; mode: QueueMode }
  | { type: "setTodos"; phases: TodoPhase[] }
  | { type: "compact" }
  /** Start a fresh conversation inside the *current* agent process. */
  | { type: "resetSession" }
  /** Spawn an additional session (own agent process) in a project. */
  | { type: "newSession"; projectId?: string }
  /** Terminate a session's agent and drop it from the switcher. */
  | { type: "closeSession"; id: string }
  | { type: "requestSessions" }
  | { type: "switchSession"; path: string }
  | { type: "selectSession"; id: string }
  | { type: "addProjectFolder" }
  /** Drop a project from the roster, terminating every session it owns. */
  | { type: "removeProjectFolder"; projectId: string }
  | { type: "setSessionName"; name: string }
  | { type: "requestBranchPoints" }
  | { type: "branch"; entryId: string }
  /** Restore the working tree to the snapshot taken before a given turn. */
  | { type: "revertCheckpoint"; id: string }
  | { type: "exportHtml" }
  | { type: "restartAgent" }
  | { type: "refreshState" }
  | { type: "saveDraft"; draft: DraftState }
  | { type: "openFile"; path: string; line?: number; column?: number }
  | {
      type: "openDiff";
      title: string;
      oldText: string;
      newText: string;
      path?: string;
    }
  | { type: "openExternal"; url: string }
  | { type: "openArtifact"; url: string }
  /**
   * Open a mermaid diagram full size in an editor tab. `svg` is the webview's
   * own render (empty when it failed), `background` the colour behind it.
   */
  | { type: "openDiagram"; source: string; svg: string; background: string }
  | { type: "copyText"; text: string }
  | { type: "revealSubagent"; sessionFile: string }
  | { type: "pickImages" }
  | { type: "showLog" }
  | { type: "loginProvider" };
