import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	ClipboardEvent as ReactClipboardEvent,
	DragEvent as ReactDragEvent,
	KeyboardEvent as ReactKeyboardEvent,
	ReactElement,
} from "react";
import type { DraftState } from "../../../src/shared/bridge";
import type { ImageContent } from "../../../src/shared/protocol";
import { formatBytes } from "../format";
import { registerComposerFocus, store, useUi } from "../store";
import type { UiState } from "../store";
import { post } from "../vscode";
import { SlashMenu, completion, useSlashItems } from "./SlashMenu";
import type { SlashItem } from "./SlashMenu";
import "./composer.css";

/** The host persists the draft across webview disposal; no need to spam it per keystroke. */
const DRAFT_SAVE_DEBOUNCE_MS = 400;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(?:hone|ad|od)/.test(navigator.userAgent);
const MOD_KEY = IS_MAC ? "\u2318" : "Ctrl";

const selectDraft = (state: UiState) => state.draft;
const selectSendKeybinding = (state: UiState) => state.config.sendKeybinding;
const selectAgentStatus = (state: UiState) => state.session.agentStatus;
const selectStatusDetail = (state: UiState) => state.session.statusDetail;
const selectIsStreaming = (state: UiState) => state.session.isStreaming;
const selectIsCompacting = (state: UiState) => state.session.isCompacting;
const selectQueuedCount = (state: UiState) => state.session.queuedMessageCount;

/**
 * Reads through the store rather than the render closure so async callbacks
 * (FileReader, debounced timers) can never resurrect a stale draft.
 */
function patchDraft(patch: Partial<DraftState>): void {
	store.setDraft({ ...store.state.draft, ...patch });
}

async function readImage(file: File): Promise<ImageContent | null> {
	const dataUrl = await new Promise<string | null>(resolve => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
	if (!dataUrl) return null;
	const comma = dataUrl.indexOf(",");
	if (comma < 0) return null;
	const data = dataUrl.slice(comma + 1);
	if (data === "") return null;
	const mimeType = /^data:([^;,]+)/.exec(dataUrl.slice(0, comma))?.[1] ?? file.type;
	return { type: "image", data, mimeType: mimeType || "image/png" };
}

export function Composer(): ReactElement {
	const draft = useUi(selectDraft);
	const sendKeybinding = useUi(selectSendKeybinding);
	const agentStatus = useUi(selectAgentStatus);
	const statusDetail = useUi(selectStatusDetail);
	const isStreaming = useUi(selectIsStreaming);
	const isCompacting = useUi(selectIsCompacting);
	const queuedCount = useUi(selectQueuedCount);

	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	/** Caret to restore after a programmatic edit lands in the DOM. */
	const pendingCaretRef = useRef<number | null>(null);
	const savedDraftRef = useRef<DraftState>(draft);
	const [caret, setCaret] = useState(0);
	const [menuDismissed, setMenuDismissed] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [focused, setFocused] = useState(false);

	const slash = useSlashItems(draft.text, caret);
	// Never surface the menu for a restored draft nobody is editing.
	const menuOpen = focused && slash !== null && !menuDismissed;
	const active = slash ? Math.min(activeIndex, slash.items.length - 1) : 0;

	// The host's "Add Selection to Chat" hops focus here.
	useEffect(() => {
		registerComposerFocus(() => {
			const element = inputRef.current;
			if (!element) return;
			element.focus();
			const end = element.value.length;
			element.setSelectionRange(end, end);
		});
		return () => registerComposerFocus(undefined);
	}, []);

	useLayoutEffect(() => {
		const element = inputRef.current;
		if (!element) return;
		// Auto-grow: collapse first so scrollHeight reports the content height.
		element.style.height = "auto";
		element.style.height = `${element.scrollHeight}px`;

		const pending = pendingCaretRef.current;
		if (pending === null) return;
		pendingCaretRef.current = null;
		element.focus();
		element.setSelectionRange(pending, pending);
		setCaret(pending);
		// Keyed on the draft object, not the string: a completion can reproduce
		// identical text and would otherwise strand `pendingCaretRef`.
	}, [draft]);

	useEffect(() => {
		if (draft === savedDraftRef.current) return;
		const handle = window.setTimeout(() => {
			savedDraftRef.current = draft;
			post({ type: "saveDraft", draft });
		}, DRAFT_SAVE_DEBOUNCE_MS);
		return () => window.clearTimeout(handle);
	}, [draft]);

	const attach = useCallback(async (files: File[]): Promise<void> => {
		const images: ImageContent[] = [];
		for (const file of files) {
			const image = await readImage(file);
			if (image) images.push(image);
			else
				store.apply({
					type: "notify",
					level: "warning",
					message: `Could not read image ${file.name || "from clipboard"}.`,
				});
		}
		if (images.length === 0) return;
		patchDraft({ images: [...store.state.draft.images, ...images] });
	}, []);

	const insertText = useCallback((value: string): void => {
		const element = inputRef.current;
		const text = store.state.draft.text;
		const start = element?.selectionStart ?? text.length;
		const end = element?.selectionEnd ?? text.length;
		pendingCaretRef.current = start + value.length;
		patchDraft({ text: text.slice(0, start) + value + text.slice(end) });
	}, []);

	const canSend =
		agentStatus !== "starting" &&
		agentStatus !== "exited" &&
		agentStatus !== "error" &&
		(draft.text.trim() !== "" || draft.images.length > 0);

	const submit = useCallback(
		(behavior?: "steer" | "followUp"): void => {
			const current = store.state.draft;
			const text = current.text.trim();
			if (text === "" && current.images.length === 0) return;
			const status = store.state.session.agentStatus;
			if (status === "starting" || status === "exited" || status === "error") return;

			post({ type: "submit", text, images: current.images, behavior });

			const empty: DraftState = { text: "", images: [] };
			savedDraftRef.current = empty;
			store.setDraft(empty);
			post({ type: "saveDraft", draft: empty });
			inputRef.current?.focus();
			setCaret(0);
			setMenuDismissed(false);
			setActiveIndex(0);
		},
		[],
	);

	const pick = useCallback(
		(item: SlashItem): void => {
			const context = slash?.context;
			if (!context) return;
			const next = completion(store.state.draft.text, context, item);
			pendingCaretRef.current = next.caret;
			patchDraft({ text: next.text });
			// A command with subcommands re-opens on the next token by itself.
			setMenuDismissed(false);
			setActiveIndex(0);
		},
		[slash],
	);

	function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
		if (event.nativeEvent.isComposing) return;

		if (menuOpen && slash) {
			const count = slash.items.length;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActiveIndex((active + 1) % count);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setActiveIndex((active - 1 + count) % count);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setMenuDismissed(true);
				return;
			}
			const completes = !event.shiftKey && !event.altKey && (event.key === "Tab" || event.key === "Enter");
			if (completes) {
				const item = slash.items[active];
				if (item) {
					event.preventDefault();
					pick(item);
					return;
				}
			}
		}

		if (event.key !== "Enter") return;
		const modified = event.ctrlKey || event.metaKey;
		if (sendKeybinding === "enter") {
			if (!modified && !event.shiftKey && !event.altKey) {
				event.preventDefault();
				submit(isStreaming ? "steer" : undefined);
			} else if (modified) {
				// Chromium does not insert a newline for Ctrl/Cmd+Enter on its own.
				event.preventDefault();
				insertText("\n");
			}
			return;
		}
		if (modified && !event.shiftKey && !event.altKey) {
			event.preventDefault();
			submit(isStreaming ? "steer" : undefined);
		}
	}

	function onPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
		const items = event.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			if (!item || item.kind !== "file" || !item.type.startsWith("image/")) continue;
			const file = item.getAsFile();
			if (file) files.push(file);
		}
		if (files.length === 0) return;
		event.preventDefault();
		void attach(files);
	}

	function onDrop(event: ReactDragEvent<HTMLDivElement>): void {
		const transfer = event.dataTransfer;
		if (!transfer || !transfer.types.includes("Files")) return;
		const files: File[] = [];
		for (let index = 0; index < transfer.files.length; index += 1) {
			const file = transfer.files[index];
			if (file && file.type.startsWith("image/")) files.push(file);
		}
		event.preventDefault();
		setDragging(false);
		if (files.length > 0) void attach(files);
	}

	const blocked =
		agentStatus === "starting"
			? { level: "info" as const, text: "Starting omp\u2026" }
			: agentStatus === "restarting"
				? { level: "info" as const, text: "Restarting omp\u2026" }
				: agentStatus === "exited"
					? { level: "error" as const, text: statusDetail ?? "The omp process exited." }
					: agentStatus === "error"
						? { level: "error" as const, text: statusDetail ?? "The omp process reported an error." }
						: null;

	const sendHint =
		sendKeybinding === "enter" ? "Enter to send \u00b7 Shift+Enter newline" : `${MOD_KEY}+Enter to send`;

	return (
		<div
			className="composer"
			data-dragging={dragging}
			onDragOver={event => {
				if (!event.dataTransfer?.types.includes("Files")) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
				setDragging(true);
			}}
			onDragLeave={event => {
				if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
				setDragging(false);
			}}
			onDrop={onDrop}
		>
			{blocked ? (
				<div className="composer-blocked" data-level={blocked.level}>
					<span className="truncate">{blocked.text}</span>
					{blocked.level === "error" ? (
						<button type="button" className="btn btn-ghost" onClick={() => post({ type: "restartAgent" })}>
							Restart
						</button>
					) : null}
				</div>
			) : null}

			<div className="composer-input-wrap">
				{menuOpen && slash ? (
					<SlashMenu state={slash} activeIndex={active} onPick={pick} onHover={setActiveIndex} />
				) : null}

				{draft.images.length > 0 ? (
					<div className="composer-attachments">
						{draft.images.map((image, index) => (
							<div className="composer-thumb" key={`${index}-${image.data.slice(0, 24)}`}>
								<img src={`data:${image.mimeType};base64,${image.data}`} alt={`Attachment ${index + 1}`} />
								<span className="composer-thumb-size">{formatBytes(Math.floor(image.data.length * 0.75))}</span>
								<button
									type="button"
									className="composer-thumb-remove"
									title="Remove attachment"
									aria-label="Remove attachment"
									onClick={() =>
										patchDraft({ images: store.state.draft.images.filter((_, at) => at !== index) })
									}
								>
									&times;
								</button>
							</div>
						))}
					</div>
				) : null}

				<textarea
					ref={inputRef}
					className="composer-input"
					value={draft.text}
					rows={3}
					spellCheck={false}
					placeholder={isStreaming ? "Steer the current turn\u2026" : "Message omp\u2026  \u00b7  / for commands"}
					aria-label="Message omp"
					aria-autocomplete="list"
					aria-activedescendant={menuOpen ? `slash-item-${active}` : undefined}
					onChange={event => {
						setCaret(event.currentTarget.selectionStart);
						setActiveIndex(0);
						setMenuDismissed(false);
						patchDraft({ text: event.currentTarget.value });
					}}
					onSelect={event => setCaret(event.currentTarget.selectionStart)}
					onFocus={event => {
						setFocused(true);
						setCaret(event.currentTarget.selectionStart);
					}}
					onBlur={() => setFocused(false)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
				/>
			</div>

			<div className="composer-actions">
				<button
					type="button"
					className="icon-btn"
					title="Attach images"
					aria-label="Attach images"
					onClick={() => post({ type: "pickImages" })}
				>
					<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
						<path d="M10.6 4.3 5.9 9a1.6 1.6 0 0 0 2.2 2.2l4.7-4.7a3.2 3.2 0 0 0-4.5-4.5L3.6 6.7a4.7 4.7 0 0 0 6.7 6.7l3.2-3.2" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>

				{queuedCount > 0 ? (
					<span className="chip chip-accent" title="Messages waiting for the current turn">
						{queuedCount} queued
					</span>
				) : null}
				{isCompacting ? <span className="chip chip-warn">compacting</span> : null}

				<span className="spacer" />
				<span className="composer-hint faint truncate">{sendHint}</span>

				{isStreaming ? (
					<button type="button" className="btn btn-danger" onClick={() => post({ type: "abort" })}>
						Stop
					</button>
				) : null}

				{isStreaming ? (
					<span className="composer-send">
						<button
							type="button"
							className="btn btn-primary"
							disabled={!canSend}
							title="Interrupt the current turn with this message"
							onClick={() => submit("steer")}
						>
							Steer
						</button>
						<button
							type="button"
							className="btn btn-primary composer-send-alt"
							disabled={!canSend}
							title="Run this message after the current turn"
							onClick={() => submit("followUp")}
						>
							Queue
						</button>
					</span>
				) : (
					<button type="button" className="btn btn-primary" disabled={!canSend} onClick={() => submit()}>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
