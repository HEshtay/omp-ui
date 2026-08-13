/** `grep` / `ast_grep` / `glob` — match listings with clickable rows. */

import type { ReactNode } from "react";
import { post } from "../../vscode";
import {
	argsOf,
	asRecord,
	bool,
	detailsOf,
	liveResult,
	metaOf,
	num,
	records,
	resolvePath,
	resultText,
	str,
	stripOutputNotices,
	strings,
	text,
} from "./detail";
import { CodeBlock, Empty, MoreRow, Note, PathLink } from "./parts";
import type { ToolBodyProps, ToolRenderer } from "./types";

interface SearchView {
	matchCount?: number;
	fileCount?: number;
	files: string[];
	fileMatches: Array<{ path: string; count: number }>;
	displayContent?: string;
	base?: string;
	missingPaths: string[];
	truncated: boolean;
	error?: string;
	limitNotes: string[];
}

function searchView(details: Record<string, unknown> | undefined): SearchView {
	// The card frame renders `meta.limits`; these legacy top-level flags are the
	// fallback for results that predate it, so only one of the two ever shows.
	const limitNotes: string[] = [];
	if (asRecord(metaOf(details)?.limits) === undefined) {
		const fileLimit = num(details?.fileLimitReached);
		const perFileLimit = num(details?.perFileLimitReached);
		const resultLimit = num(details?.resultLimitReached);
		if (fileLimit !== undefined) limitNotes.push(`File limit reached at ${fileLimit}`);
		if (perFileLimit !== undefined) limitNotes.push(`Per-file match limit reached at ${perFileLimit}`);
		if (resultLimit !== undefined) limitNotes.push(`Result limit reached at ${resultLimit}`);
		if (bool(details?.linesTruncated) === true) limitNotes.push("Some lines were truncated");
	}

	const fileMatches: Array<{ path: string; count: number }> = [];
	for (const entry of records(details?.fileMatches)) {
		const path = text(entry.path);
		if (path === undefined) continue;
		fileMatches.push({ path, count: num(entry.count) ?? 0 });
	}

	return {
		matchCount: num(details?.matchCount),
		fileCount: num(details?.fileCount),
		files: strings(details?.files),
		fileMatches,
		displayContent: text(details?.displayContent),
		base: text(details?.cwd) ?? text(details?.searchPath) ?? text(details?.scopePath),
		missingPaths: strings(details?.missingPaths),
		truncated: bool(details?.truncated) === true,
		error: text(details?.error),
		limitNotes,
	};
}

// ----------------------------------------------------------- grep listing

type GrepRow =
	| { kind: "dir"; label: string }
	| { kind: "file"; label: string; path: string }
	| { kind: "line"; line: number; body: string; match: boolean; path?: string }
	| { kind: "text"; body: string };

const GREP_DIR = /^#\s+(.+)$/;
const GREP_FILE = /^##\s+(.+)$/;
const GREP_LINE = /^([*\s])\s*(\d+)│(.*)$/;

function joinRelative(dir: string | undefined, file: string): string {
	if (dir === undefined || dir.length === 0) return file;
	if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith(dir)) return file;
	return `${dir.replace(/[\\/]+$/, "")}/${file}`;
}

/** Parse omp's `# dir` / `## file` / `*NN│match` display grammar into clickable rows. */
function parseGrepDisplay(display: string, limit: number): { rows: GrepRow[]; omitted: number } {
	const rows: GrepRow[] = [];
	let omitted = 0;
	let dir: string | undefined;
	let file: string | undefined;
	for (const raw of display.split("\n")) {
		const line = raw.replace(/\r$/, "");
		let row: GrepRow;
		const dirMatch = GREP_DIR.exec(line);
		const fileMatch = GREP_FILE.exec(line);
		const lineMatch = GREP_LINE.exec(line);
		if (fileMatch?.[1] !== undefined) {
			file = joinRelative(dir, fileMatch[1].trim());
			row = { kind: "file", label: fileMatch[1].trim(), path: file };
		} else if (dirMatch?.[1] !== undefined) {
			dir = dirMatch[1].trim();
			file = undefined;
			row = { kind: "dir", label: dir };
		} else if (lineMatch?.[2] !== undefined) {
			row = {
				kind: "line",
				line: Number(lineMatch[2]),
				body: lineMatch[3] ?? "",
				match: lineMatch[1] === "*",
				path: file,
			};
		} else if (line.trim().length === 0) {
			continue;
		} else {
			row = { kind: "text", body: line };
		}
		if (rows.length < limit) rows.push(row);
		else omitted++;
	}
	return { rows, omitted };
}

function GrepListing({ display, base, limit }: { display: string; base: string | undefined; limit: number }) {
	const { rows, omitted } = parseGrepDisplay(display, limit);
	if (rows.length === 0) return null;
	return (
		<div className="tool-matches">
			{rows.map((row, index) => {
				const key = `${index}`;
				if (row.kind === "dir") {
					return (
						<div className="tool-match-dir faint mono" key={key}>
							{row.label}
						</div>
					);
				}
				if (row.kind === "file") {
					return (
						<PathLink
							key={key}
							path={resolvePath(base, row.path)}
							label={<span className="mono">{row.label}</span>}
							className="tool-match-file"
						/>
					);
				}
				if (row.kind === "text") {
					return (
						<div className="tool-match-text mono faint" key={key}>
							{row.body}
						</div>
					);
				}
				const target = row.path;
				return (
					<button
						type="button"
						key={key}
						className={row.match ? "tool-match-row tool-match-hit" : "tool-match-row"}
						disabled={target === undefined}
						onClick={
							target === undefined
								? undefined
								: () => post({ type: "openFile", path: resolvePath(base, target), line: row.line })
						}
					>
						<span className="tool-match-num mono">{row.line}</span>
						<span className="tool-match-body mono">{row.body.length === 0 ? " " : row.body}</span>
					</button>
				);
			})}
			{omitted > 0 && <MoreRow count={omitted} label="more rows" />}
		</div>
	);
}

function SearchWarnings({ view }: { view: SearchView }) {
	return (
		<>
			{view.error !== undefined && <Note kind="error">{view.error}</Note>}
			{view.missingPaths.length > 0 && <Note kind="warn">Missing paths: {view.missingPaths.join(", ")}</Note>}
			{view.limitNotes.map(note => (
				<Note kind="warn" key={note}>
					{note}
				</Note>
			))}
		</>
	);
}

function GrepBody({ call, expanded }: ToolBodyProps) {
	const view = searchView(detailsOf(call));
	const limit = expanded ? 800 : 12;
	if (call.status === "pending" || call.status === "running") return <Empty>Searching…</Empty>;

	const listing = view.displayContent;
	return (
		<>
			<SearchWarnings view={view} />
			{listing !== undefined ? (
				<GrepListing display={listing} base={view.base} limit={limit} />
			) : view.fileMatches.length > 0 ? (
				<div className="tool-list">
					{view.fileMatches.slice(0, limit).map(entry => (
						<div className="tool-list-row" key={entry.path}>
							<PathLink path={resolvePath(view.base, entry.path)} label={<span className="mono">{entry.path}</span>} />
							<span className="spacer" />
							<span className="faint mono">{entry.count}</span>
						</div>
					))}
					<MoreRow count={Math.max(0, view.fileMatches.length - limit)} label="more files" />
				</div>
			) : view.matchCount === 0 || view.error !== undefined ? (
				view.error === undefined ? (
					<Empty>No matches.</Empty>
				) : null
			) : (
				<CodeBlock text={stripOutputNotices(resultText(liveResult(call))).text} limit={limit} />
			)}
		</>
	);
}

function searchCounts(view: SearchView): ReactNode {
	if (view.matchCount === undefined && view.fileCount === undefined) return null;
	const parts: string[] = [];
	if (view.matchCount !== undefined) parts.push(`${view.matchCount.toLocaleString()} match${view.matchCount === 1 ? "" : "es"}`);
	if (view.fileCount !== undefined) parts.push(`${view.fileCount.toLocaleString()} file${view.fileCount === 1 ? "" : "s"}`);
	return <span className={view.matchCount === 0 ? "chip" : "chip chip-accent"}>{parts.join(" · ")}</span>;
}

export const grepRenderer: ToolRenderer = {
	title: call => (call.name === "ast_grep" ? "AST grep" : "Grep"),
	summary: call => {
		const pattern = str(argsOf(call).pattern);
		const scope = text(argsOf(call).path) ?? text(detailsOf(call)?.scopePath);
		if (pattern === undefined && scope === undefined) return null;
		return (
			<span className="row tool-summary-row">
				{pattern !== undefined && <span className="mono tool-pattern truncate">{pattern}</span>}
				{scope !== undefined && <span className="faint mono truncate">in {scope}</span>}
			</span>
		);
	},
	meta: call => searchCounts(searchView(detailsOf(call))),
	body: GrepBody,
};

// ------------------------------------------------------------------- glob

function GlobBody({ call, expanded }: ToolBodyProps) {
	const view = searchView(detailsOf(call));
	const limit = expanded ? 1000 : 12;
	if (call.status === "pending" || call.status === "running") return <Empty>Globbing…</Empty>;
	const shown = view.files.slice(0, limit);
	return (
		<>
			<SearchWarnings view={view} />
			{shown.length === 0 ? (
				view.error === undefined ? (
					<Empty>No files matched.</Empty>
				) : null
			) : (
				<div className="tool-list">
					{shown.map(file => (
						<PathLink
							key={file}
							path={resolvePath(view.base, file)}
							label={<span className="mono">{file}</span>}
							className="tool-list-row"
						/>
					))}
					<MoreRow count={Math.max(0, view.files.length - shown.length)} label="more files" />
				</div>
			)}
		</>
	);
}

export const globRenderer: ToolRenderer = {
	title: () => "Glob",
	summary: call => {
		const pattern = text(argsOf(call).path) ?? text(detailsOf(call)?.scopePath);
		return pattern === undefined ? null : <span className="mono truncate">{pattern}</span>;
	},
	meta: call => {
		const view = searchView(detailsOf(call));
		const count = view.fileCount ?? (view.files.length > 0 ? view.files.length : undefined);
		if (count === undefined) return null;
		return <span className={count === 0 ? "chip" : "chip chip-accent"}>{count.toLocaleString()} files</span>;
	},
	body: GlobBody,
};
