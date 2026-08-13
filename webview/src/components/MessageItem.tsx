import { memo, useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type {
	AssistantItem,
	ChatItem,
	CustomItem,
	FileMentionItem,
	NoticeItem,
	ShellItem,
	SummaryItem,
	ToolCallState,
	UserItem,
} from "../../../src/shared/chat-model";
import type { AssistantContent, ImageContent, ToolCallContent } from "../../../src/shared/protocol";
import { basename, formatBytes, formatCost, formatDuration, formatNumber, stripAnsi } from "../format";
import type { UiState } from "../store";
import { useUi } from "../store";
import { post } from "../vscode";
import { Markdown } from "./Markdown";
import { Thinking } from "./Thinking";
import { ToolCard } from "./tools/ToolCard";

/**
 * Images arrive as bare base64 plus a mime type. Anything that is not a
 * plausible image mime is forced to png rather than trusted into the `src`
 * attribute, and an already-prefixed payload is passed through so a lenient
 * provider cannot produce `data:image/png;base64,data:image/...`.
 */
function imageSource(image: ImageContent): string | null {
	const data = typeof image.data === "string" ? image.data : "";
	if (data.length === 0) return null;
	if (data.startsWith("data:")) return data;
	const mime =
		typeof image.mimeType === "string" && image.mimeType.startsWith("image/") ? image.mimeType : "image/png";
	return `data:${mime};base64,${data}`;
}

// --------------------------------------------------------------------- user

function UserBubble({ item }: { item: UserItem }): ReactElement | null {
	const text = typeof item.text === "string" ? item.text : "";
	const images = Array.isArray(item.images) ? item.images : [];
	const select = useCallback((state: UiState) => state.checkpointsByItem[item.id], [item.id]);
	const checkpoint = useUi(select);
	if (text.trim().length === 0 && images.length === 0) return null;

	return (
		<div className="tx-msg tx-msg-user">
			<div className="tx-user-bubble">
				{text.trim().length > 0 ? <Markdown text={text} /> : null}
				{images.length > 0 ? (
					<div className="tx-images">
						{images.map((image, index) => {
							const source = imageSource(image);
							return source === null ? null : (
								<img key={index} className="tx-image" src={source} alt="attachment" />
							);
						})}
					</div>
				) : null}
			</div>
			{checkpoint === undefined ? null : (
				<button
					type="button"
					className="tx-revert"
					title="Restore every file to its state before this message. The conversation is left alone."
					onClick={() => post({ type: "revertCheckpoint", id: checkpoint.id })}
				>
					Revert files to here
				</button>
			)}
		</div>
	);
}

// ---------------------------------------------------------------- assistant

/**
 * A tool call subscribes to its own entry in the live map, so a running tool
 * re-renders itself instead of its whole message.
 */
function ToolCallSlot({ block }: { block: ToolCallContent }): ReactElement {
	const id = typeof block.id === "string" ? block.id : "";
	const select = useCallback((state: UiState) => state.chat.toolCalls[id], [id]);
	const live = useUi(select);
	// The block can land a frame before `tool_execution_start` registers it.
	const pending = useMemo<ToolCallState>(
		() => ({
			toolCallId: id,
			name: typeof block.name === "string" && block.name.length > 0 ? block.name : "tool",
			args: block.arguments !== null && typeof block.arguments === "object" ? block.arguments : {},
			intent: typeof block.intent === "string" ? block.intent : undefined,
			status: "pending",
		}),
		[block, id],
	);

	return <ToolCard call={live ?? pending} />;
}

function AssistantBlock({ block, streaming }: { block: AssistantContent; streaming: boolean }): ReactElement | null {
	switch (block.type) {
		case "text": {
			const text = typeof block.text === "string" ? block.text : "";
			return text.length > 0 ? <Markdown text={text} /> : null;
		}
		case "thinking":
			// Renders nothing when the reasoning is empty or suppressed by config.
			return <Thinking text={typeof block.thinking === "string" ? block.thinking : ""} streaming={streaming} />;
		case "redactedThinking":
			return <span className="chip tx-redacted">redacted reasoning</span>;
		case "toolCall":
			return <ToolCallSlot block={block} />;
		case "image": {
			const source = imageSource(block);
			return source === null ? null : <img className="tx-image tx-image-inline" src={source} alt="model output" />;
		}
		// `fallback` and `anthropicServerTool` are provider bookkeeping, and an
		// unknown discriminant is a newer omp than this UI: say nothing.
		default:
			return null;
	}
}

function AssistantFooter({ item }: { item: AssistantItem }): ReactElement | null {
	const usage = item.usage;
	const totalTokens = usage && typeof usage.totalTokens === "number" && usage.totalTokens > 0 ? usage.totalTokens : 0;
	const costTotal = usage && usage.cost && typeof usage.cost.total === "number" ? usage.cost.total : undefined;
	const model = typeof item.model === "string" ? item.model : "";
	const tokens = totalTokens > 0 ? formatNumber(totalTokens) : "";
	const cost = formatCost(costTotal);
	const duration = formatDuration(item.durationMs);
	if (model.length === 0 && tokens.length === 0 && cost.length === 0 && duration.length === 0) return null;

	return (
		<div className="tx-footer row">
			{model.length > 0 ? <span className="chip mono">{model}</span> : null}
			{tokens.length > 0 ? (
				<span className="chip" title="total tokens">
					{tokens} tok
				</span>
			) : null}
			{cost.length > 0 ? <span className="chip">{cost}</span> : null}
			{duration.length > 0 ? <span className="chip">{duration}</span> : null}
		</div>
	);
}

function AssistantMessage({ item }: { item: AssistantItem }): ReactElement | null {
	const content = Array.isArray(item.content) ? item.content : [];
	const failed = item.stopReason === "error";
	const aborted = item.stopReason === "aborted";
	if (content.length === 0 && !failed && !aborted) return null;

	return (
		<div className="tx-msg tx-msg-assistant">
			{content.map((block, index) => (
				<AssistantBlock key={index} block={block} streaming={item.streaming} />
			))}
			{failed || aborted ? (
				<div className={failed ? "tx-strip tx-strip-err" : "tx-strip tx-strip-warn"}>
					<span className="mono">{failed ? "error" : "aborted"}</span>
					{typeof item.errorMessage === "string" && item.errorMessage.length > 0 ? (
						<span>{item.errorMessage}</span>
					) : null}
				</div>
			) : null}
			{item.streaming ? null : <AssistantFooter item={item} />}
		</div>
	);
}

// -------------------------------------------------------------------- shell

function ShellCard({ item }: { item: ShellItem }): ReactElement {
	const source = typeof item.source === "string" ? item.source : "";
	const output = stripAnsi(typeof item.output === "string" ? item.output : "");
	const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
	const failedExit = exitCode !== undefined && exitCode !== 0;

	return (
		<div className="tx-msg tx-shell">
			<div className="tx-shell-cmd mono">
				<span className="tx-shell-prompt">{item.language === "python" ? ">>>" : "$"}</span>
				<span className="tx-shell-source">{source}</span>
			</div>
			{output.length > 0 ? <pre className="tx-shell-out">{output}</pre> : null}
			{failedExit || item.cancelled || item.truncated ? (
				<div className="row tx-shell-meta">
					{failedExit ? <span className="chip chip-err">exit {exitCode}</span> : null}
					{item.cancelled ? <span className="chip chip-warn">cancelled</span> : null}
					{item.truncated ? <span className="chip">truncated</span> : null}
				</div>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------------- custom

function CustomBlock({ item }: { item: CustomItem }): ReactElement | null {
	const text = typeof item.text === "string" ? item.text : "";
	if (text.trim().length === 0) return null;
	const label = typeof item.customType === "string" && item.customType.length > 0 ? item.customType : "message";

	return (
		<div className="tx-msg tx-custom">
			<div className="tx-custom-label">{label}</div>
			<Markdown text={text} compact />
		</div>
	);
}

// ------------------------------------------------------------- file mentions

function FileMentions({ item }: { item: FileMentionItem }): ReactElement | null {
	const files = Array.isArray(item.files) ? item.files : [];
	if (files.length === 0) return null;

	return (
		<div className="tx-msg tx-mentions">
			<span className="faint tx-mentions-label">read</span>
			{files.map((file, index) => {
				const path = typeof file?.path === "string" ? file.path : "";
				if (path.length === 0) return null;
				let meta = "";
				if (typeof file.skippedReason === "string" && file.skippedReason.length > 0) meta = file.skippedReason;
				else if (typeof file.lineCount === "number") meta = `${formatNumber(file.lineCount)} ln`;
				else if (typeof file.byteSize === "number") meta = formatBytes(file.byteSize);
				return (
					<button
						key={`${index}:${path}`}
						type="button"
						className="chip tx-file-chip"
						title={path}
						onClick={() => post({ type: "openFile", path })}
					>
						<span className="mono">{basename(path)}</span>
						{meta.length > 0 ? <span className="faint">{meta}</span> : null}
					</button>
				);
			})}
		</div>
	);
}

// ------------------------------------------------------------------ summary

function SummaryStrip({ item }: { item: SummaryItem }): ReactElement {
	const [open, setOpen] = useState(false);
	const text = typeof item.text === "string" ? item.text : "";
	const label = typeof item.label === "string" && item.label.length > 0 ? item.label : "Summary";

	return (
		<div className="tx-msg tx-summary">
			<button
				type="button"
				className="tx-summary-head"
				aria-expanded={open}
				disabled={text.length === 0}
				onClick={() => setOpen(value => !value)}
			>
				<span className="tx-caret" aria-hidden="true">
					{open ? "▾" : "▸"}
				</span>
				<span className="tx-summary-label">{label}</span>
				{text.length > 0 ? <span className="faint">{formatNumber(text.length)} chars</span> : null}
			</button>
			{open && text.length > 0 ? (
				<div className="tx-summary-body">
					<Markdown text={text} compact />
				</div>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------------- notice

const NOTICE_TINT: Record<string, string> = {
	info: "tx-strip-info",
	warning: "tx-strip-warn",
	error: "tx-strip-err",
};

function NoticeStrip({ item }: { item: NoticeItem }): ReactElement | null {
	const text = typeof item.text === "string" ? item.text : "";
	if (text.trim().length === 0) return null;

	return (
		<div className={`tx-msg tx-strip ${NOTICE_TINT[item.level] ?? "tx-strip-info"}`}>
			{typeof item.source === "string" && item.source.length > 0 ? (
				<span className="mono faint">{item.source}</span>
			) : null}
			<span>{text}</span>
		</div>
	);
}

// --------------------------------------------------------------------------

function MessageItemInner({ item }: { item: ChatItem }): ReactElement | null {
	switch (item.kind) {
		case "user":
			return <UserBubble item={item} />;
		case "assistant":
			return <AssistantMessage item={item} />;
		case "shell":
			return <ShellCard item={item} />;
		case "custom":
			return <CustomBlock item={item} />;
		case "fileMention":
			return <FileMentions item={item} />;
		case "summary":
			return <SummaryStrip item={item} />;
		case "notice":
			return <NoticeStrip item={item} />;
		// A kind this build does not know about is a newer omp, not a crash.
		default:
			return null;
	}
}

/**
 * The reducer replaces only the items it touches, so memoizing on the item
 * reference keeps a long transcript at one re-render per streamed frame.
 */
export const MessageItem = memo(MessageItemInner);
