import { useEffect } from "react";
import type { ReactElement } from "react";
import type { Toast, UiState } from "../store";
import { store, useUi } from "../store";
import "./dialogs.css";

const selectToasts = (state: UiState) => state.toasts;

const MARK: Record<string, string> = {
	info: "•",
	warning: "!",
	error: "✕",
};

/** Info notices expire on their own; anything louder waits to be acknowledged. */
const INFO_TTL_MS = 6000;

export function Toasts(): ReactElement | null {
	const toasts = useUi(selectToasts);
	if (toasts.length === 0) return null;

	return (
		<div className="toasts toasts-scroll">
			{toasts.map(toast => (
				<ToastRow key={toast.id} toast={toast} />
			))}
		</div>
	);
}

function ToastRow({ toast }: { toast: Toast }): ReactElement {
	useEffect(() => {
		if (toast.level !== "info") return;
		const handle = window.setTimeout(() => store.dismissToast(toast.id), INFO_TTL_MS);
		return () => window.clearTimeout(handle);
	}, [toast.id, toast.level]);

	return (
		<div className={`toast toast-${toast.level}`} role={toast.level === "error" ? "alert" : "status"}>
			<span className="toast-mark" data-level={toast.level} aria-hidden="true">
				{MARK[toast.level] ?? "•"}
			</span>
			<div className="toast-body">{toast.message}</div>
			<button
				type="button"
				className="icon-btn toast-close"
				title="Dismiss"
				aria-label="Dismiss notification"
				onClick={() => store.dismissToast(toast.id)}
			>
				✕
			</button>
		</div>
	);
}
