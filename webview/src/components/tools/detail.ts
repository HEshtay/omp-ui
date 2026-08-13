/**
 * Defensive access to the untyped `details` channel, plus omp's output-notice
 * grammar.
 *
 * `details` is `any` on the wire and third-party/MCP tools can violate every
 * contract in the reference, so nothing here ever casts a field into shape: a
 * wrong-typed value narrows to `undefined` and the caller renders less rather
 * than throwing.
 */

import type { ToolCallState } from "../../../../src/shared/chat-model";
import type { AgentToolResult, ImageContent, TextContent } from "../../../../src/shared/protocol";

// --------------------------------------------------------------- narrowing

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** A string field that is worth rendering — empty strings are treated as absent. */
export function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

const NO_ITEMS: readonly unknown[] = [];

export function list(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : NO_ITEMS;
}

export function strings(value: unknown): string[] {
	return list(value).filter((entry): entry is string => typeof entry === "string");
}

export function records(value: unknown): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const entry of list(value)) {
		const record = asRecord(entry);
		if (record) out.push(record);
	}
	return out;
}

// ------------------------------------------------------------ call access

/** The freshest envelope: a settled result wins over the rolling partial. */
export function liveResult(call: ToolCallState): AgentToolResult | undefined {
	return call.result ?? call.partialResult;
}

export function detailsOf(call: ToolCallState): Record<string, unknown> | undefined {
	return asRecord(liveResult(call)?.details);
}

const NO_ARGS: Record<string, unknown> = {};

export function argsOf(call: ToolCallState): Record<string, unknown> {
	return call.args ?? NO_ARGS;
}

function isTextBlock(block: unknown): block is TextContent {
	const record = asRecord(block);
	return record?.type === "text" && typeof record.text === "string";
}

function isImageBlock(block: unknown): block is ImageContent {
	const record = asRecord(block);
	return record?.type === "image" && typeof record.data === "string";
}

export function resultText(result: AgentToolResult | undefined): string {
	const blocks = list(result?.content);
	if (blocks.length === 0) return "";
	let out = "";
	for (const block of blocks) {
		if (!isTextBlock(block)) continue;
		out = out.length === 0 ? block.text : `${out}\n${block.text}`;
	}
	return out;
}

const NO_IMAGES: ImageContent[] = [];

export function resultImages(result: AgentToolResult | undefined): ImageContent[] {
	const blocks = list(result?.content);
	if (blocks.length === 0) return NO_IMAGES;
	const images = blocks.filter(isImageBlock);
	return images.length === 0 ? NO_IMAGES : images;
}

export function dataUrl(image: { data: string; mimeType?: string }): string {
	return `data:${image.mimeType ?? "image/png"};base64,${image.data}`;
}

// ------------------------------------------------------------------- meta

export interface Truncation {
	totalLines?: number;
	outputLines?: number;
	totalBytes?: number;
	artifactId?: string;
}

export function metaOf(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return asRecord(details?.meta);
}

/** `meta.truncation` is canonical; `read`/`grep`/`glob` also keep a legacy top-level copy. */
export function truncationOf(details: Record<string, unknown> | undefined): Truncation | undefined {
	const raw = asRecord(metaOf(details)?.truncation) ?? asRecord(details?.truncation);
	if (!raw) return undefined;
	return {
		totalLines: num(raw.totalLines),
		outputLines: num(raw.outputLines),
		totalBytes: num(raw.totalBytes),
		artifactId: text(raw.artifactId),
	};
}

export function diagnosticsOf(
	details: Record<string, unknown> | undefined,
): { summary: string; messages: string[] } | undefined {
	const raw = asRecord(metaOf(details)?.diagnostics) ?? asRecord(details?.diagnostics);
	const summary = text(raw?.summary);
	const messages = strings(raw?.messages);
	if (summary === undefined && messages.length === 0) return undefined;
	return { summary: summary ?? "Diagnostics", messages };
}

/** Limit notices omp appends as prose; re-rendered as a styled warning row instead. */
export function limitNotices(details: Record<string, unknown> | undefined): string[] {
	const limits = asRecord(metaOf(details)?.limits);
	if (!limits) return [];
	const notices: string[] = [];
	const entries: Array<[string, unknown]> = [
		["matches", limits.matchLimit],
		["results", limits.resultLimit],
		["head lines", limits.headLimit],
	];
	for (const [label, value] of entries) {
		const reached = num(asRecord(value)?.reached);
		const suggestion = num(asRecord(value)?.suggestion);
		if (reached === undefined) continue;
		notices.push(
			suggestion === undefined
				? `${reached} ${label} limit reached`
				: `${reached} ${label} limit reached — retry with ${suggestion}`,
		);
	}
	const column = num(asRecord(limits.columnTruncated)?.maxColumn);
	if (column !== undefined) notices.push(`Lines truncated to ${column} columns`);
	return notices;
}

// -------------------------------------------------------- output notices

/**
 * Trailing lines omp appends to the *model-facing* text. The card re-renders
 * their content as styled rows, so showing them verbatim would duplicate them.
 */
const NOTICE_PATTERNS: RegExp[] = [
	/^\[Showing[^\]]*\]$/,
	/^Showing (?:lines )?\d[^\n]*$/,
	/^\[Read artifact:\/\/[^\]]*\]$/,
	/^\[raw output: artifact:\/\/\d+\]$/,
	/^\[?\d+ (?:matches?|results?|head lines?) limit reached[^\n]*$/,
	/^\[?Some lines truncated to [^\n]*$/,
	/^\[?Lines truncated to [^\n]*$/,
	/^Command exited with code -?\d+\.?$/,
	/^Command (?:timed out|was killed)[^\n]*$/,
	/^(?:Timed out|Killed) after \d[^\n]*$/,
	/^Backgrounded as job [^\n]*$/,
	/^Wall(?: time)?[:=][^\n]*$/,
	/^\[Wall:[^\n]*\]$/,
	/^\[Truncated[^\]]*\]$/,
];

const DIAGNOSTICS_HEADER = /^(?:LSP )?Diagnostics \(.*\):?$/;
const ARTIFACT_REFERENCE = /artifact:\/\/([A-Za-z0-9_-]+)/;
const RAW_OUTPUT_FOOTER = /\[raw output: artifact:\/\/(\d+)\]/;

export interface StrippedOutput {
	text: string;
	/** Artifact id recovered from a stripped footer, if the output spilled to disk. */
	artifactId?: string;
}

/**
 * Drop omp's appended notices from the tail of a tool's text output and hand
 * back any `artifact://` id they carried, so the card can offer it as a link.
 */
export function stripOutputNotices(raw: string): StrippedOutput {
	if (raw.length === 0) return { text: "" };
	let artifactId: string | undefined = RAW_OUTPUT_FOOTER.exec(raw)?.[1];

	const lines = raw.split("\n");
	// A trailing diagnostics block runs to the end of the output.
	for (let index = Math.max(0, lines.length - 40); index < lines.length; index++) {
		if (DIAGNOSTICS_HEADER.test((lines[index] ?? "").trim())) {
			lines.length = index;
			break;
		}
	}

	let end = lines.length;
	while (end > 0) {
		const line = (lines[end - 1] ?? "").trim();
		if (line.length === 0) {
			end--;
			continue;
		}
		if (!NOTICE_PATTERNS.some(pattern => pattern.test(line))) break;
		artifactId ??= ARTIFACT_REFERENCE.exec(line)?.[1];
		end--;
	}
	while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) end--;

	return artifactId === undefined
		? { text: lines.slice(0, end).join("\n") }
		: { text: lines.slice(0, end).join("\n"), artifactId };
}

// ------------------------------------------------------------------ lines

export function countLines(value: string): number {
	if (value.length === 0) return 0;
	let count = 1;
	for (let index = 0; index < value.length; index++) {
		if (value.charCodeAt(index) === 10) count++;
	}
	return count;
}

export interface LineWindow {
	text: string;
	/** Lines dropped outside the window. */
	omitted: number;
}

/**
 * Last `count` lines without splitting the whole buffer — a 50 KiB bash tail is
 * re-sent on every streaming update, so the collapsed view must stay O(window).
 */
export function tailLines(value: string, count: number): LineWindow {
	const body = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (body.length === 0) return { text: "", omitted: 0 };
	let cut = body.length;
	for (let taken = 0; taken < count; taken++) {
		const next = body.lastIndexOf("\n", cut - 1);
		if (next < 0) return { text: body, omitted: 0 };
		cut = next;
	}
	return { text: body.slice(cut + 1), omitted: countLines(body.slice(0, cut)) };
}

/** Split into at most `limit` lines; anything past the limit is reported, not built. */
export function splitLines(value: string, limit: number): { lines: string[]; omitted: number } {
	if (value.length === 0) return { lines: [], omitted: 0 };
	const body = value.endsWith("\n") ? value.slice(0, -1) : value;
	const all = body.split("\n");
	if (all.length <= limit) return { lines: all, omitted: 0 };
	return { lines: all.slice(0, limit), omitted: all.length - limit };
}

// ------------------------------------------------------------------ paths

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]|[a-z][a-z0-9+.-]*:\/\/)/;

/** Resolve a display-relative tool path against the search base for `openFile`. */
export function resolvePath(base: string | undefined, relative: string): string {
	if (base === undefined || base.length === 0 || ABSOLUTE_PATH.test(relative)) return relative;
	const separator = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
	return `${base}${separator}${relative}`;
}
