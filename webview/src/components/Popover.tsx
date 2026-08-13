import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import "./chrome.css";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;
const MIN_HEIGHT = 120;

const FOCUSABLE = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

interface Placement {
	top: number;
	left: number;
	maxHeight: number;
}

interface PopoverProps {
	anchor: HTMLElement | null;
	onClose(): void;
	children: ReactNode;
	align?: "left" | "right";
}

/**
 * A floating panel anchored to a trigger element, portalled to `document.body`
 * so no transcript ancestor can clip or stack it.
 *
 * Placement is measured rather than declared: it prefers below the anchor,
 * flips above when the panel needs more room than the space below, and always
 * clamps to the viewport. Scrolling the page dismisses instead of chasing the
 * anchor — cheaper and less jarring than reprojecting on every frame — but
 * scrolling *inside* the panel is left alone.
 */
export function Popover({ anchor, onClose, children, align = "left" }: PopoverProps): ReactElement | null {
	const panelRef = useRef<HTMLDivElement | null>(null);
	const [placement, setPlacement] = useState<Placement | null>(null);

	// The caller usually passes an inline arrow; keep the listeners stable.
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	const measure = useCallback((): void => {
		const panel = panelRef.current;
		if (!anchor || !panel) return;

		const rect = anchor.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// `scrollHeight` is the unclamped content height, so applying our own
		// `maxHeight` back onto the panel cannot feed the flip decision.
		const needed = panel.scrollHeight + 2;
		const spaceBelow = viewportHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
		const spaceAbove = rect.top - ANCHOR_GAP - VIEWPORT_MARGIN;

		let top: number;
		let maxHeight: number;
		if (needed <= spaceBelow || spaceBelow >= spaceAbove) {
			top = rect.bottom + ANCHOR_GAP;
			maxHeight = Math.max(MIN_HEIGHT, spaceBelow);
		} else {
			maxHeight = Math.max(MIN_HEIGHT, spaceAbove);
			top = Math.max(VIEWPORT_MARGIN, rect.top - ANCHOR_GAP - Math.min(needed, maxHeight));
		}

		const width = panel.offsetWidth;
		const preferred = align === "right" ? rect.right - width : rect.left;
		const left = Math.max(VIEWPORT_MARGIN, Math.min(preferred, viewportWidth - width - VIEWPORT_MARGIN));

		setPlacement(previous =>
			previous && previous.top === top && previous.left === left && previous.maxHeight === maxHeight
				? previous
				: { top, left, maxHeight },
		);
	}, [anchor, align]);

	useLayoutEffect(() => {
		if (!anchor) {
			// Drop the stale placement so the next open measures from scratch.
			setPlacement(previous => (previous === null ? previous : null));
			return;
		}
		measure();

		const panel = panelRef.current;
		if (!panel || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => measure());
		observer.observe(panel);
		return () => observer.disconnect();
	}, [anchor, measure]);

	useEffect(() => {
		if (!anchor) return;

		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			// Swallow it: Escape in the composer means something else entirely.
			event.preventDefault();
			event.stopPropagation();
			closeRef.current();
		};

		const onPointerDown = (event: Event): void => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (panelRef.current?.contains(target)) return;
			// The anchor's own handler toggles; closing here would fight it.
			if (anchor.contains(target)) return;
			closeRef.current();
		};

		const onScroll = (event: Event): void => {
			const target = event.target;
			if (target instanceof Node && panelRef.current?.contains(target)) return;
			closeRef.current();
		};

		const onResize = (): void => measure();

		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
		};
	}, [anchor, measure]);

	useEffect(() => {
		if (!anchor) return;
		const panel = panelRef.current;
		if (!panel) return;

		const first = panel.querySelector<HTMLElement>(FOCUSABLE);
		(first ?? panel).focus({ preventScroll: true });

		return () => {
			// Hand focus back to the trigger, but only if the panel still owns it:
			// closing because the user clicked elsewhere must not steal it back.
			const active = document.activeElement;
			const strayed = active !== null && active !== document.body && !panel.contains(active);
			if (!strayed && anchor.isConnected) anchor.focus({ preventScroll: true });
		};
	}, [anchor]);

	const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "Tab") return;
		const panel = panelRef.current;
		if (!panel) return;

		const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
			element => element.offsetParent !== null || element === document.activeElement,
		);
		const first = items[0];
		const last = items[items.length - 1];
		if (!first || !last) {
			event.preventDefault();
			return;
		}

		const active = document.activeElement;
		if (event.shiftKey && (active === first || active === panel)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || active === panel)) {
			event.preventDefault();
			first.focus();
		}
	};

	if (!anchor) return null;

	return createPortal(
		<div
			ref={panelRef}
			className="popover chrome-popover"
			role="dialog"
			tabIndex={-1}
			onKeyDown={onPanelKeyDown}
			style={
				placement
					? { top: placement.top, left: placement.left, maxHeight: placement.maxHeight }
					: // First paint is a measuring pass: keep it out of sight.
						{ top: 0, left: 0, visibility: "hidden" }
			}
		>
			{children}
		</div>,
		document.body,
	);
}
