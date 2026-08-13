import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { SubagentState } from "../../../src/shared/chat-model";
import { contextLevel, formatCost, formatDuration, formatNumber } from "../format";
import type { UiState } from "../store";
import { useUi } from "../store";
import { post } from "../vscode";
import "./panels.css";

const selectSubagents = (state: UiState) => state.subagents;

const STATUS_CHIP: Record<string, string> = {
	running: "chip chip-accent",
	completed: "chip chip-ok",
	failed: "chip chip-err",
	aborted: "chip chip-warn",
	pending: "chip",
};

const SETTLED: Record<string, true> = { completed: true, failed: true, aborted: true };

interface Node {
	agent: SubagentState;
	children: Node[];
}

/**
 * Group agents under the parent whose id matches their `parentToolCallId`.
 * Dangling and self/cyclic parents fall back to the root list — a fan-out is
 * far more useful rendered flat than silently dropped.
 */
function buildTree(agents: readonly SubagentState[]): Node[] {
	const byId = new Map<string, SubagentState>();
	for (const agent of agents) {
		if (agent && typeof agent.id === "string" && agent.id !== "") byId.set(agent.id, agent);
	}

	const parentOf = new Map<string, string>();
	for (const agent of byId.values()) {
		const parentId = agent.parentToolCallId;
		if (typeof parentId !== "string" || parentId === agent.id || !byId.has(parentId)) continue;
		parentOf.set(agent.id, parentId);
	}
	for (const id of [...parentOf.keys()]) {
		let cursor = parentOf.get(id);
		for (let hops = 0; cursor !== undefined && hops <= byId.size; hops++) {
			if (cursor === id) {
				parentOf.delete(id);
				break;
			}
			cursor = parentOf.get(cursor);
		}
	}

	const nodes = new Map<string, Node>();
	for (const agent of byId.values()) nodes.set(agent.id, { agent, children: [] });

	const roots: Node[] = [];
	for (const node of nodes.values()) {
		const parentId = parentOf.get(node.agent.id);
		const parent = parentId === undefined ? undefined : nodes.get(parentId);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	const sortDeep = (list: Node[]): void => {
		list.sort((a, b) => (a.agent.index ?? 0) - (b.agent.index ?? 0));
		for (const node of list) sortDeep(node.children);
	};
	sortDeep(roots);
	return roots;
}

export function SubagentPanel(): ReactElement | null {
	const subagents = useUi(selectSubagents);
	const [expanded, setExpanded] = useState(false);
	const roots = useMemo(() => buildTree(subagents), [subagents]);

	if (subagents.length === 0) return null;

	let running = 0;
	let queued = 0;
	let failed = 0;
	for (const agent of subagents) {
		if (agent.status === "running") running++;
		else if (agent.status === "pending") queued++;
		else if (agent.status === "failed") failed++;
	}

	return (
		<section className="panel subagent-panel" aria-label="Subagents">
			<button
				type="button"
				className="panel-head"
				aria-expanded={expanded}
				onClick={() => setExpanded(value => !value)}
			>
				<span className="panel-caret" data-open={expanded} aria-hidden="true">
					▶
				</span>
				<span className="panel-title">Agents</span>
				<span className="faint">
					{subagents.length} agent{subagents.length === 1 ? "" : "s"}
				</span>
				{running > 0 ? (
					<>
						<span className="faint">·</span>
						<span className="spinner" />
						<span className="muted">{running} running</span>
					</>
				) : null}
				{queued > 0 ? (
					<>
						<span className="faint">·</span>
						<span className="muted">{queued} queued</span>
					</>
				) : null}
				<span className="spacer" />
				{failed > 0 ? <span className="chip chip-err">{failed} failed</span> : null}
			</button>

			{expanded ? (
				<div className="panel-body">
					<ul className="sub-list">
						{roots.map(node => (
							<AgentRow key={node.agent.id} node={node} />
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

function AgentRow({ node }: { node: Node }): ReactElement {
	const agent = node.agent;
	const sessionFile = typeof agent.sessionFile === "string" && agent.sessionFile !== "" ? agent.sessionFile : null;
	const dim = SETTLED[agent.status] === true;

	const budget = typeof agent.contextWindow === "number" && agent.contextWindow > 0 ? agent.contextWindow : 0;
	const used = typeof agent.contextTokens === "number" && agent.contextTokens > 0 ? agent.contextTokens : 0;
	const percent = budget > 0 ? Math.min(100, (used / budget) * 100) : null;

	const toolCount = typeof agent.toolCount === "number" && agent.toolCount > 0 ? agent.toolCount : 0;
	const cost = formatCost(agent.cost);
	const elapsed = formatDuration(agent.durationMs);
	const detail = agent.description ?? agent.task ?? agent.lastIntent;

	const body = (
		<>
			<span className="sub-index">#{Number.isFinite(agent.index) ? agent.index : "?"}</span>
			<span className="sub-name truncate">{agent.agent || "agent"}</span>
			<span className={STATUS_CHIP[agent.status] ?? "chip"}>
				{agent.status === "running" ? <span className="spinner" /> : null}
				{agent.status}
			</span>
			{agent.currentTool ? <span className="sub-tool truncate">{agent.currentTool}</span> : <span className="spacer" />}
			<span className="sub-meta">
				{toolCount > 0 ? <span title={`${toolCount} tool calls`}>{toolCount}⚒</span> : null}
				{percent !== null ? (
					<span
						className="sub-gauge"
						data-level={contextLevel(percent, budget)}
						title={`context ${formatNumber(used)}/${formatNumber(budget)}`}
					>
						<i style={{ width: `${percent}%` }} />
					</span>
				) : null}
				{cost !== "" ? <span>{cost}</span> : null}
				{elapsed !== "" ? <span>{elapsed}</span> : null}
			</span>
		</>
	);

	return (
		<li>
			{sessionFile === null ? (
				<div className="sub-row" data-dim={dim} title={detail}>
					{body}
				</div>
			) : (
				<button
					type="button"
					className="sub-row"
					data-dim={dim}
					title={detail ? `${detail}\nClick to open transcript` : "Click to open transcript"}
					onClick={() => post({ type: "revealSubagent", sessionFile })}
				>
					{body}
				</button>
			)}
			{node.children.length > 0 ? (
				<ul className="sub-children">
					{node.children.map(child => (
						<AgentRow key={child.agent.id} node={child} />
					))}
				</ul>
			) : null}
		</li>
	);
}
