import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import type { DialogAnswer, UiDialog } from "../../../src/shared/bridge";
import type { UiState } from "../store";
import { useUi } from "../store";
import { post } from "../vscode";
import "./dialogs.css";

const selectDialogs = (state: UiState) => state.dialogs;

type Respond = (answer: DialogAnswer) => void;

const KIND: Record<string, string> = {
	select: "Choose",
	confirm: "Confirm",
	input: "Input",
	editor: "Compose",
};

/** omp prefixes a multi-select `select` title with its running tally. */
const MULTI_SELECT_TALLY = /^\((\d+) selected\)\s*/;

/** Reserved label that turns a pick list into a free-text escape hatch. */
const OTHER_OPTION = "Other (type your own)";

/**
 * The one blocking surface in the UI. Every dialog here is an
 * `extension_ui_request` the agent is parked on: it must always be answerable,
 * so Escape is wired at the window and every card carries an explicit way out.
 *
 * Only the head of the queue is shown. A dialog we have already answered stays
 * on screen until either the host closes it or the next one arrives, which
 * keeps the `ask` multi-select loop from flashing the overlay on every toggle.
 */
export function DialogHost(): ReactElement | null {
	const dialogs = useUi(selectDialogs);
	const [answered, setAnswered] = useState<readonly string[]>([]);

	useEffect(() => {
		setAnswered(previous => {
			const next = previous.filter(id => dialogs.some(dialog => dialog.id === id));
			return next.length === previous.length ? previous : next;
		});
	}, [dialogs]);

	const markAnswered = useCallback((id: string) => {
		setAnswered(previous => (previous.includes(id) ? previous : [...previous, id]));
	}, []);

	const pending = dialogs.filter(dialog => !answered.includes(dialog.id));
	const current = pending[0] ?? dialogs[0];
	if (!current) return null;

	return (
		<div className="dialog-overlay">
			<DialogCard
				key={current.id}
				dialog={current}
				queued={Math.max(0, pending.length - 1)}
				sent={answered.includes(current.id)}
				onAnswered={markAnswered}
			/>
		</div>
	);
}

interface DialogCardProps {
	dialog: UiDialog;
	queued: number;
	sent: boolean;
	onAnswered(id: string): void;
}

function DialogCard({ dialog, queued, sent, onAnswered }: DialogCardProps): ReactElement {
	const sentRef = useRef(false);

	const respond = useCallback<Respond>(
		answer => {
			if (sentRef.current) return;
			sentRef.current = true;
			post({ type: "dialogAnswer", id: dialog.id, answer });
			onAnswered(dialog.id);
		},
		[dialog.id, onAnswered],
	);

	// Capture phase at the window: no focus trap or nested handler can swallow
	// the only keystroke that guarantees the agent gets unblocked.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			respond({ kind: "cancelled" });
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [respond]);

	const remaining = useDeadline(dialog, respond);
	const approval = dialog.method === "select" ? dialog.approval : undefined;
	const kind = approval ? "Approval" : (KIND[dialog.method] ?? "Request");

	const classes = ["dialog"];
	if (approval) classes.push("dialog-approval");
	if (sent) classes.push("dialog-sent");

	return (
		<div className={classes.join(" ")} role="dialog" aria-modal="true" aria-label={kind}>
			<div className="dialog-head">
				<span className="dialog-kind">{kind}</span>
				<span className="spacer" />
				{sent ? <span className="spinner" /> : null}
				{remaining !== null ? (
					<span className={remaining <= 10_000 ? "chip chip-err" : "chip"} title="auto-cancels at zero">
						{Math.ceil(remaining / 1000)}s
					</span>
				) : null}
				{queued > 0 ? (
					<span className="chip" title="requests waiting behind this one">
						{queued} more
					</span>
				) : null}
			</div>

			{approval ? (
				<ApprovalBody dialog={dialog} approval={approval} respond={respond} />
			) : dialog.method === "select" ? (
				<SelectBody dialog={dialog} respond={respond} />
			) : dialog.method === "confirm" ? (
				<ConfirmBody dialog={dialog} respond={respond} />
			) : dialog.method === "editor" ? (
				<EditorBody dialog={dialog} respond={respond} />
			) : (
				<InputBody dialog={dialog} respond={respond} />
			)}
		</div>
	);
}

/** Milliseconds left on `dialog.timeout`, or null when it is open-ended. */
function useDeadline(dialog: UiDialog, respond: Respond): number | null {
	const mountedAt = useRef(Date.now()).current;
	const timeout =
		typeof dialog.timeout === "number" && Number.isFinite(dialog.timeout) && dialog.timeout > 0
			? dialog.timeout
			: null;
	const createdAt = typeof dialog.createdAt === "number" && dialog.createdAt > 0 ? dialog.createdAt : mountedAt;
	const deadline = timeout === null ? null : createdAt + timeout;

	const [remaining, setRemaining] = useState<number | null>(() =>
		deadline === null ? null : Math.max(0, deadline - Date.now()),
	);
	const expire = useRef(respond);
	useEffect(() => {
		expire.current = respond;
	}, [respond]);

	useEffect(() => {
		if (deadline === null) return;
		let handle = 0;
		let fired = false;
		const tick = () => {
			const left = deadline - Date.now();
			setRemaining(Math.max(0, left));
			if (left > 0 || fired) return;
			fired = true;
			if (handle !== 0) window.clearInterval(handle);
			expire.current({ kind: "cancelled" });
		};
		tick();
		if (!fired) handle = window.setInterval(tick, 500);
		return () => {
			if (handle !== 0) window.clearInterval(handle);
		};
	}, [deadline]);

	return remaining;
}

interface ApprovalBodyProps {
	dialog: UiDialog;
	approval: NonNullable<UiDialog["approval"]>;
	respond: Respond;
}

function ApprovalBody({ dialog, approval, respond }: ApprovalBodyProps): ReactElement {
	const denyRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		denyRef.current?.focus();
	}, []);

	// Echo the labels omp sent, byte for byte: the server compares with `===`.
	const options = (dialog.options ?? []).filter((option): option is string => typeof option === "string");
	const approveLabel = options.find(option => option.toLowerCase().startsWith("approve")) ?? options[0] ?? "Approve";
	const denyLabel = options.find(option => option !== approveLabel) ?? "Deny";

	// The host parsed these out of the multi-line title; if the parse came back
	// thin, fall back to the raw title rather than showing an empty gate.
	const toolName = typeof approval.toolName === "string" && approval.toolName !== "" ? approval.toolName : "this tool";
	const rawTitle = typeof dialog.title === "string" ? dialog.title : "";
	const detail = typeof approval.detail === "string" && approval.detail.trim() !== "" ? approval.detail : rawTitle;

	return (
		<>
			<div className="dialog-body">
				<div className="dialog-title dialog-title-strong">
					Allow <span className="mono">{toolName}</span>?
				</div>
				{approval.reason ? (
					<div className="dialog-reason">
						<span aria-hidden="true">⚠</span>
						<span>{approval.reason}</span>
					</div>
				) : null}
				{detail !== "" ? <pre className="dialog-detail">{detail}</pre> : null}
			</div>
			<div className="dialog-foot">
				<span className="dialog-hint truncate">Esc denies</span>
				<span className="spacer" />
				<button
					type="button"
					ref={denyRef}
					className="btn btn-danger"
					onClick={() => respond({ kind: "value", value: denyLabel })}
				>
					{denyLabel}
				</button>
				<button
					type="button"
					className="btn btn-primary"
					onClick={() => respond({ kind: "value", value: approveLabel })}
				>
					{approveLabel}
				</button>
			</div>
		</>
	);
}

function SelectBody({ dialog, respond }: { dialog: UiDialog; respond: Respond }): ReactElement {
	const listRef = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(0);

	const options = (dialog.options ?? []).filter((option): option is string => typeof option === "string");
	const rawTitle = typeof dialog.title === "string" ? dialog.title : "";
	const tally = MULTI_SELECT_TALLY.exec(rawTitle);
	const selectedCount = tally ? Number.parseInt(tally[1] ?? "0", 10) : 0;
	const title = tally ? rawTitle.slice(tally[0].length) : rawTitle;

	useEffect(() => {
		listRef.current?.focus();
	}, []);

	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const choose = (index: number) => {
		const option = options[index];
		if (option === undefined) return;
		respond({ kind: "value", value: option });
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (options.length === 0) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				setActive(index => (index + 1) % options.length);
				return;
			case "ArrowUp":
				event.preventDefault();
				setActive(index => (index - 1 + options.length) % options.length);
				return;
			case "Home":
				event.preventDefault();
				setActive(0);
				return;
			case "End":
				event.preventDefault();
				setActive(options.length - 1);
				return;
			case "Enter":
			case " ":
				event.preventDefault();
				choose(active);
				return;
			default:
				if (!/^[1-9]$/.test(event.key)) return;
				event.preventDefault();
				choose(Number.parseInt(event.key, 10) - 1);
		}
	};

	return (
		<>
			<div className="dialog-body">
				{title !== "" ? <div className="dialog-title">{title}</div> : null}
				{selectedCount > 0 ? (
					<div>
						<span className="chip chip-accent">{selectedCount} selected</span>
					</div>
				) : null}
				{options.length === 0 ? (
					<div className="muted">omp sent this question with no options — cancel to release the turn.</div>
				) : (
					<div
						className="dialog-options"
						role="listbox"
						tabIndex={0}
						ref={listRef}
						onKeyDown={onKeyDown}
						aria-activedescendant={`dialog-option-${active}`}
					>
						{options.map((option, index) => {
							const isOther = option === OTHER_OPTION;
							const isDone = option.endsWith("Done selecting");
							const classes = ["dialog-option"];
							if (isOther) classes.push("dialog-option-other");
							if (isDone) classes.push("dialog-option-done");
							return (
								<div
									key={`${index}\u0000${option}`}
									id={`dialog-option-${index}`}
									role="option"
									aria-selected={index === active}
									data-index={index}
									data-active={index === active}
									className={classes.join(" ")}
									onMouseEnter={() => setActive(index)}
									onClick={() => choose(index)}
								>
									<span className="dialog-key" aria-hidden="true">
										{index < 9 ? index + 1 : "·"}
									</span>
									<span className="dialog-option-label">{option}</span>
									{isOther ? <span className="faint">free text</span> : null}
								</div>
							);
						})}
					</div>
				)}
			</div>
			<div className="dialog-foot">
				<span className="dialog-hint truncate">↑↓ move · Enter pick · 1-9 jump · Esc cancel</span>
				<span className="spacer" />
				<button type="button" className="btn btn-ghost" onClick={() => respond({ kind: "cancelled" })}>
					Cancel
				</button>
			</div>
		</>
	);
}

function ConfirmBody({ dialog, respond }: { dialog: UiDialog; respond: Respond }): ReactElement {
	const yesRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		yesRef.current?.focus();
	}, []);

	return (
		<>
			<div className="dialog-body">
				<div className="dialog-title dialog-title-strong">{dialog.title}</div>
				{dialog.message ? <div className="dialog-message">{dialog.message}</div> : null}
			</div>
			<div className="dialog-foot">
				<span className="dialog-hint truncate">Esc cancels</span>
				<span className="spacer" />
				<button
					type="button"
					className="btn btn-ghost"
					onClick={() => respond({ kind: "confirmed", confirmed: false })}
				>
					No
				</button>
				<button
					type="button"
					ref={yesRef}
					className="btn btn-primary"
					onClick={() => respond({ kind: "confirmed", confirmed: true })}
				>
					Yes
				</button>
			</div>
		</>
	);
}

function InputBody({ dialog, respond }: { dialog: UiDialog; respond: Respond }): ReactElement {
	const fieldRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(dialog.prefill ?? "");

	useEffect(() => {
		fieldRef.current?.focus();
		fieldRef.current?.select();
	}, []);

	return (
		<>
			<div className="dialog-body">
				<div className="dialog-title">{dialog.title}</div>
				{dialog.message ? <div className="dialog-message">{dialog.message}</div> : null}
				<input
					ref={fieldRef}
					className="dialog-input"
					value={value}
					placeholder={dialog.placeholder}
					onChange={event => setValue(event.target.value)}
					onKeyDown={event => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						respond({ kind: "value", value });
					}}
				/>
			</div>
			<div className="dialog-foot">
				<span className="dialog-hint truncate">Enter submits · Esc cancels</span>
				<span className="spacer" />
				<button type="button" className="btn btn-ghost" onClick={() => respond({ kind: "cancelled" })}>
					Cancel
				</button>
				<button type="button" className="btn btn-primary" onClick={() => respond({ kind: "value", value })}>
					Submit
				</button>
			</div>
		</>
	);
}

function EditorBody({ dialog, respond }: { dialog: UiDialog; respond: Respond }): ReactElement {
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState(dialog.prefill ?? "");

	useEffect(() => {
		const area = areaRef.current;
		if (!area) return;
		area.focus();
		area.setSelectionRange(area.value.length, area.value.length);
	}, []);

	// A `promptStyle` title carries the question on line one and a pre-rendered
	// ASCII radio list underneath; that list is context, not a heading.
	const rawTitle = typeof dialog.title === "string" ? dialog.title : "";
	const split = dialog.promptStyle === true ? rawTitle.indexOf("\n") : -1;
	const heading = split === -1 ? rawTitle : rawTitle.slice(0, split);
	const context = split === -1 ? "" : rawTitle.slice(split + 1).replace(/\s+$/, "");

	return (
		<>
			<div className="dialog-body">
				<div className={dialog.promptStyle === true ? "dialog-title dialog-title-strong" : "dialog-title"}>
					{heading}
				</div>
				{context !== "" ? <pre className="dialog-preformatted">{context}</pre> : null}
				{dialog.message ? <div className="dialog-message">{dialog.message}</div> : null}
				<textarea
					ref={areaRef}
					className="dialog-textarea"
					value={text}
					placeholder={dialog.placeholder}
					onChange={event => setText(event.target.value)}
					onKeyDown={event => {
						if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
						event.preventDefault();
						respond({ kind: "value", value: text });
					}}
				/>
			</div>
			<div className="dialog-foot">
				<span className="dialog-hint truncate">Ctrl/⌘+Enter submits · Esc cancels</span>
				<span className="spacer" />
				<button type="button" className="btn btn-ghost" onClick={() => respond({ kind: "cancelled" })}>
					Cancel
				</button>
				<button type="button" className="btn btn-primary" onClick={() => respond({ kind: "value", value: text })}>
					Send
				</button>
			</div>
		</>
	);
}
