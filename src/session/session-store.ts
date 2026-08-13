import { open, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { SessionListEntry } from "../shared/bridge";
import { isRecord } from "../shared/guards";

/**
 * omp exposes no session-listing RPC command, so the extension enumerates the
 * on-disk transcripts itself.
 *
 * The layout mirrors `pi-coding-agent/src/session/session-paths.ts` and
 * `session-listing.ts`. Note the shipped docs describe a hashed bucket scheme
 * that the runtime does not use — the real scheme is the path-based one below.
 */

const PREFIX_BYTES = 4096;
const SUFFIX_BYTES = 32_768;

export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR;
	if (agentDir) return path.join(agentDir, "sessions");
	if (process.platform === "linux" && env.XDG_DATA_HOME) {
		// XDG flattens the `agent/` segment.
		return path.join(env.XDG_DATA_HOME, "omp", "sessions");
	}
	return path.join(homedir(), env.PI_CONFIG_DIR ?? ".omp", "agent", "sessions");
}

/**
 * Map a workspace directory to its session bucket name.
 *
 * Paths under `$HOME` and the temp root become relative, dash-separated names;
 * everything else is wrapped in `--…--`. `:` is part of the substitution class,
 * so a Windows drive letter contributes two dashes.
 */
export function encodeSessionDirName(cwd: string): string {
	const resolved = path.resolve(cwd);
	const home = path.resolve(homedir());
	const temp = path.resolve(tmpdir());

	const homeRelative = path.relative(home, resolved);
	if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
		return joinBucket("-", homeRelative);
	}

	const tempRelative = path.relative(temp, resolved);
	if (tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))) {
		return joinBucket("-tmp", tempRelative);
	}

	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function joinBucket(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	if (!encoded) return prefix;
	return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}

export function sessionDirFor(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	return path.join(sessionsRoot(env), encodeSessionDirName(cwd));
}

/** Session names are model/user text: keep the first line, drop control chars. */
function sanitizeName(value: string | undefined): string {
	if (!value) return "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0/DEL is the point.
	return (value.split("\n", 1)[0] ?? "").replace(/[\x00-\x1F\x7F]/g, "").trim();
}

interface ScanResult {
	id: string;
	title?: string;
	created: number;
	messageCount: number;
	firstMessage: string;
	status: SessionListEntry["status"];
}

function parseLines(text: string): unknown[] {
	const entries: unknown[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		// A byte-window cut lands mid-line; only complete JSON objects are usable.
		if (!trimmed.startsWith("{")) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// Partial trailing line.
		}
	}
	return entries;
}

function statusFromTail(entries: unknown[]): SessionListEntry["status"] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		switch (message.role) {
			case "assistant": {
				if (message.stopReason === "error") return "error";
				if (message.stopReason === "aborted") return "aborted";
				if (message.stopReason === "length") return "interrupted";
				const content = message.content;
				if (Array.isArray(content) && content.some(block => isRecord(block) && block.type === "toolCall")) {
					return "interrupted";
				}
				return "complete";
			}
			case "toolResult":
				return "interrupted";
			case "user":
				return "pending";
			default:
				return "unknown";
		}
	}
	return "unknown";
}

async function scanSessionFile(file: string, size: number): Promise<ScanResult | undefined> {
	const handle = await open(file, "r");
	try {
		const prefix = Buffer.alloc(Math.min(PREFIX_BYTES, size));
		await handle.read(prefix, 0, prefix.byteLength, 0);
		const prefixEntries = parseLines(prefix.toString("utf8"));

		let id = "";
		let title: string | undefined;
		let created = 0;
		let firstMessage = "";
		let messageCount = 0;

		for (const entry of prefixEntries) {
			if (!isRecord(entry)) continue;
			if (entry.type === "title" && typeof entry.title === "string") {
				// An explicitly empty slot means "deliberately untitled".
				title = entry.title.length > 0 ? entry.title : undefined;
				continue;
			}
			if (entry.type === "session") {
				if (typeof entry.id === "string") id = entry.id;
				if (title === undefined && typeof entry.title === "string") title = entry.title;
				if (typeof entry.timestamp === "string") created = Date.parse(entry.timestamp);
				continue;
			}
			if (entry.type === "message" && isRecord(entry.message)) {
				messageCount++;
				if (!firstMessage) {
					const message = entry.message;
					if (message.role === "user" || message.role === "developer" || message.role === "assistant") {
						const text = flattenContent(message.content);
						if (text) firstMessage = text;
					}
				}
			}
		}

		if (!id) return undefined;

		const tailStart = Math.max(0, size - SUFFIX_BYTES);
		const tail = Buffer.alloc(size - tailStart);
		if (tail.byteLength > 0) await handle.read(tail, 0, tail.byteLength, tailStart);
		const status = statusFromTail(parseLines(tail.toString("utf8")));

		return { id, title, created, messageCount, firstMessage, status };
	} finally {
		await handle.close();
	}
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			return block.text;
		}
	}
	return "";
}

export interface ListSessionsOptions {
	cwd: string;
	currentSessionFile?: string;
	limit?: number;
	env?: NodeJS.ProcessEnv;
}

/** Newest-first list of the workspace's saved sessions. */
export async function listSessions(options: ListSessionsOptions): Promise<SessionListEntry[]> {
	const dir = sessionDirFor(options.cwd, options.env ?? process.env);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}

	const candidates = names.filter(name => name.endsWith(".jsonl"));
	const stats = await Promise.all(
		candidates.map(async name => {
			const file = path.join(dir, name);
			try {
				const info = await stat(file);
				return info.isFile() ? { file, size: info.size, modified: info.mtimeMs } : undefined;
			} catch {
				return undefined;
			}
		}),
	);

	const found = stats.filter((entry): entry is { file: string; size: number; modified: number } => entry !== undefined);
	found.sort((left, right) => right.modified - left.modified);
	const window = options.limit ? found.slice(0, options.limit) : found;

	const scanned = await Promise.all(
		window.map(async entry => {
			try {
				const result = await scanSessionFile(entry.file, entry.size);
				if (!result) return undefined;
				const name =
					sanitizeName(result.title) ||
					sanitizeName(result.firstMessage) ||
					`Untitled · ${new Date(result.created || entry.modified).toLocaleTimeString(undefined, {
						hour: "2-digit",
						minute: "2-digit",
					})}`;
				const listed: SessionListEntry = {
					path: entry.file,
					id: result.id,
					name,
					firstMessage: sanitizeName(result.firstMessage),
					modified: entry.modified,
					created: result.created || entry.modified,
					messageCount: result.messageCount,
					size: entry.size,
					status: result.status,
					current: options.currentSessionFile
						? path.resolve(options.currentSessionFile) === path.resolve(entry.file)
						: false,
				};
				return listed;
			} catch {
				return undefined;
			}
		}),
	);

	return scanned.filter((entry): entry is SessionListEntry => entry !== undefined);
}
