import { useEffect, useState } from "react";
import type { ReactElement } from "react";

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

	if (failed) {
		return (
			<div className="md-mermaid-failed">
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

	// The one sanctioned `dangerouslySetInnerHTML` in the webview: this markup is
	// mermaid's own output, not model or tool text.
	return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
