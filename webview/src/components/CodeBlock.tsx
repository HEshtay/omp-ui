import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { post } from "../vscode";
import { Mermaid } from "./Mermaid";

/** Fenced blocks longer than this collapse behind an expander. */
const COLLAPSED_LINES = 28;

/** `split("\n").length` on a 5000-line tool dump allocates; this does not. */
function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;
	return lines;
}

export function CodeBlock({
	language,
	text,
	children,
}: {
	language: string;
	text: string;
	children?: ReactNode;
}): ReactElement {
	const [copied, setCopied] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const copyTimer = useRef(0);

	useEffect(() => {
		return () => clearTimeout(copyTimer.current);
	}, []);

	// remark-rehype terminates the fence body with a newline; that is not a line.
	const code = text.endsWith("\n") ? text.slice(0, -1) : text;
	const lines = useMemo(() => countLines(code), [code]);

	if (language === "mermaid") return <Mermaid source={code} />;

	const clipped = !expanded && lines > COLLAPSED_LINES;
	const hidden = lines - COLLAPSED_LINES;

	const copy = (): void => {
		post({ type: "copyText", text: code });
		setCopied(true);
		clearTimeout(copyTimer.current);
		copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
	};

	return (
		<div className="md-fence">
			{language || code ? (
				<div className="md-fence-head">
					{language ? <span className="md-fence-lang truncate">{language}</span> : null}
					<span className="spacer" />
					{lines > COLLAPSED_LINES ? <span className="faint md-fence-count">{lines} lines</span> : null}
					{code ? (
						<button type="button" className="btn" onClick={copy} aria-label="Copy code">
							{copied ? "Copied" : "Copy"}
						</button>
					) : null}
				</div>
			) : null}
			<pre
				className={clipped ? "md-fence-pre is-clipped" : "md-fence-pre"}
				style={clipped ? { maxHeight: `calc(var(--md-fence-line) * ${COLLAPSED_LINES})` } : undefined}
			>
				{children ?? <code>{code}</code>}
			</pre>
			{lines > COLLAPSED_LINES ? (
				<button type="button" className="btn md-fence-more" onClick={() => setExpanded(!expanded)}>
					{expanded ? "Show less" : `Show ${hidden} more line${hidden === 1 ? "" : "s"}`}
				</button>
			) : null}
		</div>
	);
}
