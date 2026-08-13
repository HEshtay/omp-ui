import { useCallback, useSyncExternalStore } from "react";
import type {
	CheckpointEntry,
	DraftState,
	HostMessage,
	ProjectEntry,
	SessionEntry,
	SessionListEntry,
	SessionSnapshot,
	SessionStatus,
	UiConfig,
	UiDialog,
} from "../../src/shared/bridge";
import { applyEvent, createChatState } from "../../src/shared/chat-model";
import type { ChatState, SubagentState } from "../../src/shared/chat-model";
import type { Model, SlashCommand } from "../../src/shared/protocol";

export interface Toast {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
}

export interface UiState {
	chat: ChatState;
	session: SessionSnapshot;
	commands: SlashCommand[];
	models: Model[];
	dialogs: UiDialog[];
	subagents: SubagentState[];
	config: UiConfig;
	/** Saved sessions on disk, for the resume menu. */
	savedSessions: SessionListEntry[];
	branchPoints: Array<{ entryId: string; text: string }>;
	/**
	 * Revertable workspace snapshots, keyed for lookup by the transcript id of
	 * the user message each one precedes.
	 */
	checkpointsByItem: Record<string, CheckpointEntry>;
	toasts: Toast[];
	/** Output emitted by local-only slash commands, newest last. */
	commandOutput: string[];
	draft: DraftState;
	/** Set once the host has delivered its first snapshot. */
	hydrated: boolean;
	/** Registered projects sessions can run in. */
	projects: ProjectEntry[];
	/** Live sessions across every project — one agent process each. */
	sessions: SessionEntry[];
	/** The session this webview shows: the switcher marks it active. */
	activeSessionId: string | undefined;
	/** Live per-session badges, keyed by session id. */
	sessionStatuses: Record<string, SessionStatus>;
}

const INITIAL_SESSION: SessionSnapshot = {
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
	cwd: "",
	workspaceName: "",
};

function initialState(): UiState {
	return {
		chat: createChatState(),
		session: INITIAL_SESSION,
		commands: [],
		models: [],
		dialogs: [],
		subagents: [],
		config: { showThinking: true, autoScroll: true, sendKeybinding: "enter" },
		savedSessions: [],
		branchPoints: [],
		checkpointsByItem: {},
		toasts: [],
		commandOutput: [],
		draft: { text: "", images: [] },
		hydrated: false,
		projects: [],
		sessions: [],
		activeSessionId: undefined,
		sessionStatuses: {},
	};
}

/**
 * Mirror of the host's conversation state.
 *
 * The host is authoritative and re-sends a full snapshot whenever this webview
 * (re)attaches; between snapshots the same reducer folds forwarded events so
 * streaming stays incremental instead of re-serializing the transcript.
 */
class UiStore {
	#state: UiState = initialState();
	#listeners = new Set<() => void>();
	#nextToastId = 0;

	get state(): UiState {
		return this.#state;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	#set(next: UiState): void {
		if (next === this.#state) return;
		this.#state = next;
		for (const listener of this.#listeners) listener();
	}

	/** Local-only mutation for composer text the host has not seen yet. */
	setDraft(draft: DraftState): void {
		this.#set({ ...this.#state, draft });
	}

	dismissToast(id: number): void {
		this.#set({ ...this.#state, toasts: this.#state.toasts.filter(toast => toast.id !== id) });
	}

	clearCommandOutput(): void {
		if (this.#state.commandOutput.length === 0) return;
		this.#set({ ...this.#state, commandOutput: [] });
	}

	apply(message: HostMessage): void {
		const state = this.#state;
		switch (message.type) {
			case "snapshot":
				this.#set({
					...state,
					chat: message.snapshot.chat,
					session: message.snapshot.session,
					commands: message.snapshot.commands,
					models: message.snapshot.models,
					dialogs: message.snapshot.dialogs,
					subagents: message.snapshot.subagents,
					config: message.snapshot.config,
					checkpointsByItem: indexCheckpoints(message.snapshot.checkpoints),
					draft: message.draft,
					hydrated: true,
				});
				return;

			case "events": {
				let chat = state.chat;
				for (const event of message.events) chat = applyEvent(chat, event);
				if (chat === state.chat) return;
				this.#set({ ...state, chat });
				return;
			}

			case "session":
				this.#set({ ...state, session: message.session });
				return;

			case "commands":
				this.#set({ ...state, commands: message.commands });
				return;

			case "models":
				this.#set({ ...state, models: message.models });
				return;

			case "todos":
				this.#set({ ...state, chat: { ...state.chat, todoPhases: message.phases } });
				return;

			case "checkpoints":
				this.#set({ ...state, checkpointsByItem: indexCheckpoints(message.checkpoints) });
				return;

			case "subagents":
				this.#set({ ...state, subagents: message.subagents });
				return;

			case "dialogOpen":
				this.#set({
					...state,
					dialogs: [...state.dialogs.filter(dialog => dialog.id !== message.dialog.id), message.dialog],
				});
				return;

			case "dialogClose":
				this.#set({ ...state, dialogs: state.dialogs.filter(dialog => dialog.id !== message.id) });
				return;

			case "config":
				this.#set({ ...state, config: message.config });
				return;

			case "notify":
				this.#set({
					...state,
					toasts: [...state.toasts, { id: ++this.#nextToastId, level: message.level, message: message.message }],
				});
				return;

			case "commandOutput":
				this.#set({ ...state, commandOutput: [...state.commandOutput, message.text] });
				return;

			case "setComposerText":
				this.#set({ ...state, draft: { ...state.draft, text: message.text } });
				return;

			case "appendComposerText":
				this.#set({
					...state,
					draft: {
						...state.draft,
						text: state.draft.text ? `${state.draft.text}\n${message.text}` : message.text,
					},
				});
				return;

			case "savedSessions":
				this.#set({ ...state, savedSessions: message.sessions });
				return;

			case "branchPoints":
				this.#set({ ...state, branchPoints: message.messages });
				return;

			case "workspace":
				this.#set({
					...state,
					projects: message.projects,
					sessions: message.sessions,
					activeSessionId: message.activeSessionId,
				});
				return;

			case "sessionStatus": {
				const sessionStatuses = {
					...state.sessionStatuses,
					[message.id]: {
						id: message.id,
						isStreaming: message.isStreaming,
						hasPendingDialog: message.hasPendingDialog,
					},
				};
				this.#set({ ...state, sessionStatuses });
				return;
			}

			case "focusComposer":
				focusComposer();
				return;
		}
	}
}

/**
 * A snapshot only becomes offerable once the host has bound it to a transcript
 * item, so unbound entries are dropped rather than rendered against nothing.
 */
function indexCheckpoints(checkpoints: readonly CheckpointEntry[]): Record<string, CheckpointEntry> {
	const byItem: Record<string, CheckpointEntry> = {};
	for (const checkpoint of checkpoints) {
		if (checkpoint.itemId !== undefined) byItem[checkpoint.itemId] = checkpoint;
	}
	return byItem;
}

export const store = new UiStore();

/** Imperative focus hop: the composer registers itself here on mount. */
let composerFocus: (() => void) | undefined;

export function registerComposerFocus(focus: (() => void) | undefined): void {
	composerFocus = focus;
}

export function focusComposer(): void {
	composerFocus?.();
}

export function useUi<T>(selector: (state: UiState) => T): T {
	const getSnapshot = useCallback(() => selector(store.state), [selector]);
	return useSyncExternalStore(store.subscribe, getSnapshot);
}

export function useUiState(): UiState {
	return useSyncExternalStore(store.subscribe, () => store.state);
}
