import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { formatDuration, formatNumber } from "../format";
import type { UiState } from "../store";
import { useUi } from "../store";

const selectShowThinking = (state: UiState) => state.config.showThinking;

/** Lines of live reasoning kept on screen while a block is still streaming. */
const TAIL_LINES = 40;

/** Last `lines` lines of `text`, without materializing the whole split. */
function tailLines(text: string, lines: number): string {
	let cut = text.length;
	for (let seen = 0; seen < lines; seen++) {
		if (cut <= 0) return text;
		const next = text.lastIndexOf("\n", cut - 1);
		if (next < 0) return text;
		cut = next;
	}
	return text.slice(cut + 1);
}

/** Whitespace-delimited word count, without allocating an array. */
function countWords(text: string): number {
	let words = 0;
	let inWord = false;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		const blank = code === 32 || code === 10 || code === 9 || code === 13;
		if (blank) {
			inWord = false;
		} else if (!inWord) {
			inWord = true;
			words++;
		}
	}
	return words;
}

/**
 * A reasoning block. Collapsed once settled — reasoning is context, not the
 * answer — but auto-expanded to its tail while streaming so the user can watch
 * the model think without the block pushing the answer off screen.
 */
export function Thinking({ text, streaming }: { text: string; streaming?: boolean }): ReactElement | null {
	const showThinking = useUi(selectShowThinking);
	const [open, setOpen] = useState(false);
	const [elapsedMs, setElapsedMs] = useState(0);
	const startRef = useRef(0);

	useEffect(() => {
		if (!streaming) {
			startRef.current = 0;
			return;
		}
		if (startRef.current === 0) startRef.current = Date.now();
		const tick = () => setElapsedMs(Date.now() - startRef.current);
		tick();
		const timer = window.setInterval(tick, 1000);
		return () => window.clearInterval(timer);
	}, [streaming]);

	const body = typeof text === "string" ? text : "";
	const words = useMemo(() => countWords(body), [body]);
	const live = streaming === true;
	const expanded = live || open;
	const visible = useMemo(() => (live && !open ? tailLines(body, TAIL_LINES) : body), [body, live, open]);

	if (!showThinking) return null;
	// opus-5 emits encrypted reasoning as `{ thinking: "", thinkingSignature }`.
	// An empty block has nothing to say, streaming or not — render nothing.
	if (body.trim().length === 0) return null;

	return (
		<div className="tx-thinking">
			<button
				type="button"
				className="tx-thinking-head"
				aria-expanded={expanded}
				onClick={() => setOpen(value => !value)}
			>
				<span className="tx-caret" aria-hidden="true">
					{expanded ? "▾" : "▸"}
				</span>
				<span className="tx-thinking-title">Thinking</span>
				{live ? <span className="spinner" /> : null}
				{words > 0 ? (
					<span className="faint" title={`${body.length} characters`}>
						{formatNumber(words)} words
					</span>
				) : null}
				{live && elapsedMs >= 1000 ? <span className="faint">{formatDuration(elapsedMs)}</span> : null}
			</button>
			{expanded && visible.length > 0 ? <div className="tx-thinking-text">{visible}</div> : null}
		</div>
	);
}
