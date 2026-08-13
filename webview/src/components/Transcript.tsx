import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { AssistantItem, RetryState } from "../../../src/shared/chat-model";
import { stripAnsi } from "../format";
import type { UiState } from "../store";
import { focusComposer, store, useUi } from "../store";
import { MessageItem } from "./MessageItem";
import "./transcript.css";

const selectItems = (state: UiState) => state.chat.items;
const selectStreaming = (state: UiState) => state.session.isStreaming;
const selectAutoScroll = (state: UiState) => state.config.autoScroll;
const selectWorkspaceName = (state: UiState) => state.session.workspaceName;
const selectCompaction = (state: UiState) => state.chat.compaction;
const selectRetry = (state: UiState) => state.chat.retry;
const selectCommandOutput = (state: UiState) => state.commandOutput;
const selectShowThinking = (state: UiState) => state.config.showThinking;

/** How close to the bottom still counts as "following the stream". */
const FOLLOW_THRESHOLD_PX = 40;

/**
 * An assistant message can be mid-stream and still have nothing on screen:
 * Anthropic's encrypted reasoning arrives as `{ thinking: "" }`, and thinking
 * can be switched off entirely. The streaming row has to look at the content,
 * not merely at whether a streaming item exists, or those turns show no sign
 * of life at all.
 */
function hasVisibleContent(item: AssistantItem, showThinking: boolean): boolean {
	const content = Array.isArray(item.content) ? item.content : [];
	for (const block of content) {
		switch (block.type) {
			case "text":
				if (typeof block.text === "string" && block.text.trim().length > 0) return true;
				break;
			case "thinking":
				if (showThinking && typeof block.thinking === "string" && block.thinking.trim().length > 0) return true;
				break;
			case "redactedThinking":
			case "toolCall":
			case "image":
				return true;
			default:
				break;
		}
	}
	return false;
}

const EXAMPLE_PROMPTS = [
	"Give me a tour of this codebase: entry points, layers, where state lives.",
	"Review my uncommitted changes for bugs and missing tests.",
	"Find every place we swallow an error and flag the risky ones.",
	"Add a focused test for the file I have open.",
];

function EmptyState(): ReactElement {
	const workspaceName = useUi(selectWorkspaceName);

	return (
		<div className="tx-empty">
			<div className="tx-wordmark">omp</div>
			<div className="tx-empty-sub muted">{workspaceName.length > 0 ? workspaceName : "no folder open"}</div>
			<div className="tx-examples">
				{EXAMPLE_PROMPTS.map(prompt => (
					<button
						key={prompt}
						type="button"
						className="tx-example"
						onClick={() => {
							store.setDraft({ text: prompt, images: [] });
							focusComposer();
						}}
					>
						{prompt}
					</button>
				))}
			</div>
		</div>
	);
}

/** Output from local-only slash commands, which never reach the agent. */
function CommandOutput(): ReactElement | null {
	const entries = useUi(selectCommandOutput);
	if (entries.length === 0) return null;

	return (
		<>
			{entries.map((text, index) => (
				<div className="tx-cmd" key={index}>
					<pre className="tx-cmd-out">{stripAnsi(text)}</pre>
					<button
						type="button"
						className="icon-btn tx-cmd-dismiss"
						title="Dismiss command output"
						aria-label="Dismiss command output"
						onClick={() => store.clearCommandOutput()}
					>
						✕
					</button>
				</div>
			))}
		</>
	);
}

function RetryStrip({ retry }: { retry: RetryState }): ReactElement {
	const delayMs = typeof retry.delayMs === "number" && retry.delayMs > 0 ? retry.delayMs : 0;
	const [remainingMs, setRemainingMs] = useState(delayMs);

	useEffect(() => {
		const deadline = Date.now() + delayMs;
		const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()));
		tick();
		const timer = window.setInterval(tick, 500);
		return () => window.clearInterval(timer);
	}, [retry, delayMs]);

	const seconds = Math.ceil(remainingMs / 1000);
	const detail = typeof retry.errorMessage === "string" ? retry.errorMessage : "";
	return (
		<div className="tx-strip tx-strip-warn">
			<span className="spinner" />
			<span>
				Retry {retry.attempt}/{retry.maxAttempts}
				{seconds > 0 ? ` in ${seconds}s` : ""}
			</span>
			{detail.length > 0 ? (
				<span className="tx-strip-detail truncate" title={detail}>
					— {detail}
				</span>
			) : null}
		</div>
	);
}

/**
 * The conversation timeline.
 *
 * Autoscroll is sticky rather than forced: a resize observer on the content
 * column pins the viewport to the bottom while the user is already there, and
 * the first scroll away hands control back until they ask for it, so reading
 * history mid-stream never yanks.
 */
export function Transcript(): ReactElement {
	const items = useUi(selectItems);
	const isStreaming = useUi(selectStreaming);
	const autoScroll = useUi(selectAutoScroll);
	const compaction = useUi(selectCompaction);
	const retry = useUi(selectRetry);
	const showThinking = useUi(selectShowThinking);

	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const followingRef = useRef(true);
	const autoScrollRef = useRef(autoScroll);
	const [following, setFollowing] = useState(true);

	useEffect(() => {
		autoScrollRef.current = autoScroll;
	}, [autoScroll]);

	const onScroll = useCallback(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		const next = distance <= FOLLOW_THRESHOLD_PX;
		if (next === followingRef.current) return;
		followingRef.current = next;
		setFollowing(next);
	}, []);

	// One observer for the lifetime of the panel: every growth path (streamed
	// text, a tool card expanding, an image decoding) resizes the column, and
	// none of them need a render pass here to be followed.
	useEffect(() => {
		const scroller = scrollerRef.current;
		const content = contentRef.current;
		if (!scroller || !content) return;
		const stick = () => {
			if (!followingRef.current || !autoScrollRef.current) return;
			scroller.scrollTop = scroller.scrollHeight;
		};
		stick();
		const observer = new ResizeObserver(stick);
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	const jumpToLatest = useCallback(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		followingRef.current = true;
		setFollowing(true);
		scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
	}, []);

	const last = items[items.length - 1];
	const streamingItemVisible =
		last?.kind === "assistant" && last.streaming && hasVisibleContent(last, showThinking);
	const compactionDetail = compaction
		? [compaction.action, compaction.reason].filter(part => typeof part === "string" && part.length > 0).join(" · ")
		: "";

	return (
		<div className="tx-wrap">
			<div className="tx-scroller" ref={scrollerRef} onScroll={onScroll} role="log" aria-label="Conversation">
				<div className="tx-inner" ref={contentRef}>
					{items.length === 0 ? (
						<EmptyState />
					) : (
						items.map(item => <MessageItem key={item.id} item={item} />)
					)}
					<CommandOutput />
					{compaction ? (
						<div className="tx-strip tx-strip-accent">
							<span className="spinner" />
							<span>Compacting context…</span>
							<span className="tx-strip-detail mono">{compactionDetail}</span>
						</div>
					) : null}
					{retry ? <RetryStrip retry={retry} /> : null}
					{isStreaming && !streamingItemVisible ? (
						<div className="tx-streaming row">
							<span className="spinner" />
							<span className="muted pulse">working…</span>
						</div>
					) : null}
				</div>
			</div>
			{following ? null : (
				<button type="button" className="tx-jump" onClick={jumpToLatest}>
					↓ Jump to latest
				</button>
			)}
		</div>
	);
}
