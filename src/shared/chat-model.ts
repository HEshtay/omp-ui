/**
 * The UI-facing conversation model, and the pure reducer that folds agent
 * session events into it.
 *
 * Shared verbatim by the extension host and the webview: the host keeps an
 * authoritative copy so a disposed/restored webview can be re-hydrated without
 * replaying the whole session, and the webview runs the same reducer on the
 * forwarded event stream so streaming stays incremental.
 */

import type {
	AgentMessage,
	AgentSessionEvent,
	AgentToolResult,
	AssistantContent,
	AssistantMessage,
	ImageContent,
	StopReason,
	TextContent,
	TodoItem,
	TodoPhase,
	ToolCallContent,
	Usage,
} from "./protocol";

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type ToolCallStatus = "pending" | "running" | "success" | "error" | "skipped";

export interface ToolCallState {
	toolCallId: string;
	name: string;
	args?: Record<string, unknown>;
	/** Raw JSON fragment accumulated while the arguments are still streaming. */
	partialArgs?: string;
	intent?: string;
	status: ToolCallStatus;
	result?: AgentToolResult;
	/** Live partial result; replaced wholesale on every update, never appended. */
	partialResult?: AgentToolResult;
	startedAt?: number;
	endedAt?: number;
}

export interface UserItem {
	kind: "user";
	id: string;
	text: string;
	images: ImageContent[];
	timestamp: number;
}

export interface AssistantItem {
	kind: "assistant";
	id: string;
	content: AssistantContent[];
	model?: string;
	provider?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	streaming: boolean;
	timestamp: number;
	durationMs?: number;
}

export interface ShellItem {
	kind: "shell";
	id: string;
	language: "bash" | "python";
	source: string;
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
	timestamp: number;
}

export interface CustomItem {
	kind: "custom";
	id: string;
	customType: string;
	text: string;
	timestamp: number;
}

export interface FileMentionItem {
	kind: "fileMention";
	id: string;
	files: Array<{ path: string; lineCount?: number; byteSize?: number; skippedReason?: string }>;
	timestamp: number;
}

export interface SummaryItem {
	kind: "summary";
	id: string;
	label: string;
	text: string;
	timestamp: number;
}

export interface NoticeItem {
	kind: "notice";
	id: string;
	level: "info" | "warning" | "error";
	text: string;
	source?: string;
	timestamp: number;
}

export type ChatItem =
	| UserItem
	| AssistantItem
	| ShellItem
	| CustomItem
	| FileMentionItem
	| SummaryItem
	| NoticeItem;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface RetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

export interface CompactionState {
	reason: string;
	action: string;
}

export interface SubagentState {
	id: string;
	index: number;
	agent: string;
	description?: string;
	task?: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	parentToolCallId?: string;
	sessionFile?: string;
	toolCount?: number;
	tokens?: number;
	contextTokens?: number;
	contextWindow?: number;
	cost?: number;
	durationMs?: number;
	currentTool?: string;
	lastIntent?: string;
	resolvedModel?: string;
	lastUpdate: number;
}

export interface ChatState {
	items: ChatItem[];
	toolCalls: Record<string, ToolCallState>;
	/** Timeline id of the message currently being streamed, if any. */
	activeItemId: string | null;
	running: boolean;
	compaction: CompactionState | null;
	retry: RetryState | null;
	todoPhases: TodoPhase[];
	subagents: Record<string, SubagentState>;
	/** Monotonic id source; also doubles as a cheap change token. */
	seq: number;
}

export function createChatState(): ChatState {
	return {
		items: [],
		toolCalls: {},
		activeItemId: null,
		running: false,
		compaction: null,
		retry: null,
		todoPhases: [],
		subagents: {},
		seq: 0,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten `string | Block[]` message content into plain text. */
export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block && typeof block === "object" && (block as TextContent).type === "text") {
			text += (block as TextContent).text;
		}
	}
	return text;
}

function contentToImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is ImageContent =>
			!!block && typeof block === "object" && (block as ImageContent).type === "image",
	);
}

/**
 * A steering interrupt cancels queued tool calls by synthesizing a result. It
 * must read as neutral, not as a failure.
 */
function isBenignSkip(result: AgentToolResult | undefined): boolean {
	const details = result?.details as
		| { __synthetic?: boolean; __interrupted?: boolean; source?: string; execution?: string }
		| undefined;
	if (!details || details.source !== "interrupt_skipped") return false;
	return details.__synthetic === true || (details.__interrupted === true && details.execution === "started");
}

export function toolCallsIn(item: AssistantItem): ToolCallContent[] {
	return item.content.filter((block): block is ToolCallContent => block.type === "toolCall");
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function nextId(state: ChatState, prefix: string): [string, number] {
	const seq = state.seq + 1;
	return [`${prefix}-${seq}`, seq];
}

function replaceItem(items: ChatItem[], id: string, next: ChatItem): ChatItem[] {
	const index = items.findIndex(item => item.id === id);
	if (index < 0) return [...items, next];
	const copy = items.slice();
	copy[index] = next;
	return copy;
}

/** Build the timeline item for a settled or in-flight message. */
function itemFromMessage(message: AgentMessage, id: string, streaming: boolean): ChatItem | null {
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
	switch (message.role) {
		case "user":
		case "developer": {
			// Steering messages are queue plumbing, and synthetic ones are
			// harness-injected continuations; neither is something the user wrote.
			if (message.role === "user" && (message.steering || message.synthetic)) return null;
			const text = contentToText(message.content);
			const images = contentToImages(message.content);
			if (!text && images.length === 0) return null;
			return { kind: "user", id, text, images, timestamp };
		}
		case "assistant":
			return {
				kind: "assistant",
				id,
				content: Array.isArray(message.content) ? message.content : [],
				model: message.model,
				provider: message.provider,
				usage: message.usage,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				streaming,
				timestamp,
				durationMs: message.duration,
			};
		case "bashExecution":
			return {
				kind: "shell",
				id,
				language: "bash",
				source: message.command,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				timestamp,
			};
		case "pythonExecution":
			return {
				kind: "shell",
				id,
				language: "python",
				source: message.code,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				timestamp,
			};
		case "custom":
		case "hookMessage": {
			if (!message.display) return null;
			return { kind: "custom", id, customType: message.customType, text: contentToText(message.content), timestamp };
		}
		case "fileMention":
			return {
				kind: "fileMention",
				id,
				files: message.files.map(file => ({
					path: file.path,
					lineCount: file.lineCount,
					byteSize: file.byteSize,
					skippedReason: file.skippedReason,
				})),
				timestamp,
			};
		case "branchSummary":
		case "compactionSummary":
			return {
				kind: "summary",
				id,
				label: message.role === "branchSummary" ? "Branch summary" : "Compacted",
				text: message.shortSummary ?? message.summary ?? contentToText(message.content),
				timestamp,
			};
		// Tool results fold into their originating tool-call card instead of
		// occupying a timeline slot of their own.
		case "toolResult":
			return null;
	}
}

function applyToolResultMessage(state: ChatState, message: AgentMessage): ChatState {
	if (message.role !== "toolResult") return state;
	const existing = state.toolCalls[message.toolCallId];
	const result: AgentToolResult = {
		content: message.content,
		details: message.details,
		isError: message.isError,
		useless: message.useless,
	};
	const status: ToolCallStatus = isBenignSkip(result) ? "skipped" : message.isError ? "error" : "success";
	return {
		...state,
		toolCalls: {
			...state.toolCalls,
			[message.toolCallId]: {
				toolCallId: message.toolCallId,
				name: message.toolName,
				args: existing?.args,
				intent: existing?.intent,
				startedAt: existing?.startedAt,
				status,
				result,
				endedAt: message.timestamp,
			},
		},
	};
}

/**
 * Fold one agent session event into the conversation.
 *
 * Returns the same reference when nothing changed so React subscribers can
 * bail out cheaply.
 */
export function applyEvent(state: ChatState, event: AgentSessionEvent): ChatState {
	switch (event.type) {
		case "agent_start":
			return state.running ? state : { ...state, running: true, retry: null };

		case "agent_end":
			// The session re-arms itself for maintenance and async delivery, so a
			// run is only actually over when it settles terminally.
			if (event.isTerminal === false) return state;
			return { ...state, running: false, activeItemId: null, retry: null };

		case "message_start": {
			if (event.message.role === "toolResult") return applyToolResultMessage(state, event.message);
			const [id, seq] = nextId(state, "msg");
			const item = itemFromMessage(event.message, id, event.message.role === "assistant");
			if (!item) return { ...state, seq };
			return { ...state, seq, items: [...state.items, item], activeItemId: id };
		}

		case "message_update": {
			// `event.message` is already a fully-accumulated snapshot, so the
			// content array replaces wholesale rather than being reduced.
			const id = state.activeItemId;
			if (!id) {
				const [newId, seq] = nextId(state, "msg");
				const item = itemFromMessage(event.message, newId, true);
				if (!item) return { ...state, seq };
				return { ...state, seq, items: [...state.items, item], activeItemId: newId };
			}
			const existing = state.items.find(candidate => candidate.id === id);
			if (!existing || existing.kind !== "assistant") return state;
			const next: AssistantItem = {
				...existing,
				content: Array.isArray(event.message.content) ? event.message.content : existing.content,
				model: event.message.model ?? existing.model,
				provider: event.message.provider ?? existing.provider,
				usage: event.message.usage ?? existing.usage,
				streaming: true,
			};
			return { ...state, items: replaceItem(state.items, id, next) };
		}

		case "message_end": {
			if (event.message.role === "toolResult") {
				const settled = applyToolResultMessage(state, event.message);
				return settled === state ? state : { ...settled, activeItemId: null };
			}
			const id = state.activeItemId;
			if (id) {
				const item = itemFromMessage(event.message, id, false);
				if (!item) {
					return { ...state, items: state.items.filter(candidate => candidate.id !== id), activeItemId: null };
				}
				return { ...state, items: replaceItem(state.items, id, item), activeItemId: null };
			}
			const [newId, seq] = nextId(state, "msg");
			const item = itemFromMessage(event.message, newId, false);
			if (!item) return { ...state, seq };
			return { ...state, seq, items: [...state.items, item], activeItemId: null };
		}

		case "tool_execution_start": {
			const existing = state.toolCalls[event.toolCallId];
			return {
				...state,
				toolCalls: {
					...state.toolCalls,
					[event.toolCallId]: {
						...existing,
						toolCallId: event.toolCallId,
						name: event.toolName,
						args: (event.args as Record<string, unknown> | undefined) ?? existing?.args,
						intent: event.intent ?? existing?.intent,
						status: "running",
						startedAt: Date.now(),
					},
				},
			};
		}

		case "tool_execution_update": {
			const existing = state.toolCalls[event.toolCallId];
			return {
				...state,
				toolCalls: {
					...state.toolCalls,
					[event.toolCallId]: {
						...existing,
						toolCallId: event.toolCallId,
						name: event.toolName,
						args: (event.args as Record<string, unknown> | undefined) ?? existing?.args,
						status: "running",
						partialResult: event.partialResult,
					},
				},
			};
		}

		case "tool_execution_end": {
			const existing = state.toolCalls[event.toolCallId];
			const isError = event.isError ?? event.result?.isError ?? false;
			const status: ToolCallStatus = isBenignSkip(event.result) ? "skipped" : isError ? "error" : "success";
			return {
				...state,
				toolCalls: {
					...state.toolCalls,
					[event.toolCallId]: {
						...existing,
						toolCallId: event.toolCallId,
						name: event.toolName,
						status,
						result: event.result,
						partialResult: undefined,
						endedAt: Date.now(),
					},
				},
			};
		}

		case "auto_compaction_start":
			return { ...state, compaction: { reason: event.reason, action: event.action } };

		case "auto_compaction_end":
			return { ...state, compaction: null };

		case "auto_retry_start":
			return {
				...state,
				retry: {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				},
			};

		case "auto_retry_end":
			return { ...state, retry: null };

		case "notice": {
			const [id, seq] = nextId(state, "notice");
			const item: NoticeItem = {
				kind: "notice",
				id,
				level: event.level,
				text: event.message,
				source: event.source,
				timestamp: Date.now(),
			};
			return { ...state, seq, items: [...state.items, item] };
		}

		case "retry_fallback_applied": {
			const [id, seq] = nextId(state, "notice");
			const item: NoticeItem = {
				kind: "notice",
				id,
				level: "warning",
				text: `Retrying on ${event.to} after ${event.from} failed (${event.role}).`,
				timestamp: Date.now(),
			};
			return { ...state, seq, items: [...state.items, item] };
		}

		case "todo_auto_clear":
			return { ...state, todoPhases: [] };

		case "todo_reminder":
			return state;

		default:
			return state;
	}
}

/** Rebuild the whole conversation from a persisted message list. */
export function applyMessages(state: ChatState, messages: AgentMessage[]): ChatState {
	let next: ChatState = { ...state, items: [], toolCalls: {}, activeItemId: null };
	for (const message of messages) {
		// Tool calls are recovered from the assistant blocks that carry them, so
		// a result arriving before its call still lands on a populated card.
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				next.toolCalls[block.id] = {
					toolCallId: block.id,
					name: block.name,
					args: block.arguments,
					intent: block.intent,
					status: "pending",
				};
			}
		}
		next = applyEvent(next, { type: "message_end", message });
	}
	return next;
}

/** Latest todo snapshot the agent published through a `todo` tool call. */
export function todosFromToolCall(result: AgentToolResult | undefined): TodoPhase[] | null {
	const details = result?.details as { phases?: unknown } | undefined;
	if (!details || !Array.isArray(details.phases)) return null;
	const phases: TodoPhase[] = [];
	for (const raw of details.phases) {
		if (!raw || typeof raw !== "object") continue;
		const phase = raw as { name?: unknown; tasks?: unknown };
		if (typeof phase.name !== "string" || !Array.isArray(phase.tasks)) continue;
		const tasks: TodoItem[] = [];
		for (const rawTask of phase.tasks) {
			if (!rawTask || typeof rawTask !== "object") continue;
			const task = rawTask as { content?: unknown; status?: unknown; blocker?: unknown };
			if (typeof task.content !== "string" || typeof task.status !== "string") continue;
			tasks.push({
				content: task.content,
				status: task.status as TodoItem["status"],
				blocker: typeof task.blocker === "string" ? task.blocker : undefined,
			});
		}
		phases.push({ name: phase.name, tasks });
	}
	return phases;
}

/** Assistant messages carry the model that produced them; the last one wins. */
export function lastAssistant(state: ChatState): AssistantItem | undefined {
	for (let index = state.items.length - 1; index >= 0; index--) {
		const item = state.items[index];
		if (item?.kind === "assistant") return item;
	}
	return undefined;
}

export type { AssistantMessage };
