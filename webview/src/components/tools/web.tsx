/** `lsp`, `web_search`, `browser`. */

import { Markdown } from "../Markdown";
import {
	argsOf,
	asRecord,
	dataUrl,
	detailsOf,
	liveResult,
	num,
	records,
	resultText,
	str,
	stripOutputNotices,
	strings,
	text,
} from "./detail";
import { CodeBlock, Empty, ExternalLink, MoreRow, Note, PathLink, Section } from "./parts";
import type { ToolBodyProps, ToolRenderer } from "./types";

// ============================================================================ lsp

function LspBody({ call, expanded }: ToolBodyProps) {
	const stripped = stripOutputNotices(resultText(liveResult(call)));
	if (call.status === "pending" || call.status === "running") return <Empty>Querying language server…</Empty>;
	if (stripped.text.length === 0) return <Empty>No results.</Empty>;
	return <CodeBlock text={stripped.text} limit={expanded ? 600 : 12} />;
}

export const lspRenderer: ToolRenderer = {
	title: call => `LSP ${text(detailsOf(call)?.action) ?? text(argsOf(call).action) ?? ""}`.trim(),
	summary: call => {
		const args = argsOf(call);
		const target = text(args.file) ?? text(args.symbol) ?? text(args.query);
		if (target === undefined) return null;
		const line = num(args.line);
		return text(args.file) === undefined ? (
			<span className="mono truncate">{target}</span>
		) : (
			<PathLink path={target} line={line} label={<span className="mono truncate">{target}</span>} />
		);
	},
	meta: call => {
		const server = text(detailsOf(call)?.serverName);
		return server === undefined ? null : <span className="chip chip-accent">{server}</span>;
	},
	body: LspBody,
};

// ===================================================================== web_search

interface SearchSourceView {
	title: string;
	url: string;
	snippet?: string;
	author?: string;
}

function WebSearchBody({ call, expanded }: ToolBodyProps) {
	const details = detailsOf(call);
	const response = asRecord(details?.response);
	const answer = text(response?.answer);
	const error = text(details?.error);
	const queries = strings(response?.searchQueries);
	const sources: SearchSourceView[] = [];
	for (const entry of records(response?.sources)) {
		const url = text(entry.url);
		if (url === undefined) continue;
		sources.push({
			title: text(entry.title) ?? url,
			url,
			snippet: text(entry.snippet),
			author: text(entry.author),
		});
	}

	if (call.status === "pending" || call.status === "running") return <Empty>Searching the web…</Empty>;

	const shown = sources.slice(0, expanded ? 40 : 3);
	const fallback = answer === undefined ? stripOutputNotices(resultText(liveResult(call))).text : "";

	return (
		<>
			{error !== undefined && <Note kind="error">{error}</Note>}
			{answer !== undefined && (
				<div className="tool-answer">
					<Markdown text={answer} compact />
				</div>
			)}
			{answer === undefined && fallback.length > 0 && <CodeBlock text={fallback} limit={expanded ? 400 : 8} />}
			{queries.length > 0 && (
				<div className="tool-queries">
					{queries.map(query => (
						<span className="chip" key={query}>
							{query}
						</span>
					))}
				</div>
			)}
			{shown.length > 0 && (
				<Section label={`${sources.length} source${sources.length === 1 ? "" : "s"}`}>
					<div className="tool-sources">
						{shown.map(source => (
							<div className="tool-source" key={source.url}>
								<ExternalLink url={source.url} label={<span className="tool-source-title">{source.title}</span>} />
								<div className="tool-source-url faint mono truncate">{source.url}</div>
								{source.snippet !== undefined && <div className="tool-source-snippet muted">{source.snippet}</div>}
								{source.author !== undefined && <div className="faint">{source.author}</div>}
							</div>
						))}
					</div>
					<MoreRow count={sources.length - shown.length} label="more sources" />
				</Section>
			)}
			{answer === undefined && sources.length === 0 && error === undefined && fallback.length === 0 && (
				<Empty>No results.</Empty>
			)}
		</>
	);
}

export const webSearchRenderer: ToolRenderer = {
	title: () => "Web search",
	summary: call => {
		const query = text(argsOf(call).query);
		return query === undefined ? null : <span className="truncate">{query}</span>;
	},
	meta: call => {
		const provider = text(asRecord(detailsOf(call)?.response)?.provider);
		return provider === undefined || provider === "none" ? null : <span className="chip">{provider}</span>;
	},
	body: WebSearchBody,
};

// ======================================================================== browser

interface ScreenshotView {
	key: string;
	src?: string;
	path?: string;
}

function screenshots(details: Record<string, unknown> | undefined): ScreenshotView[] {
	const out: ScreenshotView[] = [];
	for (const [index, entry] of records(details?.screenshots).entries()) {
		const data = str(entry.data);
		const mimeType = text(entry.mimeType) ?? "image/png";
		const path = text(entry.path);
		if (data !== undefined && data.length > 0) out.push({ key: `s${index}`, src: dataUrl({ data, mimeType }) });
		else if (path !== undefined) out.push({ key: `s${index}`, path });
	}
	return out;
}

function BrowserBody({ call, expanded }: ToolBodyProps) {
	const args = argsOf(call);
	const details = detailsOf(call);
	const code = str(args.code);
	const result = text(details?.result);
	const observation = asRecord(details?.observation);
	const title = text(observation?.title);
	const shots = screenshots(details);
	const stripped = stripOutputNotices(resultText(liveResult(call)));

	return (
		<>
			{code !== undefined && code.length > 0 && (
				<Section label="Code">
					<CodeBlock text={code} limit={expanded ? 400 : 10} />
				</Section>
			)}
			{title !== undefined && <div className="tool-kv faint truncate">{title}</div>}
			{result !== undefined && (
				<Section label="Result">
					<CodeBlock text={result} limit={expanded ? 400 : 8} />
				</Section>
			)}
			{result === undefined && stripped.text.length > 0 && (
				<CodeBlock text={stripped.text} limit={expanded ? 400 : 8} />
			)}
			{shots.length > 0 && (
				<div className="tool-images">
					{shots.map(shot =>
						shot.src === undefined ? (
							<PathLink key={shot.key} path={shot.path ?? ""} label={<span className="mono">{shot.path}</span>} />
						) : (
							<img className="tool-image" key={shot.key} src={shot.src} alt="Browser screenshot" />
						),
					)}
				</div>
			)}
			{code === undefined && result === undefined && shots.length === 0 && stripped.text.length === 0 && (
				<Empty>{call.status === "running" ? "Driving the browser…" : "No output."}</Empty>
			)}
		</>
	);
}

export const browserRenderer: ToolRenderer = {
	title: call => `Browser ${text(detailsOf(call)?.action) ?? text(argsOf(call).action) ?? ""}`.trim(),
	summary: call => {
		const url = text(detailsOf(call)?.url) ?? text(argsOf(call).url);
		return url === undefined ? null : <ExternalLink url={url} label={<span className="mono truncate">{url}</span>} />;
	},
	meta: call => {
		const name = text(detailsOf(call)?.name);
		return name === undefined || name === "main" ? null : <span className="chip">{name}</span>;
	},
	body: BrowserBody,
};
