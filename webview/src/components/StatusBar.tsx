import { useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Model, ThinkingLevel } from "../../../src/shared/protocol";
import { contextLevel, formatContextUsage, formatNumber } from "../format";
import { post } from "../vscode";
import { useUi } from "../store";
import type { UiState } from "../store";
import { Popover } from "./Popover";
import "./chrome.css";

const selectSession = (state: UiState) => state.session;
const selectModels = (state: UiState) => state.models;

/** `inherit` is not part of the cycle: it is what you get, never what you pick. */
const THINKING_CYCLE: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const THINKING_LABEL: Record<ThinkingLevel, string> = {
	inherit: "auto",
	off: "off",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "high",
	xhigh: "xhi",
	max: "max",
};

/** Wire values are `unknown` in practice; a bad number must not paint a bar. */
function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * omp's status line, rebuilt as chips.
 *
 * Every segment is responsible for its own silence: a segment with no value
 * renders nothing rather than a zero, so the strip stays short until the
 * session actually has something to report.
 */
export function StatusBar(): ReactElement {
	const session = useUi(selectSession);
	const models = useUi(selectModels);

	const [picker, setPicker] = useState<"model" | null>(null);
	const modelRef = useRef<HTMLButtonElement | null>(null);

	const groups = useMemo(() => {
		const byProvider = new Map<string, Model[]>();
		for (const model of models) {
			const provider = typeof model.provider === "string" && model.provider.length > 0 ? model.provider : "other";
			const bucket = byProvider.get(provider);
			if (bucket) bucket.push(model);
			else byProvider.set(provider, [model]);
		}
		return Array.from(byProvider, ([provider, entries]) => ({ provider, entries })).sort((a, b) =>
			a.provider.localeCompare(b.provider),
		);
	}, [models]);

	const model = session.model;
	const hasModelSegment = model !== undefined || models.length > 0;

	const thinking = session.thinkingLevel;
	const thinkingIndex = thinking === undefined ? -1 : THINKING_CYCLE.indexOf(thinking);
	const nextThinking = THINKING_CYCLE[(thinkingIndex + 1) % THINKING_CYCLE.length] ?? "off";

	const usage = session.contextUsage;
	const usedTokens = finite(usage?.tokens);
	const contextWindow = finite(usage?.contextWindow);
	const rawPercent = finite(usage?.percent);
	const percent = usage !== undefined && rawPercent > 0 ? rawPercent : undefined;
	const showContext = usage !== undefined && (usedTokens > 0 || percent !== undefined);
	const level = contextLevel(percent ?? 0, contextWindow);

	const tokensPerSecond = session.tokensPerSecond;
	const showThroughput = tokensPerSecond !== null && Number.isFinite(tokensPerSecond) && tokensPerSecond > 0;

	// `fastModeEnabled` is the session setting; `fastModeActive` is what the
	// provider actually does with it. They disagree legitimately — a provider can
	// refuse fast mode, or run at priority regardless — so the chip shows the
	// effective state and the tooltip carries the discrepancy.
	const fastMismatch = session.fastModeEnabled !== session.fastModeActive;
	const fastTitle = fastMismatch
		? session.fastModeEnabled
			? "Fast mode is on for this session, but the provider is not applying it. Click to turn off."
			: "Fast mode is off for this session, but the provider is serving requests at priority. Click to turn on."
		: session.fastModeActive
			? "Fast mode on — click to turn off."
			: "Fast mode off — click to turn on.";

	const shortId = session.sessionId === undefined ? "" : session.sessionId.slice(0, 8);

	return (
		<footer className="status-bar">
			{hasModelSegment ? (
				<>
					<button
						type="button"
						className="chip chip-btn status-model"
						title={model ? `${model.provider}/${model.id} — click to switch model` : "Select a model"}
						aria-haspopup="dialog"
						aria-expanded={picker === "model"}
						ref={modelRef}
						onClick={() => setPicker(picker === "model" ? null : "model")}
					>
						<span className="status-model-id">{model ? `${model.provider}/${model.id}` : "select model"}</span>
					</button>
					<button
						type="button"
						className="chip chip-btn status-think"
						data-on={thinking !== undefined && thinking !== "off" && thinking !== "inherit"}
						title={`Thinking: ${thinking === undefined ? "inherited" : thinking} — click for ${nextThinking}`}
						onClick={() => post({ type: "setThinkingLevel", level: nextThinking })}
					>
						{THINKING_LABEL[thinking ?? "inherit"]}
					</button>
				</>
			) : null}

			{showContext ? (
				<button
					type="button"
					className="chip chip-btn status-ctx"
					data-level={level}
					title={`Context: ${formatNumber(usedTokens)} tokens${
						contextWindow > 0 ? ` of ${formatNumber(contextWindow)}` : ""
					} — auto-compaction ${session.autoCompactionEnabled ? "on, click to disable" : "off, click to enable"}`}
					onClick={() => post({ type: "setAutoCompaction", enabled: !session.autoCompactionEnabled })}
				>
					<span>{formatContextUsage(percent, contextWindow, usedTokens)}</span>
					{percent === undefined ? null : (
						<span className="status-ctx-track" aria-hidden="true">
							<span className="status-ctx-fill" style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
						</span>
					)}
					{session.autoCompactionEnabled ? <span className="status-ctx-auto">auto</span> : null}
				</button>
			) : null}

			{showThroughput ? <span className="chip mono">{tokensPerSecond.toFixed(1)} tok/s</span> : null}

			<button
				type="button"
				className={`chip chip-btn status-fast${session.fastModeActive ? " chip-accent" : ""}`}
				data-mismatch={fastMismatch}
				title={fastTitle}
				aria-pressed={session.fastModeEnabled}
				onClick={() => post({ type: "setFastMode", enabled: !session.fastModeEnabled })}
			>
				fast
			</button>

			{shortId ? (
				<button
					type="button"
					className="chip chip-btn status-id"
					title={`Session ${session.sessionId} — click to copy`}
					onClick={() => post({ type: "copyText", text: session.sessionId ?? "" })}
				>
					{shortId}
				</button>
			) : null}

			<span className="spacer" />

			{session.workspaceName ? (
				<span className="status-workspace truncate" title={session.cwd || session.workspaceName}>
					{session.workspaceName}
				</span>
			) : null}

			<Popover anchor={picker === "model" ? modelRef.current : null} onClose={() => setPicker(null)}>
				{groups.length === 0 ? (
					<div className="popover-empty">No models reported by omp.</div>
				) : (
					groups.map(group => (
						<div key={group.provider}>
							<div className="popover-group">{group.provider}</div>
							{group.entries.map((entry, index) => {
								const contextSize = finite(entry.contextWindow);
								return (
									<button
										type="button"
										key={`${group.provider}/${entry.id}/${index}`}
										className="popover-item"
										data-active={model !== undefined && model.id === entry.id && model.provider === entry.provider}
										onClick={() => {
											setPicker(null);
											post({ type: "setModel", provider: entry.provider, modelId: entry.id });
										}}
									>
										<span className="popover-item-title">
											<span className="model-item-name popover-item-text">{entry.name || entry.id}</span>
											{contextSize > 0 ? <span className="popover-meta">{formatNumber(contextSize)} ctx</span> : null}
										</span>
										<span className="model-item-id">{entry.id}</span>
									</button>
								);
							})}
						</div>
					))
				)}
			</Popover>
		</footer>
	);
}
