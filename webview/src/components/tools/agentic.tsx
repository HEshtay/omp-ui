/** `task` — the subagent fan-out panel — and `todo` — the phase/task tree. */

import type { ReactNode } from "react";
import { contextLevel, formatCost, formatDuration, formatNumber } from "../../format";
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
	str,
	stripOutputNotices,
	text,
} from "./detail";
import { CodeBlock, Empty, MoreRow, Note } from "./parts";
import type { ToolBodyProps, ToolRenderer } from "./types";

// =========================================================================== task

type AgentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

interface AgentRow {
	key: string;
	id?: string;
	agent: string;
	name?: string;
	status: AgentStatus;
	task?: string;
	lastIntent?: string;
	currentTool?: string;
	toolCount?: number;
	/** Lifetime billing counter — NOT comparable to `contextWindow`. */
	tokens?: number;
	contextTokens?: number;
	contextWindow?: number;
	cost?: number;
	durationMs?: number;
	model?: string;
	error?: string;
	retry?: { attempt: number; maxAttempts?: number; message?: string };
	nested: AgentRow[];
}

const AGENT_STATUSES: AgentStatus[] = ["pending", "running", "completed", "failed", "aborted"];

function agentStatus(value: unknown): AgentStatus | undefined {
	const raw = str(value);
	return raw !== undefined && AGENT_STATUSES.includes(raw as AgentStatus) ? (raw as AgentStatus) : undefined;
}

function progressRow(record: Record<string, unknown>, prefix: string, depth: number): AgentRow {
	const retry = asRecord(record.retryState) ?? asRecord(record.retryFailure);
	const attempt = num(retry?.attempt);
	const nestedDetails = asRecord(record.inflightTaskDetails);
	return {
		key: `${prefix}${text(record.id) ?? num(record.index) ?? prefix}`,
		id: text(record.id),
		agent: text(record.agent) ?? "agent",
		name: text(record.name) ?? text(record.description),
		status: agentStatus(record.status) ?? "running",
		task: text(record.task) ?? text(record.assignment),
		lastIntent: text(record.lastIntent),
		currentTool: text(record.currentTool),
		toolCount: num(record.toolCount),
		tokens: num(record.tokens),
		contextTokens: num(record.contextTokens),
		contextWindow: num(record.contextWindow),
		cost: num(record.cost),
		durationMs: num(record.durationMs),
		model: text(record.resolvedModel),
		error: text(record.error),
		retry: attempt === undefined ? undefined : { attempt, maxAttempts: num(retry?.maxAttempts), message: text(retry?.errorMessage) },
		nested: depth >= 2 ? [] : agentRows(nestedDetails, `${prefix}n`, depth + 1),
	};
}

function resultRow(record: Record<string, unknown>, prefix: string): AgentRow {
	const exitCode = num(record.exitCode);
	const error = text(record.error);
	const aborted = bool(record.aborted) === true;
	return {
		key: `${prefix}${text(record.id) ?? num(record.index) ?? prefix}`,
		id: text(record.id),
		agent: text(record.agent) ?? "agent",
		name: text(record.name) ?? text(record.description),
		status: aborted ? "aborted" : error !== undefined || (exitCode !== undefined && exitCode !== 0) ? "failed" : "completed",
		task: text(record.task) ?? text(record.assignment),
		lastIntent: text(record.lastIntent),
		toolCount: undefined,
		tokens: num(record.tokens),
		contextTokens: num(record.contextTokens),
		contextWindow: num(record.contextWindow),
		cost: num(asRecord(asRecord(record.usage)?.cost)?.total),
		durationMs: num(record.durationMs),
		model: text(record.resolvedModel),
		error: error ?? text(record.abortReason),
		retry: undefined,
		nested: [],
	};
}

/** Live `progress[]` wins over settled `results[]` while the fan-out is in flight. */
function agentRows(details: Record<string, unknown> | undefined, prefix = "a", depth = 0): AgentRow[] {
	if (details === undefined) return [];
	const progress = records(details.progress);
	if (progress.length > 0) return progress.map((entry, index) => progressRow(entry, `${prefix}${index}-`, depth));
	return records(details.results).map((entry, index) => resultRow(entry, `${prefix}${index}-`));
}

const STATUS_CHIP: Record<AgentStatus, string> = {
	pending: "chip",
	running: "chip chip-accent",
	completed: "chip chip-ok",
	failed: "chip chip-err",
	aborted: "chip chip-warn",
};

function ContextGauge({ used, window }: { used: number; window: number }) {
	const percent = Math.min(100, Math.max(0, (used / window) * 100));
	return (
		<span className={`tool-gauge tool-gauge-${contextLevel(percent, window)}`} title={`${formatNumber(used)} / ${formatNumber(window)} context tokens`}>
			<span className="tool-gauge-fill" style={{ width: `${percent.toFixed(1)}%` }} />
			<span className="tool-gauge-label mono">{percent.toFixed(0)}%</span>
		</span>
	);
}

function AgentRowView({ row, depth }: { row: AgentRow; depth: number }) {
	const stats: ReactNode[] = [];
	if (row.toolCount !== undefined && row.toolCount > 0) stats.push(<span key="tools">{row.toolCount} tools</span>);
	if (row.tokens !== undefined && row.tokens > 0) stats.push(<span key="tokens">{formatNumber(row.tokens)} tok</span>);
	const cost = formatCost(row.cost);
	if (cost.length > 0) stats.push(<span key="cost">{cost}</span>);
	const duration = formatDuration(row.durationMs);
	if (duration.length > 0) stats.push(<span key="time">{duration}</span>);

	return (
		<div className="tool-agent" style={depth > 0 ? { marginLeft: `${depth * 14}px` } : undefined}>
			<div className="tool-agent-head row">
				<span className={STATUS_CHIP[row.status]}>{row.status}</span>
				<span className="tool-agent-name mono truncate">{row.name ?? row.agent}</span>
				{row.name !== undefined && <span className="faint mono">{row.agent}</span>}
				<span className="spacer" />
				{row.contextTokens !== undefined && row.contextWindow !== undefined && row.contextWindow > 0 && (
					<ContextGauge used={row.contextTokens} window={row.contextWindow} />
				)}
				<span className="tool-agent-stats faint mono">{stats}</span>
			</div>
			{(row.currentTool !== undefined || row.lastIntent !== undefined) && (
				<div className="tool-agent-activity faint truncate">
					{row.currentTool !== undefined && <span className="mono tool-agent-tool">{row.currentTool}</span>}
					{row.lastIntent !== undefined && <span>{row.lastIntent}</span>}
				</div>
			)}
			{row.task !== undefined && row.currentTool === undefined && row.lastIntent === undefined && (
				<div className="tool-agent-activity faint truncate">{row.task}</div>
			)}
			{row.retry !== undefined && (
				<Note kind="warn">
					Retry {row.retry.attempt}
					{row.retry.maxAttempts === undefined ? "" : `/${row.retry.maxAttempts}`}
					{row.retry.message === undefined ? "" : ` — ${row.retry.message}`}
				</Note>
			)}
			{row.error !== undefined && <Note kind="error">{row.error}</Note>}
			{row.id !== undefined && row.status !== "pending" && (
				<div className="tool-agent-links">
					<button
						type="button"
						className="tool-link"
						onClick={() => post({ type: "openArtifact", url: `agent://${row.id ?? ""}` })}
					>
						output
					</button>
					<button
						type="button"
						className="tool-link"
						onClick={() => post({ type: "openArtifact", url: `history://${row.id ?? ""}` })}
					>
						transcript
					</button>
				</div>
			)}
			{row.nested.map(nested => (
				<AgentRowView key={nested.key} row={nested} depth={depth + 1} />
			))}
		</div>
	);
}

function TaskBody({ call, expanded }: ToolBodyProps) {
	const details = detailsOf(call);
	const rows = agentRows(details);
	const limit = expanded ? 64 : 8;

	if (rows.length === 0) {
		if (call.status === "pending" || call.status === "running") return <Empty>Spawning subagents…</Empty>;
		const stripped = stripOutputNotices(resultText(liveResult(call)));
		return stripped.text.length === 0 ? <Empty>No subagent output.</Empty> : <CodeBlock text={stripped.text} limit={40} />;
	}

	const shown = rows.slice(0, limit);
	const async = asRecord(details?.async);
	const jobId = text(async?.jobId);
	return (
		<>
			{jobId !== undefined && (
				<Note kind="info">
					Running in background as job <span className="mono">{jobId}</span>
				</Note>
			)}
			<div className="tool-agents">
				{shown.map(row => (
					<AgentRowView key={row.key} row={row} depth={0} />
				))}
			</div>
			<MoreRow count={rows.length - shown.length} label="more subagents" />
		</>
	);
}

export const taskRenderer: ToolRenderer = {
	title: () => "Task",
	summary: call => {
		const rows = agentRows(detailsOf(call));
		if (rows.length === 0) {
			const args = argsOf(call);
			const single = text(args.name) ?? text(args.agent);
			const batch = records(args.tasks).length;
			if (batch > 0) return <span className="mono">{batch} subagents</span>;
			return single === undefined ? null : <span className="mono">{single}</span>;
		}
		const names = rows.map(row => row.name ?? row.agent);
		return <span className="mono truncate">{names.slice(0, 4).join(", ")}{names.length > 4 ? ` +${names.length - 4}` : ""}</span>;
	},
	meta: call => {
		const rows = agentRows(detailsOf(call));
		if (rows.length === 0) return null;
		const done = rows.filter(row => row.status === "completed").length;
		const failed = rows.filter(row => row.status === "failed" || row.status === "aborted").length;
		return (
			<>
				<span className="chip chip-ok">{done}/{rows.length}</span>
				{failed > 0 && <span className="chip chip-err">{failed} failed</span>}
			</>
		);
	},
	body: TaskBody,
};

// =========================================================================== todo

type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

interface TodoTask {
	content: string;
	status: TodoStatus;
	blocker?: string;
}

interface TodoPhaseView {
	name: string;
	tasks: TodoTask[];
}

const TODO_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "abandoned", "blocked"];

const TODO_GLYPH: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "▸",
	completed: "✓",
	abandoned: "✗",
	blocked: "⏸",
};

function todoPhases(details: Record<string, unknown> | undefined): TodoPhaseView[] {
	return records(details?.phases).map(phase => ({
		name: text(phase.name) ?? "Tasks",
		tasks: records(phase.tasks).map(task => {
			const status = str(task.status);
			return {
				content: text(task.content) ?? "",
				status: status !== undefined && TODO_STATUSES.includes(status as TodoStatus) ? (status as TodoStatus) : "pending",
				blocker: text(task.blocker),
			};
		}),
	}));
}

function TodoBody({ call, expanded }: ToolBodyProps) {
	const details = detailsOf(call);
	const phases = todoPhases(details);
	const failed = liveResult(call)?.isError === true;
	const budget = expanded ? Number.MAX_SAFE_INTEGER : 8;

	if (phases.length === 0) {
		const stripped = stripOutputNotices(resultText(liveResult(call)));
		return stripped.text.length === 0 ? <Empty>No todos.</Empty> : <CodeBlock text={stripped.text} limit={20} />;
	}

	let remaining = budget;
	let hidden = 0;
	for (const phase of phases) hidden += phase.tasks.length;
	hidden = Math.max(0, hidden - budget);

	return (
		<>
			{failed && <Note kind="error">{stripOutputNotices(resultText(liveResult(call))).text || "Todo update rejected."}</Note>}
			<div className="tool-todo">
				{phases.map(phase => {
					const take = Math.max(0, Math.min(remaining, phase.tasks.length));
					remaining -= take;
					if (take === 0 && phase.tasks.length > 0) return null;
					return (
						<div className="tool-todo-phase" key={phase.name}>
							<div className="tool-todo-phase-name">{phase.name}</div>
							{phase.tasks.slice(0, take).map((task, index) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: task text is not unique within a phase.
									key={`${task.content}:${index}`}
									className={`tool-todo-task tool-todo-${task.status}`}
								>
									<span className="tool-todo-glyph">{TODO_GLYPH[task.status]}</span>
									<span className="tool-todo-text">
										{task.content}
										{task.status === "blocked" && task.blocker !== undefined && (
											<span className="tool-todo-blocker"> (blocked: {task.blocker})</span>
										)}
									</span>
								</div>
							))}
						</div>
					);
				})}
			</div>
			<MoreRow count={hidden} label="more tasks" />
		</>
	);
}

export const todoRenderer: ToolRenderer = {
	title: () => "Todo",
	summary: call => {
		const phases = todoPhases(detailsOf(call));
		if (phases.length === 0) return null;
		let total = 0;
		let done = 0;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				total++;
				if (task.status === "completed") done++;
			}
		}
		if (total === 0) return null;
		const op = text(detailsOf(call)?.op);
		return (
			<span className="row tool-summary-row">
				{op !== undefined && <span className="chip">{op}</span>}
				<span className="mono">
					{done}/{total} done
				</span>
			</span>
		);
	},
	body: TodoBody,
};
