/** The fallback card: any tool without a dedicated renderer, and any renderer that threw. */

import { argsOf, liveResult, resultText, stripOutputNotices, tailLines } from "./detail";
import { CodeBlock, Empty, MoreRow, Section } from "./parts";
import type { ToolBodyProps, ToolRenderer } from "./types";

/** `path="src/app.ts" limit=20` — a scalar-only preview of what the tool was asked to do. */
export function argumentSummary(args: Record<string, unknown>, max = 3): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key === "i" || key.startsWith("__")) continue;
		if (parts.length >= max) break;
		if (typeof value === "string") {
			const clipped = value.length > 60 ? `${value.slice(0, 60)}…` : value;
			parts.push(`${key}=${JSON.stringify(clipped)}`);
		} else if (typeof value === "number" || typeof value === "boolean") {
			parts.push(`${key}=${String(value)}`);
		} else if (Array.isArray(value)) {
			parts.push(`${key}[${value.length}]`);
		} else if (value !== null && value !== undefined) {
			parts.push(`${key}{…}`);
		}
	}
	return parts.join(" ");
}

function stringifyArgs(args: Record<string, unknown>): string {
	const printable: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (key.startsWith("__")) continue;
		printable[key] = value;
	}
	try {
		return JSON.stringify(printable, null, 2) ?? "";
	} catch {
		// Cyclic or otherwise unserialisable args still deserve a key list.
		return Object.keys(printable).join(", ");
	}
}

export function GenericBody({ call, expanded }: ToolBodyProps) {
	const args = argsOf(call);
	const stripped = stripOutputNotices(resultText(liveResult(call)));
	const window = expanded ? { text: stripped.text, omitted: 0 } : tailLines(stripped.text, 4);
	const hasArgs = Object.keys(args).some(key => key !== "i" && !key.startsWith("__"));
	const streamingArgs = call.args === undefined && call.partialArgs !== undefined;

	if (!hasArgs && !streamingArgs && stripped.text.length === 0) return <Empty>No output.</Empty>;

	return (
		<>
			{expanded && hasArgs && (
				<Section label="Arguments">
					<CodeBlock text={stringifyArgs(args)} limit={200} />
				</Section>
			)}
			{!expanded && hasArgs && <div className="tool-arg-preview faint mono truncate">{argumentSummary(args, 6)}</div>}
			{streamingArgs && (
				<Section label="Arguments">
					<CodeBlock text={call.partialArgs ?? ""} limit={40} />
				</Section>
			)}
			{stripped.text.length > 0 && (
				<Section label="Output">
					{window.omitted > 0 && <MoreRow count={window.omitted} label="earlier lines" />}
					<CodeBlock text={window.text} limit={expanded ? 2000 : 8} />
				</Section>
			)}
		</>
	);
}

export const genericRenderer: ToolRenderer = {
	summary: call => {
		const summary = argumentSummary(argsOf(call));
		return summary.length === 0 ? null : <span className="mono truncate">{summary}</span>;
	},
	body: GenericBody,
};
