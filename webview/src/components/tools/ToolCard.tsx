/**
 * The shared frame around every tool call: status, summary, duration, expand
 * toggle, artifact link and image blocks. The interior comes from the per-tool
 * registry, wrapped in a boundary so a malformed `details` degrades to the
 * generic card instead of blanking the transcript.
 */

import { Component } from "react";
import type { ErrorInfo, ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ToolCallState, ToolCallStatus } from "../../../../src/shared/chat-model";
import type { ImageContent } from "../../../../src/shared/protocol";
import { formatDuration } from "../../format";
import {
	dataUrl,
	detailsOf,
	diagnosticsOf,
	limitNotices,
	liveResult,
	resultImages,
	resultText,
	truncationOf,
} from "./detail";
import { GenericBody } from "./generic";
import { OutputNotes } from "./parts";
import { rendererFor } from "./registry";
import "./tools.css";

const NO_IMAGES: ImageContent[] = [];
const NO_LIMITS: string[] = [];

/**
 * Expansion is a user decision, not conversation state: it survives the
 * transcript virtualising a card out of the DOM and back.
 */
const expansionByCall = new Map<string, boolean>();

interface BoundaryProps {
	/** Changing this clears a previous failure so a settled result can retry. */
	resetKey: string;
	fallback: ReactNode;
	children: ReactNode;
}

class RendererBoundary extends Component<BoundaryProps, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.warn("omp: tool renderer failed, falling back to the generic card", error, info.componentStack);
	}

	override componentDidUpdate(previous: BoundaryProps): void {
		if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function StatusIcon({ status }: { status: ToolCallStatus }) {
	if (status === "pending" || status === "running") return <span className="spinner" />;
	if (status === "error") return <span className="tool-icon tool-icon-error">✕</span>;
	if (status === "skipped") return <span className="tool-icon tool-icon-skipped">•</span>;
	return <span className="tool-icon tool-icon-ok">✓</span>;
}

/** Elapsed time, ticking while the call is still in flight. */
function useElapsed(call: ToolCallState): string {
	const running = call.status === "pending" || call.status === "running";
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(() => setTick(value => value + 1), 1000);
		return () => window.clearInterval(timer);
	}, [running]);
	if (call.startedAt === undefined) return "";
	const end = call.endedAt ?? (running ? Date.now() : undefined);
	if (end === undefined) return "";
	const elapsed = end - call.startedAt;
	// Sub-second successes are noise; a running call always shows something.
	return running || elapsed >= 1000 ? formatDuration(elapsed) : "";
}

const RAW_OUTPUT_FOOTER = /\[raw output: artifact:\/\/(\d+)\]/;

/**
 * The header pieces and the notes tail run outside the renderer boundary — a
 * React boundary only catches its children — yet they touch the same untyped
 * `details`. A field that throws on access must cost that field, not the card.
 */
function safe<T>(compute: () => T, fallback: T): T {
	try {
		return compute();
	} catch (error) {
		console.warn("omp: tool card field failed", error);
		return fallback;
	}
}

/** The artifact the frame offers, without re-scanning a 50 KiB bash tail. */
function artifactFor(call: ToolCallState, truncationArtifact: string | undefined): string | undefined {
	if (truncationArtifact !== undefined) return truncationArtifact;
	const output = resultText(liveResult(call));
	if (output.length === 0) return undefined;
	const tail = output.length > 1024 ? output.slice(-1024) : output;
	return RAW_OUTPUT_FOOTER.exec(tail)?.[1];
}

export function ToolCard({ call }: { call: ToolCallState }): ReactElement {
	const renderer = rendererFor(call.name);
	const [expanded, setExpanded] = useState(
		() => expansionByCall.get(call.toolCallId) ?? (renderer.defaultExpanded === true || call.status === "error"),
	);
	const elapsed = useElapsed(call);

	// An error that lands after the card mounted opens itself, unless the user
	// already made a call on this card.
	useEffect(() => {
		if (call.status === "error" && expansionByCall.get(call.toolCallId) === undefined) setExpanded(true);
	}, [call.status, call.toolCallId]);

	const toggle = () => {
		expansionByCall.set(call.toolCallId, !expanded);
		setExpanded(!expanded);
	};

	const details = safe(() => detailsOf(call), undefined);
	const truncation = safe(() => truncationOf(details), undefined);
	const diagnostics = safe(() => diagnosticsOf(details), undefined);
	const limits = safe(() => limitNotices(details), NO_LIMITS);
	const artifactId = safe(() => artifactFor(call, truncation?.artifactId), undefined);
	const images = safe(() => resultImages(liveResult(call)), NO_IMAGES);
	const title = safe(() => renderer.title?.(call) ?? call.name, call.name);
	const summary = safe(() => renderer.summary?.(call) ?? null, null);
	const meta = safe(() => renderer.meta?.(call) ?? null, null);
	const Body = renderer.body;

	return (
		<div className={`tool-card tool-card-${call.status}`} data-tool={call.name}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the caret button is the keyboard affordance. */}
			<div
				className="tool-head"
				onClick={event => {
					if (event.target instanceof Element && event.target.closest("a,button")) return;
					toggle();
				}}
			>
				<StatusIcon status={call.status} />
				{renderer.hideName !== true && <span className="tool-name">{title}</span>}
				{summary !== null && <span className="tool-summary truncate">{summary}</span>}
				{call.intent !== undefined && summary === null && <span className="tool-summary truncate faint">{call.intent}</span>}
				<span className="spacer" />
				{meta}
				{elapsed.length > 0 && <span className="tool-elapsed faint mono">{elapsed}</span>}
				<button
					type="button"
					className="icon-btn tool-toggle"
					aria-expanded={expanded}
					aria-label={expanded ? "Collapse tool output" : "Expand tool output"}
					onClick={toggle}
				>
					{expanded ? "▾" : "▸"}
				</button>
			</div>
			<div className="tool-body">
				<RendererBoundary
					resetKey={`${call.status}:${call.endedAt ?? 0}`}
					fallback={<GenericBody call={call} expanded={expanded} />}
				>
					<Body call={call} expanded={expanded} />
				</RendererBoundary>
				<OutputNotes
					truncation={truncation}
					diagnostics={diagnostics}
					limits={limits}
					artifactId={artifactId}
				/>
				{images.length > 0 && (
					<div className="tool-images">
						{images.map((image, index) => (
							<img
								// biome-ignore lint/suspicious/noArrayIndexKey: image blocks are positional and carry no id.
								key={index}
								className="tool-image"
								src={dataUrl(image)}
								alt={`Tool output ${index + 1}`}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
