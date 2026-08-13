/** `bash` — the command card: `$ command` above a rolling output tail. */

import type { ReactNode } from "react";
import { formatDuration, stripAnsi } from "../../format";
import { argsOf, asRecord, bool, detailsOf, liveResult, num, resultText, str, stripOutputNotices, tailLines, text } from "./detail";
import { CodeBlock, Empty, Note, Section, Stats } from "./parts";
import type { ToolBodyProps, ToolRenderer } from "./types";

interface BashView {
	exitCode?: number;
	timedOut: boolean;
	wallTimeMs?: number;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled: boolean;
	terminalId?: string;
	jobId?: string;
	jobState?: string;
}

function bashView(details: Record<string, unknown> | undefined): BashView {
	const async = asRecord(details?.async);
	return {
		exitCode: num(details?.exitCode),
		timedOut: bool(details?.timedOut) === true,
		wallTimeMs: num(details?.wallTimeMs),
		timeoutSeconds: num(details?.timeoutSeconds),
		requestedTimeoutSeconds: num(details?.requestedTimeoutSeconds),
		timeoutDisabled: bool(details?.timeoutDisabled) === true,
		terminalId: text(details?.terminalId),
		jobId: text(async?.jobId),
		jobState: text(async?.state),
	};
}

function commandOf(call: { args?: Record<string, unknown>; partialArgs?: string }): string | undefined {
	const command = str(call.args?.command);
	if (command !== undefined) return command;
	// Args are still streaming: recover whatever of `command` has arrived.
	const partial = call.partialArgs;
	if (partial === undefined) return undefined;
	const match = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partial);
	if (match?.[1] === undefined) return undefined;
	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		return match[1];
	}
}

function envPrefix(args: Record<string, unknown>): string {
	const env = asRecord(args.env);
	if (env === undefined) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== "string") continue;
		parts.push(`${key}=${JSON.stringify(value)}`);
	}
	return parts.length === 0 ? "" : `${parts.join(" ")} `;
}

function BashBody({ call, expanded }: ToolBodyProps) {
	const args = argsOf(call);
	const details = detailsOf(call);
	const view = bashView(details);
	const command = commandOf(call);
	const cwd = text(args.cwd);

	// Every streaming update re-sends the whole rolling tail, so this replaces.
	const stripped = stripOutputNotices(resultText(liveResult(call)));
	const window = tailLines(stripped.text, expanded ? 1200 : 10);
	const output = stripAnsi(window.text);
	const running = call.status === "pending" || call.status === "running";

	const stats: Array<[string, ReactNode]> = [];
	if (view.exitCode !== undefined && view.exitCode !== 0) stats.push(["exit", String(view.exitCode)]);
	if (view.wallTimeMs !== undefined) stats.push(["wall", formatDuration(view.wallTimeMs)]);
	if (view.timeoutDisabled) stats.push(["timeout", "off"]);
	else if (view.timeoutSeconds !== undefined) {
		const requested = view.requestedTimeoutSeconds;
		stats.push([
			"timeout",
			requested !== undefined && requested !== view.timeoutSeconds
				? `${view.timeoutSeconds}s (requested ${requested}s)`
				: `${view.timeoutSeconds}s`,
		]);
	}
	if (view.terminalId !== undefined) stats.push(["terminal", view.terminalId]);

	return (
		<>
			<Section>
				<div className="tool-cmd mono">
					<span className="tool-cmd-prompt">$</span>
					<span className="tool-cmd-text">{`${envPrefix(args)}${command ?? "…"}`}</span>
				</div>
				{cwd !== undefined && <div className="tool-cmd-cwd faint mono">in {cwd}</div>}
			</Section>
			<Section label="Output" meta={window.omitted > 0 ? <span className="faint">…{window.omitted.toLocaleString()} earlier lines</span> : undefined}>
				{output.length === 0 ? (
					<Empty>{running ? "Running…" : "No output."}</Empty>
				) : (
					<CodeBlock text={output} limit={expanded ? 1200 : 10} />
				)}
			</Section>
			{view.timedOut && (
				<Note kind="warn">
					Timed out{view.timeoutSeconds === undefined ? "" : ` after ${view.timeoutSeconds}s`} — the command was killed,
					not failed
				</Note>
			)}
			{view.jobId !== undefined && (
				<Note kind="info">
					Backgrounded as job <span className="mono">{view.jobId}</span>
					{view.jobState === undefined ? "" : ` · ${view.jobState}`}
				</Note>
			)}
			<Stats items={stats} />
		</>
	);
}

export const bashRenderer: ToolRenderer = {
	hideName: true,
	meta: call => {
		const view = bashView(detailsOf(call));
		if (view.timedOut) return <span className="chip chip-warn">timed out</span>;
		if (view.exitCode !== undefined && view.exitCode !== 0) return <span className="chip chip-err">exit {view.exitCode}</span>;
		if (view.jobId !== undefined) return <span className="chip chip-accent">job {view.jobId}</span>;
		return null;
	},
	body: BashBody,
};
