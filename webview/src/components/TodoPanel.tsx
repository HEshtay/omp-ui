import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { TodoItem, TodoPhase, TodoStatus } from "../../../src/shared/protocol";
import type { UiState } from "../store";
import { useUi } from "../store";
import "./panels.css";

const selectTodoPhases = (state: UiState) => state.chat.todoPhases;

/** Indexed loosely: the wire can carry a status this build has never heard of. */
const BOX: Record<string, string> = {
	pending: "☐",
	in_progress: "☐",
	completed: "☑",
	abandoned: "☒",
	blocked: "⊘",
};

const STRUCK: Record<string, true> = { completed: true, abandoned: true };

function tasksOf(phase: TodoPhase | undefined): TodoItem[] {
	if (!phase || !Array.isArray(phase.tasks)) return [];
	return phase.tasks.filter((task): task is TodoItem => typeof task?.content === "string");
}

interface Summary {
	total: number;
	done: number;
	blocked: number;
	/** Content of the first in-progress task, for the collapsed one-liner. */
	current: string;
}

function summarize(phases: readonly TodoPhase[]): Summary {
	let total = 0;
	let done = 0;
	let blocked = 0;
	let current = "";
	for (const phase of phases) {
		for (const task of tasksOf(phase)) {
			total++;
			if (task.status === "completed") done++;
			else if (task.status === "blocked") blocked++;
			else if (task.status === "in_progress" && current === "") current = task.content;
		}
	}
	return { total, done, blocked, current };
}

export function TodoPanel(): ReactElement | null {
	const phases = useUi(selectTodoPhases);
	const [collapsed, setCollapsed] = useState(false);
	const summary = useMemo(() => summarize(phases), [phases]);

	if (summary.total === 0) return null;

	const percent = Math.round((summary.done / summary.total) * 100);
	const multi = phases.length > 1;

	return (
		<section className="panel todo-panel" aria-label="Tasks">
			<button
				type="button"
				className="panel-head"
				aria-expanded={!collapsed}
				onClick={() => setCollapsed(value => !value)}
			>
				<span className="panel-caret" data-open={!collapsed} aria-hidden="true">
					▶
				</span>
				<span className="panel-title">Tasks</span>
				<span className="panel-progress" title={`${percent}% complete`}>
					<i style={{ width: `${percent}%` }} />
				</span>
				<span className="faint">
					{summary.done}/{summary.total} done
				</span>
				{collapsed && summary.current !== "" ? (
					<span className="truncate todo-current">{summary.current}</span>
				) : null}
				<span className="spacer" />
				{summary.blocked > 0 ? <span className="chip chip-warn">{summary.blocked} blocked</span> : null}
			</button>

			{collapsed ? null : (
				<div className="panel-body">
					{phases.map(phase => (
						<PhaseBlock key={phase.name} phase={phase} showName={multi} />
					))}
				</div>
			)}
		</section>
	);
}

interface PhaseBlockProps {
	phase: TodoPhase;
	showName: boolean;
}

/**
 * One phase. Memoised on task contents rather than object identity: the host
 * resends the whole phase array on every todo write, so without this a single
 * task flipping would re-render every row in a long plan.
 */
const PhaseBlock = memo(function PhaseBlock({ phase, showName }: PhaseBlockProps): ReactElement | null {
	const [override, setOverride] = useState<boolean | null>(null);
	const tasks = tasksOf(phase);

	if (tasks.length === 0) return null;

	let done = 0;
	let untouched = true;
	for (const task of tasks) {
		if (task.status === "completed") done++;
		if (task.status !== "pending") untouched = false;
	}

	// Phases nobody has started yet stay folded to one line until touched.
	const open = override ?? (showName ? !untouched : true);

	return (
		<div className="todo-phase">
			{showName ? (
				<button
					type="button"
					className="todo-phase-head"
					aria-expanded={open}
					onClick={() => setOverride(!open)}
				>
					<span className="panel-caret" data-open={open} aria-hidden="true">
						▶
					</span>
					<span className="todo-phase-name truncate">{phase.name}</span>
					<span className="faint">
						{done}/{tasks.length}
					</span>
				</button>
			) : null}
			{open ? (
				<ul className="todo-list">
					{tasks.map(task => (
						<TodoRow key={`${phase.name}\u0000${task.content}`} task={task} />
					))}
				</ul>
			) : null}
		</div>
	);
}, samePhase);

function samePhase(previous: PhaseBlockProps, next: PhaseBlockProps): boolean {
	if (previous.showName !== next.showName) return false;
	if (previous.phase === next.phase) return true;
	if (previous.phase.name !== next.phase.name) return false;
	const before = tasksOf(previous.phase);
	const after = tasksOf(next.phase);
	if (before.length !== after.length) return false;
	for (let index = 0; index < before.length; index++) {
		const a = before[index];
		const b = after[index];
		if (a?.content !== b?.content || a?.status !== b?.status || a?.blocker !== b?.blocker) return false;
	}
	return true;
}

function TodoRow({ task }: { task: TodoItem }): ReactElement {
	const previousStatus = useRef<TodoStatus | undefined>(undefined);
	const [strikeIn, setStrikeIn] = useState(false);

	// Only tasks that settle while we are watching get the animated strike;
	// ones that were already done when the panel mounted render struck.
	useEffect(() => {
		const before = previousStatus.current;
		previousStatus.current = task.status;
		if (task.status !== "completed") setStrikeIn(false);
		else if (before !== undefined && before !== "completed") setStrikeIn(true);
	}, [task.status]);

	const struck = STRUCK[task.status] === true;
	const classes = ["todo-item"];
	if (struck) classes.push("todo-struck");
	if (strikeIn) classes.push("todo-strike-in");

	return (
		<li className={classes.join(" ")} data-status={task.status}>
			<span className={task.status === "in_progress" ? "todo-box pulse" : "todo-box"} aria-hidden="true">
				{BOX[task.status] ?? "☐"}
			</span>
			<span className="todo-text">
				{task.content}
				{task.status === "blocked" && task.blocker ? (
					<span className="todo-blocker"> (blocked: {task.blocker})</span>
				) : null}
			</span>
		</li>
	);
}
