import "katex/dist/katex.min.css";
import "./markdown.css";

import type { Element, ElementContent } from "hast";
import { Component, memo } from "react";
import type { ComponentProps, MouseEvent, ReactElement, ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components, ExtraProps, UrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import { post } from "../vscode";
import { CodeBlock } from "./CodeBlock";

/*
 * Every constant below is module scope on purpose. `Markdown` re-renders on
 * every streaming delta of the message it belongs to, and a fresh plugin array
 * or component map would rebuild the unified processor on each of those.
 */

const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath];

function classNames(node: Element): string[] {
	// @types/hast declares `className` as a string array, but the runtime value
	// can also be a raw string, so read it as unknown before narrowing.
	const raw: unknown = node.properties?.className;
	if (Array.isArray(raw)) return raw.map(String);
	return typeof raw === "string" ? raw.split(/\s+/) : [];
}

/**
 * remark-math only treats a multi-line `$$` fence as display math, so a model
 * that writes a whole equation on one `$$…$$` line gets it rendered inline and
 * visually squashed. Promote the case that is unambiguously an equation of its
 * own — a paragraph containing nothing but one inline-math span — and leave
 * mid-sentence `$$x$$` alone, where inline is what the author meant.
 *
 * This runs in hast rather than mdast because rehype-katex keys off the
 * `math-inline`/`math-display` class names, not the mdast node type.
 */
function rehypeLoneDisplayMath() {
	const promote = (node: Element): void => {
		for (const child of node.children) {
			if (child.type === "element") promote(child);
		}
		if (node.tagName !== "p") return;
		const meaningful = node.children.filter(
			child => child.type !== "text" || child.value.trim().length > 0,
		);
		const only = meaningful[0];
		if (meaningful.length !== 1 || only?.type !== "element") return;
		if (!classNames(only).includes("math-inline")) return;
		// A display span may not sit inside a `<p>`; KaTeX's display wrapper is
		// block-level, so the paragraph becomes the container.
		node.tagName = "div";
		only.properties = { ...only.properties, className: ["math", "math-display"] };
	};

	return (tree: { children: ElementContent[] }): void => {
		for (const child of tree.children) {
			if (child.type === "element") promote(child);
		}
	};
}

const REHYPE_PLUGINS: PluggableList = [
	rehypeLoneDisplayMath,
	// Half-written `$…` mid-stream is normal, so never throw on it; KaTeX marks
	// the offending source instead.
	[rehypeKatex, { throwOnError: false, strict: "ignore", errorColor: "#f05653" }],
	// `detect: false` (the default): guessing the language of an unlabelled
	// fence is both slow and usually wrong.
	rehypeHighlight,
];

const LANGUAGE_PREFIX = "language-";

/** `https:` for real images, `data:image/*` for inline ones. Nothing else. */
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;/i;
const HTTPS_URL = /^https:\/\//i;
const EXTERNAL_URL = /^https?:\/\//i;

/**
 * react-markdown's default transform drops `data:` URLs, which we want for
 * inline images (the host CSP allows `data:` and `https:` for `img-src`).
 */
const urlTransform: UrlTransform = (url, key, node) => {
	if (key === "src" && node.tagName === "img" && DATA_IMAGE.test(url)) return url;
	return defaultUrlTransform(url) ?? "";
};

function collectText(node: ElementContent, out: string[]): void {
	if (node.type === "text") {
		out.push(node.value);
		return;
	}
	if (node.type === "element") {
		for (const child of node.children) collectText(child, out);
	}
}

function childElement(node: Element | undefined, tagName: string): Element | undefined {
	if (!node) return undefined;
	for (const child of node.children) {
		if (child.type === "element" && child.tagName === tagName) return child;
	}
	return undefined;
}

/**
 * Fence language, read off the `language-*` class remark-rehype writes. `hast`
 * types `className` as an array, but a rehype plugin can leave a raw string
 * there, so accept both.
 */
function fenceLanguage(node: Element | undefined): string {
	const value: unknown = node?.properties["className"];
	const tokens = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
	for (const token of tokens) {
		const name = String(token);
		if (name.startsWith(LANGUAGE_PREFIX)) return name.slice(LANGUAGE_PREFIX.length);
	}
	return "";
}

/**
 * Fenced blocks arrive as `<pre><code>`. We take over the `pre` so `CodeBlock`
 * owns the chrome, while the already-highlighted `code` element is passed
 * through as children — re-rendering it ourselves would throw away
 * rehype-highlight's spans.
 */
function Fence({ node, children }: ComponentProps<"pre"> & ExtraProps): ReactElement {
	const code = childElement(node, "code");
	const parts: string[] = [];
	if (code) collectText(code, parts);
	return (
		<CodeBlock language={fenceLanguage(code)} text={parts.join("")}>
			{children}
		</CodeBlock>
	);
}

/**
 * Inline code gets its chip from CSS (`:not(pre) > code`) rather than a prop:
 * react-markdown 10 no longer tells the renderer whether it is inline, and the
 * structural selector cannot be fooled by a fence with no language.
 */
function Code({ className, children }: ComponentProps<"code"> & ExtraProps): ReactElement {
	return <code className={className ? `md-code ${className}` : "md-code"}>{children}</code>;
}

/** The webview must never navigate away: hand every real link to the host. */
function Anchor({ href, title, children }: ComponentProps<"a"> & ExtraProps): ReactElement {
	if (typeof href !== "string") return <span>{children}</span>;
	// Fragments stay in-document — that is how GFM footnotes jump back and forth.
	if (href.startsWith("#")) {
		return (
			<a href={href} title={title}>
				{children}
			</a>
		);
	}
	if (!EXTERNAL_URL.test(href)) return <span>{children}</span>;
	const open = (event: MouseEvent<HTMLAnchorElement>): void => {
		event.preventDefault();
		post({ type: "openExternal", url: href });
	};
	return (
		<a href={href} title={title ?? href} onClick={open}>
			{children}
		</a>
	);
}

/** omp keeps tables square while everything else is rounded. */
function Table({ children }: ComponentProps<"table"> & ExtraProps): ReactElement {
	return (
		<div className="md-table-wrap">
			<table className="md-table">{children}</table>
		</div>
	);
}

function Image({ src, alt, title }: ComponentProps<"img"> & ExtraProps): ReactElement | null {
	const url = typeof src === "string" ? src : "";
	if (!HTTPS_URL.test(url) && !DATA_IMAGE.test(url)) {
		return alt ? <span className="faint">{alt}</span> : null;
	}
	return <img className="md-img" src={url} alt={alt ?? ""} title={title} loading="lazy" />;
}

const COMPONENTS: Components = {
	a: Anchor,
	code: Code,
	img: Image,
	pre: Fence,
	table: Table,
};

interface BoundaryProps {
	text: string;
	children: ReactNode;
}

/**
 * A malformed payload must never blank the transcript, so a throw anywhere in
 * the markdown pipeline degrades to the raw source. The next delta clears the
 * failure, which is why this compares `text` instead of remounting on a key.
 */
class MarkdownBoundary extends Component<BoundaryProps, { failed: boolean }> {
	constructor(props: BoundaryProps) {
		super(props);
		this.state = { failed: false };
	}

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override componentDidUpdate(previous: BoundaryProps): void {
		if (this.state.failed && previous.text !== this.props.text) this.setState({ failed: false });
	}

	override render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		return (
			<>
				<pre className="md-plain-pre">{this.props.text}</pre>
				<div className="faint">markdown failed to render</div>
			</>
		);
	}
}

/** Memoized: this is the hottest component in the app. */
export const Markdown = memo(function Markdown({
	text,
	compact,
}: {
	text: string;
	compact?: boolean;
}): ReactElement {
	if (text.length === 0) return <></>;
	return (
		<div className={compact ? "md md-compact" : "md"}>
			<MarkdownBoundary text={text}>
				<ReactMarkdown
					remarkPlugins={REMARK_PLUGINS}
					rehypePlugins={REHYPE_PLUGINS}
					components={COMPONENTS}
					urlTransform={urlTransform}
				>
					{text}
				</ReactMarkdown>
			</MarkdownBoundary>
		</div>
	);
});
