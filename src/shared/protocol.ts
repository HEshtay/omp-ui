/**
 * omp RPC wire contract.
 *
 * Hand-maintained mirror of the shapes `omp --mode rpc-ui` puts on the wire:
 * - commands/responses/frames: `pi-coding-agent/src/modes/rpc/rpc-types.ts`
 * - session events: `pi-coding-agent/src/session/agent-session-events.ts`
 * - core agent events: `pi-agent-core/src/types.ts`
 * - messages and content blocks: `pi-ai/src/types.ts`
 *
 * Kept as a copy rather than a dependency so the extension builds without the
 * agent package installed and the webview bundle stays free of Node imports.
 * Payloads this UI forwards without interpreting stay `unknown`.
 */

export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

/** `off`/`inherit` plus the `Effort` ladder. */
export type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type QueueMode = "all" | "one-at-a-time";
export type InterruptMode = "immediate" | "wait";
export type SubagentSubscriptionLevel = "off" | "progress" | "events";
export type ApprovalMode = "always-ask" | "write" | "yolo";
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface Model {
	id: string;
	name: string;
	provider: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	itemId?: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ImageContent {
	type: "image";
	/** base64, no data: prefix */
	data: string;
	mimeType: string;
	detail?: "auto" | "low" | "high" | "original";
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Harness-level intent lifted out of the arguments' `i` field. */
	intent?: string;
	customWireName?: string;
	rawBlock?: string;
	thoughtSignature?: string;
}

/** Provider-specific blocks a generic renderer skips. */
export interface OpaqueContent {
	type: "fallback" | "anthropicServerTool";
	[key: string]: unknown;
}

export type AssistantContent =
	| TextContent
	| ThinkingContent
	| RedactedThinkingContent
	| ImageContent
	| ToolCallContent
	| OpaqueContent;

export type UserContent = TextContent | ImageContent;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	contextTokens?: number;
	reasoningTokens?: number;
	premiumRequests?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface UserMessage {
	role: "user";
	content: string | UserContent[];
	synthetic?: boolean;
	/** Injected mid-turn as a steer; the TUI never renders these. */
	steering?: boolean;
	attribution?: "user" | "agent";
	timestamp: number;
}

export interface DeveloperMessage {
	role: "developer";
	content: string | UserContent[];
	attribution?: "user" | "agent";
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	api?: string;
	provider?: string;
	model?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	errorStatus?: number;
	errorId?: number;
	responseId?: string;
	timestamp: number;
	duration?: number;
	ttft?: number;
	[key: string]: unknown;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	details?: unknown;
	isError: boolean;
	useless?: boolean;
	prunedAt?: number;
	timestamp: number;
}

export interface CustomMessage {
	role: "custom" | "hookMessage";
	customType: string;
	content: string | Array<TextContent | ImageContent>;
	display: boolean;
	details?: unknown;
	timestamp: number;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	excludeFromContext?: boolean;
	timestamp: number;
}

export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	excludeFromContext?: boolean;
	timestamp: number;
}

export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;
		byteSize?: number;
		skippedReason?: "tooLarge" | "binary";
		image?: ImageContent;
	}>;
	timestamp: number;
}

export interface SummaryMessage {
	role: "branchSummary" | "compactionSummary";
	content?: string | Array<TextContent | ImageContent>;
	summary?: string;
	shortSummary?: string;
	timestamp: number;
	[key: string]: unknown;
}

export type AgentMessage =
	| UserMessage
	| DeveloperMessage
	| AssistantMessage
	| ToolResultMessage
	| CustomMessage
	| BashExecutionMessage
	| PythonExecutionMessage
	| FileMentionMessage
	| SummaryMessage;

export type AgentMessageRole = AgentMessage["role"];

// ---------------------------------------------------------------------------
// Streaming deltas (`message_update.assistantMessageEvent`)
//
// Every variant carries `partial`: a fully-accumulated immutable snapshot of
// the assistant message so far, so a client never has to reduce deltas itself.
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "image_end"; contentIndex: number; content: ImageContent; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessage }
	| { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
	| { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
	truncatedBy: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	shownRange?: { start: number; end: number };
	headRange?: { start: number; end: number };
	tailRange?: { start: number; end: number };
	elidedBytes?: number;
	elidedLines?: number;
	artifactId?: string;
	nextOffset?: number;
}

export interface OutputMeta {
	truncation?: TruncationMeta;
	source?: { type: "path" | "url" | "internal"; value: string };
	diagnostics?: { summary: string; messages: string[] };
	limits?: {
		matchLimit?: { reached: number; suggestion: number };
		resultLimit?: { reached: number; suggestion: number };
		headLimit?: { reached: number; suggestion: number };
		columnTruncated?: { maxColumn: number };
	};
}

export interface AgentToolResult {
	content: Array<TextContent | ImageContent>;
	/** Tool-specific structured payload. Untyped on the wire — narrow defensively. */
	details?: unknown;
	isError?: boolean;
	/** Result carries nothing worth retaining; safe to de-emphasize. */
	useless?: boolean;
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export interface RpcSessionState {
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	interruptMode: InterruptMode;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown }>;
	contextUsage?: ContextUsage;
}

export interface SessionStats {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

export interface SlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: string;
}

export interface LoginProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";
export type SubagentLifecycleStatus = "started" | "completed" | "failed" | "aborted";

export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: string;
	status: SubagentStatus;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput?: string[];
	toolCount: number;
	requests: number;
	/** Cumulative billing counter (input + output + cacheWrite). Not comparable to `contextWindow`. */
	tokens: number;
	/** Current turn's context size. This is the one to gauge against `contextWindow`. */
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	resolvedModel?: string;
	resolvedModelIsFallback?: boolean;
	retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAtMs: number };
}

export interface SubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource?: string;
	description?: string;
	status: SubagentStatus;
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: string;
	description?: string;
	status: SubagentLifecycleStatus;
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
	detached?: boolean;
}

export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: string;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
	detached?: boolean;
}

export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

export interface SubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: unknown[];
	messages: AgentMessage[];
}

// ---------------------------------------------------------------------------
// Commands (host -> agent, one JSON object per stdin line)
// ---------------------------------------------------------------------------

export type RpcCommand =
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_subagent_subscription"; level: SubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "set_steering_mode"; mode: QueueMode }
	| { id?: string; type: "set_follow_up_mode"; mode: QueueMode }
	| { id?: string; type: "set_interrupt_mode"; mode: InterruptMode }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string };

export type RpcCommandType = RpcCommand["type"];

/** Success `data` payload per command. Commands absent here answer with no data. */
export interface RpcResponseData {
	negotiate_protocol: { protocolVersion: 2 };
	prompt: { agentInvoked?: boolean } | undefined;
	new_session: { cancelled: boolean };
	get_state: RpcSessionState;
	set_fast_mode: { enabled: boolean; active: boolean };
	get_available_commands: { commands: SlashCommand[] };
	set_todos: { todoPhases: TodoPhase[] };
	set_subagent_subscription: { level: SubagentSubscriptionLevel };
	get_subagents: { subagents: SubagentSnapshot[] };
	get_subagent_messages: SubagentMessagesResult;
	set_model: Model;
	cycle_model: { model: Model; thinkingLevel?: ThinkingLevel; isScoped: boolean } | null;
	get_available_models: { models: Model[] };
	cycle_thinking_level: { level: ThinkingLevel } | null;
	compact: { summary: string; shortSummary?: string; tokensBefore: number };
	bash: { stdout?: string; stderr?: string; exitCode?: number };
	get_session_stats: SessionStats;
	export_html: { path: string };
	switch_session: { cancelled: boolean };
	branch: { text: string; cancelled: boolean };
	get_branch_messages: { messages: Array<{ entryId: string; text: string }> };
	get_last_assistant_text: { text: string | null };
	handoff: { savedPath?: string } | null;
	get_messages: { messages: AgentMessage[] };
	get_messages_page: { messages: AgentMessage[]; totalMessages: number; nextCursor?: string };
	get_login_providers: { providers: LoginProvider[] };
	login: { providerId: string };
}

export type RpcResponse =
	| { id?: string; type: "response"; command: string; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string; code?: string };

// ---------------------------------------------------------------------------
// Transport / side-channel frames
// ---------------------------------------------------------------------------

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: number[];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcFrameErrorFrame {
	type: "rpc_frame_error";
	originalType?: string;
	error: string;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: SlashCommand[];
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface RpcExtensionErrorFrame {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

export interface RpcCommandOutputFrame {
	type: "command_output";
	text: string;
}

export interface RpcSessionInfoUpdateFrame {
	type: "session_info_update";
	title?: string;
	sessionId?: string;
}

export interface RpcConfigUpdateFrame {
	type: "config_update";
	model?: Model;
	thinkingLevel?: ThinkingLevel;
}

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

// ---------------------------------------------------------------------------
// Extension UI sub-protocol
//
// Tool approval rides this channel too: it arrives as `select` with options
// exactly `["Approve", "Deny"]` and a multi-line `title`.
// ---------------------------------------------------------------------------

export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined | null;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			launchUrl?: string;
			instructions?: string;
	  };

export type ExtensionUIMethod = RpcExtensionUIRequest["method"];

/** The four methods that block the agent until the host answers. */
export type BlockingUIMethod = "select" | "confirm" | "input" | "editor";

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

/** Exact labels the approval prompt uses; the server compares by string equality. */
export const APPROVE_LABEL = "Approve";
export const DENY_LABEL = "Deny";
export const OTHER_OPTION_LABEL = "Other (type your own)";
export const RECOMMENDED_SUFFIX = " (Recommended)";

// ---------------------------------------------------------------------------
// Agent session events
// ---------------------------------------------------------------------------

export type AgentSessionEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages?: AgentMessage[]; messageCount?: number; isTerminal?: boolean }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults?: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AssistantMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown; intent?: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args?: unknown;
			partialResult?: AgentToolResult;
	  }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: AgentToolResult; isError?: boolean }
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
			aborted: boolean;
			willRetry: boolean;
			skipped?: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	/** Carries no payload — refresh via `get_state` or the `config_update` frame. */
	| { type: "model_changed" }
	| { type: "thinking_level_changed"; thinkingLevel?: ThinkingLevel; configured?: string; resolved?: string }
	| { type: "ttsr_triggered"; rules?: Array<{ name: string; description?: string }> }
	| { type: "todo_reminder"; todos?: TodoItem[]; attempt?: number; maxAttempts?: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "goal_updated"; goal: unknown };

export type AgentSessionEventType = AgentSessionEvent["type"];

/**
 * Exactly the `type` values that are agent session events. Every other frame on
 * stdout is a response, transport frame, or side channel. `session_shutdown` is
 * deliberately absent: it is extension-runner-only and never hits the wire, so
 * shutdown must be detected from child-process exit.
 */
const SESSION_EVENT_TYPES: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	model_changed: true,
	thinking_level_changed: true,
	ttsr_triggered: true,
	todo_reminder: true,
	todo_auto_clear: true,
	irc_message: true,
	notice: true,
	goal_updated: true,
};

export function isAgentSessionEvent(frame: { type?: unknown }): frame is AgentSessionEvent {
	return typeof frame.type === "string" && SESSION_EVENT_TYPES[frame.type] === true;
}

/** Any object the agent may write to stdout. */
export type RpcInboundFrame =
	| RpcReadyFrame
	| RpcResponse
	| RpcChunkFrame
	| RpcFrameErrorFrame
	| RpcAvailableCommandsUpdateFrame
	| RpcPromptResultFrame
	| RpcExtensionErrorFrame
	| RpcExtensionUIRequest
	| RpcSubagentFrame
	| RpcCommandOutputFrame
	| RpcSessionInfoUpdateFrame
	| RpcConfigUpdateFrame
	| AgentSessionEvent;
