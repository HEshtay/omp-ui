/** Filesystem tools: `read`, `write`, `edit` / `apply_patch`. */

import type { ReactNode } from "react";
import { basename, formatBytes } from "../../format";
import { post } from "../../vscode";
import {
	argsOf,
	asRecord,
	bool,
	detailsOf,
	liveResult,
	num,
	records,
	resultText,
	splitLines,
	str,
	stripOutputNotices,
	strings,
	text,
} from "./detail";
import { CodeBlock, Empty, ExternalLink, MoreRow, Note, NumberedCode, PathLink, Section, Stats } from "./parts";
import type { ToolBodyProps, ToolRenderer } from "./types";
import type { ToolCallState } from "../../../../src/shared/chat-model";

// =========================================================================== read

interface ReadView {
	kind: string;
	resolvedPath?: string;
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes: string[];
	isDirectory: boolean;
	fileSize?: number;
	totalLines?: number;
	conflictCount?: number;
	targets: string[];
	suffix?: { from: string; to: string };
	display?: { text: string; startLine: number; lineNumbers?: Array<number | null> };
}

function readView(details: Record<string, unknown> | undefined): ReadView {
	const display = asRecord(details?.displayContent);
	const displayText = str(display?.text);
	const suffix = asRecord(details?.suffixResolution);
	const from = text(suffix?.from);
	const to = text(suffix?.to);
	return {
		kind: str(details?.kind) ?? "file",
		resolvedPath: text(details?.resolvedPath),
		url: text(details?.url),
		finalUrl: text(details?.finalUrl),
		contentType: text(details?.contentType),
		method: text(details?.method),
		notes: strings(details?.notes),
		isDirectory: bool(details?.isDirectory) === true,
		fileSize: num(details?.fileSize),
		totalLines: num(details?.totalLines),
		conflictCount: num(details?.conflictCount),
		targets: strings(details?.displayReadTargets),
		suffix: from !== undefined && to !== undefined ? { from, to } : undefined,
		display:
			displayText === undefined
				? undefined
				: {
						text: displayText,
						startLine: num(display?.startLine) ?? 1,
						lineNumbers: Array.isArray(display?.lineNumbers)
							? display.lineNumbers.map(entry => (typeof entry === "number" ? entry : null))
							: undefined,
					},
	};
}

const HASHLINE_HEADER = /^\[[^\]]+#[0-9A-Za-z]{2,8}\]$/;
const HASHLINE_PREFIX = /^\s*(\d+)[:\u2192-]/;

/**
 * Recover clean text from the model-facing read payload when `displayContent`
 * is missing: drop the `[path#TAG]` anchor header and lift the `NNN:` prefixes
 * into gutter numbers rather than showing them inline.
 */
function withoutHashlineAnchors(raw: string): { text: string; lineNumbers?: Array<number | null> } {
	const lines = raw.split("\n");
	if (lines.length > 0 && HASHLINE_HEADER.test((lines[0] ?? "").trim())) lines.shift();
	let numbered = 0;
	for (const line of lines) {
		if (HASHLINE_PREFIX.test(line)) numbered++;
	}
	if (lines.length === 0 || numbered < lines.length * 0.8) return { text: lines.join("\n") };
	const numbers: Array<number | null> = [];
	const stripped = lines.map(line => {
		const match = HASHLINE_PREFIX.exec(line);
		if (match?.[1] === undefined) {
			numbers.push(null);
			return line;
		}
		numbers.push(Number(match[1]));
		return line.slice(match[0].length);
	});
	return { text: stripped.join("\n"), lineNumbers: numbers };
}

function ReadTargets({ targets }: { targets: string[] }) {
	return (
		<div className="tool-list">
			{targets.map(target => (
				<PathLink key={target} path={target} className="tool-list-row mono" />
			))}
		</div>
	);
}

function ReadBody({ call, expanded }: ToolBodyProps) {
	const details = detailsOf(call);
	const view = readView(details);
	const stripped = stripOutputNotices(resultText(liveResult(call)));
	const limit = expanded ? 1000 : 14;

	if (call.status === "pending" || call.status === "running") {
		return <Empty>Reading…</Empty>;
	}

	const gutterTarget = view.resolvedPath ?? text(argsOf(call).path);
	const onLine =
		gutterTarget === undefined ? undefined : (line: number) => post({ type: "openFile", path: gutterTarget, line });

	let content: ReactNode = null;
	if (view.display !== undefined) {
		content = (
			<NumberedCode
				text={view.display.text}
				startLine={view.display.startLine}
				lineNumbers={view.display.lineNumbers}
				limit={limit}
				onLine={onLine}
			/>
		);
	} else if (view.isDirectory || view.kind === "url") {
		content = <CodeBlock text={stripped.text} limit={limit} />;
	} else if (stripped.text.length > 0) {
		const recovered = withoutHashlineAnchors(stripped.text);
		content = (
			<NumberedCode text={recovered.text} lineNumbers={recovered.lineNumbers} limit={limit} onLine={onLine} />
		);
	}

	const stats: Array<[string, ReactNode]> = [];
	if (view.totalLines !== undefined) stats.push(["lines", view.totalLines.toLocaleString()]);
	if (view.fileSize !== undefined) stats.push(["size", formatBytes(view.fileSize)]);

	return (
		<>
			{view.targets.length > 1 && (
				<Section label={`${view.targets.length} targets`}>
					<ReadTargets targets={view.targets} />
				</Section>
			)}
			{view.suffix !== undefined && (
				<Note kind="info">
					Resolved <span className="mono">{view.suffix.from}</span> → <span className="mono">{view.suffix.to}</span>
				</Note>
			)}
			{view.conflictCount !== undefined && view.conflictCount > 0 && (
				<Note kind="warn">{view.conflictCount} unresolved merge conflict(s)</Note>
			)}
			{view.kind === "url" && (view.finalUrl ?? view.url) !== undefined && (
				<div className="tool-kv faint mono">
					{view.method !== undefined && <span>{view.method}</span>}
					<ExternalLink url={(view.finalUrl ?? view.url) ?? ""} />
					{view.contentType !== undefined && <span>{view.contentType}</span>}
				</div>
			)}
			{view.notes.length > 0 && <Note kind="info">{view.notes.join(" · ")}</Note>}
			{content ?? <Empty>No content.</Empty>}
			<Stats items={stats} />
		</>
	);
}

export const readRenderer: ToolRenderer = {
	title: () => "Read",
	summary: call => {
		const view = readView(detailsOf(call));
		const label = text(argsOf(call).path) ?? view.resolvedPath ?? view.url;
		if (label === undefined) return null;
		if (view.kind === "url" || /^[a-z][a-z0-9+.-]*:\/\//.test(label)) {
			return <ExternalLink url={view.finalUrl ?? view.url ?? label} label={<span className="mono">{label}</span>} />;
		}
		const target = view.resolvedPath ?? label;
		const line = view.display?.startLine;
		return (
			<PathLink
				path={target}
				line={line !== undefined && line > 1 ? line : undefined}
				label={<span className="mono">{label}</span>}
			/>
		);
	},
	body: ReadBody,
};

// ========================================================================== write

function WriteBody({ call, expanded }: ToolBodyProps) {
	const args = argsOf(call);
	const details = detailsOf(call);
	const content = str(args.content);
	const limit = expanded ? 600 : 10;

	if (content === undefined) {
		const streaming = call.partialArgs;
		if (streaming !== undefined) {
			return (
				<Section label="Content (streaming)">
					<CodeBlock text={streaming} limit={limit} />
				</Section>
			);
		}
		const stripped = stripOutputNotices(resultText(liveResult(call)));
		return stripped.text.length === 0 ? <Empty>No content.</Empty> : <CodeBlock text={stripped.text} limit={limit} />;
	}

	const { lines } = splitLines(content, Number.MAX_SAFE_INTEGER);
	return (
		<>
			<NumberedCode text={content} limit={limit} />
			{bool(details?.madeExecutable) === true && <Note kind="info">Made executable (shebang detected)</Note>}
			<Stats
				items={[
					["lines", lines.length.toLocaleString()],
					["size", formatBytes(new TextEncoder().encode(content).length)],
				]}
			/>
		</>
	);
}

export const writeRenderer: ToolRenderer = {
	title: () => "Write",
	summary: call => {
		const target = text(detailsOf(call)?.resolvedPath) ?? text(argsOf(call).path);
		return target === undefined ? null : <PathLink path={target} label={<span className="mono">{target}</span>} />;
	},
	body: WriteBody,
};

// =========================================================================== edit

interface EditEntry {
	path?: string;
	sourcePath?: string;
	move?: string;
	op?: string;
	diff: string;
	oldText?: string;
	newText?: string;
	firstChangedLine?: number;
	snapshotsPruned: boolean;
	isError: boolean;
	errorText?: string;
}

function editEntry(record: Record<string, unknown>): EditEntry {
	return {
		path: text(record.path),
		sourcePath: text(record.sourcePath),
		move: text(record.move),
		op: text(record.op),
		diff: str(record.diff) ?? "",
		oldText: str(record.oldText),
		newText: str(record.newText),
		firstChangedLine: num(record.firstChangedLine),
		snapshotsPruned: bool(record.snapshotsPruned) === true,
		isError: bool(record.isError) === true,
		errorText: text(record.displayErrorText) ?? text(record.errorText),
	};
}

/** One entry per edited file: multi-file edits fan out, single edits use the root details. */
function editEntries(details: Record<string, unknown> | undefined): EditEntry[] {
	if (details === undefined) return [];
	const perFile = records(details.perFileResults);
	if (perFile.length > 0) return perFile.map(editEntry);
	return [editEntry(details)];
}

type DiffKind = "add" | "del" | "ctx" | "hunk" | "meta";

interface DiffRow {
	kind: DiffKind;
	text: string;
	oldLine?: number;
	newLine?: number;
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

function parseDiff(diff: string, limit: number): { rows: DiffRow[]; omitted: number; added: number; removed: number } {
	const lines = diff.split("\n");
	const rows: DiffRow[] = [];
	let added = 0;
	let removed = 0;
	let oldLine = 0;
	let newLine = 0;
	let omitted = 0;
	for (const line of lines) {
		let row: DiffRow;
		const hunk = HUNK_HEADER.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			row = { kind: "hunk", text: line };
		} else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("\\")) {
			row = { kind: "meta", text: line };
		} else if (line.startsWith("+")) {
			added++;
			row = { kind: "add", text: line.slice(1), newLine: newLine++ };
		} else if (line.startsWith("-")) {
			removed++;
			row = { kind: "del", text: line.slice(1), oldLine: oldLine++ };
		} else {
			row = { kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ };
		}
		if (rows.length < limit) rows.push(row);
		else omitted++;
	}
	// A trailing newline in the diff produces one empty context row; drop it.
	const last = rows[rows.length - 1];
	if (omitted === 0 && last?.kind === "ctx" && last.text.length === 0) rows.pop();
	return { rows, omitted, added, removed };
}

const DIFF_SIGN: Record<DiffKind, string> = { add: "+", del: "-", ctx: " ", hunk: "", meta: "" };

function DiffView({ diff, limit }: { diff: string; limit: number }) {
	const { rows, omitted } = parseDiff(diff, limit);
	if (rows.length === 0) return null;
	return (
		<div className="tool-diff">
			{rows.map((row, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are a positional slice of one diff buffer.
				<div className={`tool-diff-row tool-diff-${row.kind}`} key={index}>
					<span className="tool-diff-num">{row.oldLine ?? ""}</span>
					<span className="tool-diff-num">{row.newLine ?? ""}</span>
					<span className="tool-diff-sign">{DIFF_SIGN[row.kind]}</span>
					<span className="tool-diff-text">{row.text.length === 0 ? " " : row.text}</span>
				</div>
			))}
			{omitted > 0 && <MoreRow count={omitted} label="more diff lines" />}
		</div>
	);
}

/** `showPath` is off for a lone edit, whose path already sits in the card header. */
function EditHeader({ entry, showPath }: { entry: EditEntry; showPath: boolean }) {
	const target = entry.path ?? entry.move;
	const canOpenDiff = target !== undefined && entry.oldText !== undefined && entry.newText !== undefined;
	if (target === undefined || (!showPath && !canOpenDiff)) return null;
	return (
		<div className="tool-edit-head row">
			{showPath && entry.sourcePath !== undefined && (
				<>
					<PathLink path={entry.sourcePath} label={<span className="mono truncate">{entry.sourcePath}</span>} />
					<span className="faint">→</span>
				</>
			)}
			{showPath && (
				<PathLink path={target} line={entry.firstChangedLine} label={<span className="mono truncate">{target}</span>} />
			)}
			{showPath && entry.op !== undefined && entry.op !== "update" && <span className="chip">{entry.op}</span>}
			<span className="spacer" />
			{canOpenDiff && (
				<button
					type="button"
					className="btn btn-ghost tool-diff-open"
					onClick={() =>
						post({
							type: "openDiff",
							title: `${basename(target)} (omp edit)`,
							oldText: entry.oldText ?? "",
							newText: entry.newText ?? "",
							path: target,
						})
					}
				>
					Open diff
				</button>
			)}
		</div>
	);
}

function EditFile({ entry, expanded, showPath }: { entry: EditEntry; expanded: boolean; showPath: boolean }) {
	const limit = expanded ? 1200 : 18;
	const target = entry.path ?? entry.move;
	return (
		<div className={entry.isError ? "tool-edit-file tool-edit-file-error" : "tool-edit-file"}>
			<EditHeader entry={entry} showPath={showPath} />
			{entry.errorText !== undefined && <Note kind="error">{entry.errorText}</Note>}
			{entry.diff.length > 0 ? (
				<DiffView diff={entry.diff} limit={limit} />
			) : entry.op === "delete" ? (
				<>
					<Note kind="warn">Deleted {target ?? "file"}</Note>
					{entry.oldText !== undefined && <CodeBlock text={entry.oldText} limit={expanded ? 200 : 6} />}
				</>
			) : entry.sourcePath !== undefined || entry.move !== undefined ? (
				<Note kind="info">Renamed without content changes</Note>
			) : entry.errorText === undefined ? (
				<Empty>No textual changes.</Empty>
			) : null}
			{entry.snapshotsPruned && <Note kind="info">Snapshots pruned — full diff unavailable</Note>}
		</div>
	);
}

function EditBody({ call, expanded }: ToolBodyProps) {
	const details = detailsOf(call);
	const entries = editEntries(details);
	const streaming = call.status === "pending" || call.status === "running";

	if (streaming || entries.length === 0) {
		const input = str(argsOf(call).input) ?? call.partialArgs;
		if (input !== undefined && input.length > 0) {
			return (
				<Section label="Patch">
					<CodeBlock text={input} limit={expanded ? 400 : 12} />
				</Section>
			);
		}
		if (streaming) return <Empty>Preparing edit…</Empty>;
		const stripped = stripOutputNotices(resultText(liveResult(call)));
		return stripped.text.length === 0 ? <Empty>No changes reported.</Empty> : <CodeBlock text={stripped.text} limit={40} />;
	}

	const multi = entries.length > 1;
	return (
		<>
			{entries.map((entry, index) => (
				<EditFile
					// biome-ignore lint/suspicious/noArrayIndexKey: per-file results are positional and may repeat a path.
					key={`${entry.path ?? entry.move ?? "file"}:${index}`}
					entry={entry}
					expanded={expanded}
					showPath={multi || entry.sourcePath !== undefined}
				/>
			))}
		</>
	);
}

function editSummary(call: ToolCallState): ReactNode {
	const details = detailsOf(call);
	const entries = editEntries(details);
	if (entries.length === 0) return null;
	if (entries.length > 1) {
		const failed = entries.filter(entry => entry.isError).length;
		return (
			<span className="row">
				<span className="mono">{entries.length} files</span>
				{failed > 0 && <span className="chip chip-err">{failed} failed</span>}
			</span>
		);
	}
	const entry = entries[0];
	if (entry === undefined) return null;
	const target = entry.path ?? entry.move;
	if (target === undefined) return null;
	const counts = entry.diff.length === 0 ? undefined : parseDiff(entry.diff, 0);
	return (
		<span className="row tool-summary-row">
			{entry.sourcePath !== undefined && (
				<>
					<span className="mono truncate faint">{entry.sourcePath}</span>
					<span className="faint">→</span>
				</>
			)}
			<PathLink
				path={target}
				line={entry.firstChangedLine}
				label={<span className="mono truncate">{target}</span>}
			/>
			{counts !== undefined && counts.added > 0 && <span className="tool-count-add mono">+{counts.added}</span>}
			{counts !== undefined && counts.removed > 0 && <span className="tool-count-del mono">−{counts.removed}</span>}
		</span>
	);
}

export const editRenderer: ToolRenderer = {
	title: call => (call.name === "apply_patch" ? "Apply patch" : "Edit"),
	summary: editSummary,
	body: EditBody,
};
