/** Display formatting shared across the webview. */

export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return "?";
	const absolute = Math.abs(value);
	if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
	if (absolute >= 1_000) return `${(value / 1_000).toFixed(absolute >= 10_000 ? 0 : 1)}K`;
	return String(Math.round(value));
}

export function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "?";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

export function formatCost(usd: number | undefined): string {
	if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return "";
	return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatRelativeTime(timestamp: number): string {
	const delta = Date.now() - timestamp;
	if (delta < 60_000) return "just now";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
	return `${Math.floor(delta / 86_400_000)}d ago`;
}

export type ContextLevel = "normal" | "warning" | "purple" | "error";

/**
 * omp escalates on whichever of percent or absolute tokens trips first, so a
 * million-token window still warns at 150K instead of waiting for 50%.
 */
function reachesThreshold(
	percent: number,
	contextWindow: number,
	percentThreshold: number,
	tokenThreshold: number,
): boolean {
	if (!Number.isFinite(percent) || percent <= 0) return false;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return percent >= percentThreshold;
	return percent >= Math.min(percentThreshold, (tokenThreshold / contextWindow) * 100);
}

export function contextLevel(percent: number, contextWindow: number): ContextLevel {
	if (reachesThreshold(percent, contextWindow, 90, 500_000)) return "error";
	if (reachesThreshold(percent, contextWindow, 70, 270_000)) return "purple";
	if (reachesThreshold(percent, contextWindow, 50, 150_000)) return "warning";
	return "normal";
}

/**
 * `42.0%/200K` when the window is known, `12.4K/?` when it is not — never
 * `0.0%/0`, which would read as an empty context rather than missing metadata.
 */
export function formatContextUsage(percent: number | undefined, contextWindow: number, usedTokens: number): string {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return `${formatNumber(usedTokens)}/?`;
	return `${percent === undefined ? "?" : percent.toFixed(1)}%/${formatNumber(contextWindow)}`;
}

/** Last path segment, tolerant of both separators. */
export function basename(filePath: string): string {
	const normalized = filePath.replace(/[\\/]+$/, "");
	const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	return index < 0 ? normalized : normalized.slice(index + 1);
}

/** Shorten a long path to `…/tail/segments` for a header line. */
export function shortenPath(filePath: string, segments = 3): string {
	const parts = filePath.split(/[\\/]/).filter(Boolean);
	if (parts.length <= segments) return filePath;
	return `…/${parts.slice(-segments).join("/")}`;
}

export function languageFromPath(filePath: string): string {
	const extension = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
	const byExtension: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		mjs: "javascript",
		cjs: "javascript",
		json: "json",
		md: "markdown",
		py: "python",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		rb: "ruby",
		php: "php",
		cs: "csharp",
		c: "c",
		h: "c",
		cpp: "cpp",
		hpp: "cpp",
		css: "css",
		scss: "scss",
		html: "html",
		xml: "xml",
		yml: "yaml",
		yaml: "yaml",
		toml: "toml",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		ps1: "powershell",
		sql: "sql",
	};
	return byExtension[extension] ?? "";
}

/**
 * Strip C0 control characters and ANSI SGR sequences.
 *
 * Tool output and widget lines come from a terminal-oriented producer; escape
 * sequences would render as mojibake in HTML.
 */
export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point.
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}
