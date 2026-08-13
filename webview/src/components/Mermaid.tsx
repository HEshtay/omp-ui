import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { post } from "../vscode";

/** Let a streaming fence settle before paying for a render. */
const SETTLE_MS = 150;

let sequence = 0;

/**
 * mermaid is heavy and its layout engines are synchronous, so a 20-diagram
 * fan-out rendering at once would lock the frame. One at a time instead.
 */
let queue: Promise<unknown> = Promise.resolve();

function isLightTheme(): boolean {
	const classes = document.body.classList;
	return classes.contains("vscode-light") || classes.contains("vscode-high-contrast-light");
}

export function Mermaid({ source }: { source: string }): ReactElement {
	const [light, setLight] = useState(isLightTheme);
	const [svg, setSvg] = useState("");
	const [failed, setFailed] = useState(false);
	const [copied, setCopied] = useState(false);
	const frame = useRef<HTMLDivElement | null>(null);
	const copyTimer = useRef(0);

	useEffect(() => {
		return () => clearTimeout(copyTimer.current);
	}, []);

	// VS Code swaps the theme class on <body> in place, so the diagram palette
	// has to follow it rather than being decided once at mount.
	useEffect(() => {
		const observer = new MutationObserver(() => setLight(isLightTheme()));
		observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let live = true;
		const id = `omp-mermaid-${++sequence}`;

		const settle = window.setTimeout(() => {
			const render = async (): Promise<void> => {
				if (!live) return;
				try {
					// Dynamic so mermaid stays out of the main chunk: most sessions
					// never render a diagram at all.
					const { default: mermaid } = await import("mermaid");
					if (!live) return;
					const body = getComputedStyle(document.body);
					mermaid.initialize({
						startOnLoad: false,
						theme: light ? "default" : "dark",
						securityLevel: "strict",
						suppressErrorRendering: true,
						fontFamily: body.fontFamily || "sans-serif",
						fontSize: Number.parseFloat(body.fontSize) || 13,
					});
					const result = await mermaid.render(id, source);
					if (!live) return;
					setSvg(result.svg);
					setFailed(false);
				} catch {
					if (!live) return;
					setSvg("");
					setFailed(true);
				} finally {
					// `render` builds its scratch nodes in the document and leaves
					// them behind when it throws.
					document.getElementById(id)?.remove();
					document.getElementById(`d${id}`)?.remove();
				}
			};
			queue = queue.then(render, render);
		}, SETTLE_MS);

		return () => {
			live = false;
			clearTimeout(settle);
		};
	}, [source, light]);

	// A diagram scaled down to the sidebar's width is often unreadable, so both
	// escape hatches are always one click away: the source, or a full-size tab.
	const copy = (): void => {
		post({ type: "copyText", text: source });
		setCopied(true);
		clearTimeout(copyTimer.current);
		copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
	};

	// The image preview has no theme, so the diagram has to carry its own
	// backdrop: the frame's inset colour, or the editor background when the
	// frame has not painted one.
	const open = (): void => {
		const painted = frame.current ? getComputedStyle(frame.current).backgroundColor : "";
		const background = painted && !painted.endsWith(", 0)") ? painted : getComputedStyle(document.body).backgroundColor;
		post({ type: "openDiagram", source, svg, background });
	};

	const head = (
		<div className="md-fence-head">
			<span className="md-fence-lang truncate">mermaid</span>
			<span className="spacer" />
			<button type="button" className="btn" onClick={copy} aria-label="Copy diagram source">
				{copied ? "Copied" : "Copy"}
			</button>
			<button
				type="button"
				className="btn"
				onClick={open}
				title="Open the diagram full size in an editor tab"
			>
				Open
			</button>
		</div>
	);

	if (failed) {
		return (
			<div className="md-mermaid-failed">
				{head}
				<pre className="md-plain-pre">{source}</pre>
				<div className="faint">diagram failed to render</div>
			</div>
		);
	}

	if (!svg) {
		return (
			<div className="md-mermaid-pending muted">
				<span className="spinner" />
				rendering diagram…
			</div>
		);
	}

	return (
		<div className="md-mermaid" ref={frame}>
			{head}
			{/* The one sanctioned `dangerouslySetInnerHTML` in the webview: this
			    markup is mermaid's own output, not model or tool text. */}
			<div className="md-mermaid-body" dangerouslySetInnerHTML={{ __html: svg }} />
		</div>
	);
}
