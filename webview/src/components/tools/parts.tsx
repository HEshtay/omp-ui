/** Presentational pieces every tool card is assembled from. */

import type { ReactNode } from "react";
import { formatBytes } from "../../format";
import { post } from "../../vscode";
import type { Truncation } from "./detail";
import { splitLines } from "./detail";

export function Section({
	label,
	meta,
	children,
}: {
	label?: string;
	meta?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="tool-section">
			{(label !== undefined || meta !== undefined) && (
				<div className="tool-section-head">
					{label !== undefined && <span className="tool-section-label">{label}</span>}
					<span className="spacer" />
					{meta}
				</div>
			)}
			{children}
		</div>
	);
}

/** Plain monospace output. Never HTML — every byte here is untrusted. */
export function CodeBlock({ text, limit = 400 }: { text: string; limit?: number }) {
	const { lines, omitted } = splitLines(text, limit);
	if (lines.length === 0) return null;
	return (
		<div className="tool-code">
			<pre className="tool-pre">{lines.join("\n")}</pre>
			{omitted > 0 && <MoreRow count={omitted} />}
		</div>
	);
}

/**
 * File content with the card's own gutter. The model-facing text carries
 * hashline anchors and `NNN:` prefixes; this renders the clean text instead.
 */
export function NumberedCode({
	text,
	startLine = 1,
	lineNumbers,
	limit = 400,
	onLine,
}: {
	text: string;
	startLine?: number;
	lineNumbers?: Array<number | null>;
	limit?: number;
	onLine?: (line: number) => void;
}) {
	const { lines, omitted } = splitLines(text, limit);
	if (lines.length === 0) return null;
	return (
		<div className="tool-code">
			<div className="tool-numbered">
				{lines.map((line, index) => {
					const explicit = lineNumbers?.[index];
					const number = explicit === undefined ? startLine + index : explicit;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are a positional slice of one text buffer.
						<div className="tool-code-row" key={index}>
							<button
								type="button"
								className="tool-gutter"
								disabled={onLine === undefined || number === null}
								onClick={number === null ? undefined : () => onLine?.(number)}
							>
								{number ?? "⋯"}
							</button>
							<span className="tool-code-text">{line.length === 0 ? " " : line}</span>
						</div>
					);
				})}
			</div>
			{omitted > 0 && <MoreRow count={omitted} />}
		</div>
	);
}

export function MoreRow({ count, label = "more lines" }: { count: number; label?: string }) {
	if (count <= 0) return null;
	return <div className="tool-more faint">…{count.toLocaleString()} {label}</div>;
}

export function PathLink({
	path,
	line,
	label,
	className,
}: {
	path: string;
	line?: number;
	label?: ReactNode;
	className?: string;
}) {
	return (
		<button
			type="button"
			className={className === undefined ? "tool-link" : `tool-link ${className}`}
			title={line === undefined ? path : `${path}:${line}`}
			onClick={() => post(line === undefined ? { type: "openFile", path } : { type: "openFile", path, line })}
		>
			{label ?? path}
		</button>
	);
}

export function ExternalLink({ url, label }: { url: string; label?: ReactNode }) {
	return (
		<button type="button" className="tool-link" title={url} onClick={() => post({ type: "openExternal", url })}>
			{label ?? url}
		</button>
	);
}

/** Output that spilled to disk instead of being inlined. */
export function ArtifactLink({ artifactId }: { artifactId: string }) {
	return (
		<button
			type="button"
			className="tool-link tool-artifact"
			onClick={() => post({ type: "openArtifact", url: `artifact://${artifactId}` })}
		>
			View full output
		</button>
	);
}

export function Note({ kind = "info", children }: { kind?: "info" | "warn" | "error"; children: ReactNode }) {
	return <div className={`tool-note tool-note-${kind}`}>{children}</div>;
}

/** `label value` pairs for a card's stats tail. Renders nothing when empty. */
export function Stats({ items }: { items: Array<[string, ReactNode]> }) {
	if (items.length === 0) return null;
	return (
		<div className="tool-stats faint mono">
			{items.map(([label, value]) => (
				<span className="tool-stat" key={label}>
					<span className="tool-stat-label">{label}</span>
					{value}
				</span>
			))}
		</div>
	);
}

/**
 * Truncation / artifact / diagnostics rows — the tail every card shares.
 * Takes already-narrowed values: it renders outside the renderer boundary, so
 * it must never touch a raw `details` object itself.
 */
export function OutputNotes({
	truncation,
	diagnostics,
	limits,
	artifactId,
}: {
	truncation: Truncation | undefined;
	diagnostics: { summary: string; messages: string[] } | undefined;
	limits: string[];
	artifactId: string | undefined;
}) {
	const showTruncation = truncation !== undefined && truncation.totalLines !== undefined;
	if (!showTruncation && artifactId === undefined && diagnostics === undefined && limits.length === 0) return null;
	return (
		<>
			{showTruncation && truncation !== undefined && (
				<Note kind="warn">
					Showing {(truncation.outputLines ?? 0).toLocaleString()} of {(truncation.totalLines ?? 0).toLocaleString()}
					{" lines"}
					{truncation.totalBytes === undefined ? "" : ` (${formatBytes(truncation.totalBytes)})`}
					{artifactId !== undefined && (
						<>
							{" · "}
							<ArtifactLink artifactId={artifactId} />
						</>
					)}
				</Note>
			)}
			{!showTruncation && artifactId !== undefined && (
				<Note kind="info">
					<ArtifactLink artifactId={artifactId} />
				</Note>
			)}
			{limits.map(limit => (
				<Note kind="warn" key={limit}>
					{limit}
				</Note>
			))}
			{diagnostics !== undefined && (
				<Note kind="warn">
					<div>{diagnostics.summary}</div>
					{diagnostics.messages.length > 0 && <CodeBlock text={diagnostics.messages.join("\n")} limit={20} />}
				</Note>
			)}
		</>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return <div className="tool-empty faint">{children}</div>;
}
