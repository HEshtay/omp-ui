/**
 * End-to-end smoke test for the multiplexing layer, outside VS Code.
 *
 * Drives the production `SessionManager` with the `vscode` module stubbed:
 * two live sessions in the *same* project plus a session in a second project,
 * each a real `omp --mode rpc-ui` process, prompted concurrently. Asserts the
 * sessions stay independent (own session file, own transcript), that background
 * badges reach every surface, and that focus/close behave.
 *
 *   npm run smoke:sessions
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatSurface } from "../src/session/session-manager";
import { SessionManager } from "../src/session/session-manager";
import type { HostMessage } from "../src/shared/bridge";
import { harness } from "./harness/vscode-stub";

// Real session files, so `sessionFile` is meaningful.
harness.CONFIG.extraArgs = [];

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

/** A bound webview: records everything the host pushed at it. */
class Recorder {
	readonly messages: HostMessage[] = [];
	constructor(
		readonly name: string,
		readonly surface: ChatSurface,
	) {
		surface.subscribe(message => this.messages.push(message));
	}

	async ready(): Promise<void> {
		await this.surface.handleWebviewMessage({ type: "ready" });
	}

	async submit(text: string): Promise<void> {
		await this.surface.handleWebviewMessage({ type: "submit", text, images: [] });
	}

	/** Assistant text across every event frame this surface received. */
	text(): string {
		let out = "";
		for (const message of this.messages) {
			if (message.type !== "events") continue;
			for (const event of message.events) {
				if (event.type !== "message_update") continue;
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") out += inner.delta;
			}
		}
		return out;
	}

	last<T extends HostMessage["type"]>(type: T): Extract<HostMessage, { type: T }> | undefined {
		for (let index = this.messages.length - 1; index >= 0; index--) {
			const message = this.messages[index];
			if (message?.type === type) return message as Extract<HostMessage, { type: T }>;
		}
		return undefined;
	}

	/** Resolve once a terminal `agent_end` has been seen. */
	settled(timeoutMs: number): Promise<void> {
		const done = Promise.withResolvers<void>();
		const deadline = setTimeout(() => done.reject(new Error(`${this.name}: no agent_end within ${timeoutMs}ms`)), timeoutMs);
		const poll = setInterval(() => {
			for (const message of this.messages) {
				if (message.type !== "events") continue;
				for (const event of message.events) {
					if (event.type === "agent_end" && event.isTerminal !== false) {
						clearInterval(poll);
						clearTimeout(deadline);
						done.resolve();
						return;
					}
				}
			}
		}, 50);
		return done.promise;
	}
}

async function main(): Promise<void> {
	const manager = new SessionManager({
		output: harness.createLogChannel() as never,
		diffs: { store: () => ({ toString: () => "" }) } as never,
	});
	const opened: string[] = [];
	const closed: string[] = [];
	manager.panels = { open: id => opened.push(id), close: id => closed.push(id) };

	const projectA = process.cwd();
	const projectB = mkdtempSync(path.join(tmpdir(), "omp-smoke-"));
	manager.registerProject({ id: projectA, cwd: projectA, label: "omp-ui" });
	manager.registerProject({ id: projectB, cwd: projectB, label: "scratch" });

	const a1 = manager.createSession(projectA);
	const a2 = manager.createSession(projectA);
	const b1 = manager.createSession(projectB);
	if (!a1 || !a2 || !b1) throw new Error("session creation failed");
	check("two sessions in one project get distinct ids", a1 !== a2, `${a1} vs ${a2}`);

	// The sidebar follows the active session; panels pin to one.
	const sidebar = new Recorder("sidebar", manager.sidebar());
	const panelA2 = new Recorder("panel:a2", manager.surface(a2));
	const panelB1 = new Recorder("panel:b1", manager.surface(b1));

	await sidebar.ready();
	await panelA2.ready();
	await panelB1.ready();

	const roster = sidebar.last("workspace");
	check(
		"roster lists both projects and all three sessions",
		roster?.projects.length === 2 && roster?.sessions.length === 3,
		`projects=${roster?.projects.length} sessions=${roster?.sessions.length}`,
	);
	check("sidebar follows the first session", roster?.activeSessionId === a1, String(roster?.activeSessionId));
	check("pinned panel reports its own session as active", panelA2.last("workspace")?.activeSessionId === a2);

	// Three agents, started concurrently.
	await Promise.all([
		manager.controller(a1)?.start(),
		manager.controller(a2)?.start(),
		manager.controller(b1)?.start(),
	]);
	const statusOf = (recorder: Recorder) => recorder.last("session")?.session;
	check(
		"all three agents reached ready",
		[sidebar, panelA2, panelB1].every(recorder => statusOf(recorder)?.agentStatus === "ready"),
		[sidebar, panelA2, panelB1].map(recorder => `${recorder.name}=${statusOf(recorder)?.agentStatus}`).join(" "),
	);
	check(
		"each session runs in its project's cwd",
		statusOf(sidebar)?.cwd === projectA && statusOf(panelA2)?.cwd === projectA && statusOf(panelB1)?.cwd === projectB,
	);

	const fileA1 = statusOf(sidebar)?.sessionFile;
	const fileA2 = statusOf(panelA2)?.sessionFile;
	check(
		"same-project sessions own separate session files",
		Boolean(fileA1) && Boolean(fileA2) && fileA1 !== fileA2,
		`${fileA1} vs ${fileA2}`,
	);

	// Prompt all three at once and let them race.
	await Promise.all([
		sidebar.submit("Reply with exactly: ALPHA"),
		panelA2.submit("Reply with exactly: BETA"),
		panelB1.submit("Reply with exactly: GAMMA"),
	]);

	await Promise.all([sidebar.settled(180_000), panelA2.settled(180_000), panelB1.settled(180_000)]);

	// A2 is a background session for the sidebar: only its badge should reach it.
	const badges = sidebar.messages.filter(message => message.type === "sessionStatus" && message.id === a2);
	check(
		"a background session's streaming badge reaches the sidebar",
		badges.some(message => message.type === "sessionStatus" && message.isStreaming) &&
			badges.some(message => message.type === "sessionStatus" && !message.isStreaming),
		`${badges.length} badge updates`,
	);

	check("session A1 transcript holds only its own answer", sidebar.text().includes("ALPHA") && !sidebar.text().includes("BETA"), sidebar.text().trim().slice(0, 60));
	check("session A2 transcript holds only its own answer", panelA2.text().includes("BETA") && !panelA2.text().includes("ALPHA"), panelA2.text().trim().slice(0, 60));
	check("session B1 transcript holds only its own answer", panelB1.text().includes("GAMMA"), panelB1.text().trim().slice(0, 60));

	// Focus switching: the sidebar re-hydrates from the newly active session.
	const before = sidebar.messages.length;
	manager.selectSession(a2);
	const rehydrated = sidebar.messages.slice(before);
	check("selecting a session opens its panel", opened.includes(a2), opened.join(","));
	check(
		"sidebar re-hydrates with the newly active session",
		rehydrated.some(message => message.type === "workspace" && message.activeSessionId === a2) &&
			rehydrated.some(message => message.type === "snapshot" && message.snapshot.session.sessionFile === fileA2),
	);
	check("pinned panel is unaffected by the sidebar's focus", panelB1.last("workspace")?.activeSessionId === b1);

	// Sidebar now shows A2: its messages must follow A2, not A1.
	const afterSwitch = sidebar.messages.length;
	await sidebar.surface.handleWebviewMessage({ type: "requestSessions" });
	const saved = sidebar.messages.slice(afterSwitch).find(message => message.type === "savedSessions");
	check(
		"resume list comes from the project's session store",
		saved?.type === "savedSessions" && saved.sessions.some(entry => entry.path === fileA2),
		saved?.type === "savedSessions" ? `${saved.sessions.length} saved sessions` : "none",
	);

	// The webview's own messages, routed exactly as a bound webview sends them.
	const beforeSpawn = manager.sessions().length;
	await panelB1.surface.handleWebviewMessage({ type: "newSession" });
	const spawned = manager.sessions().find(entry => entry.projectId === projectB && entry.id !== b1);
	check(
		"a pinned panel's `newSession` lands in that panel's project",
		manager.sessions().length === beforeSpawn + 1 && spawned?.ordinal === 2,
		spawned?.id,
	);
	check("the spawned session is focused and revealed", manager.activeSessionId === spawned?.id && opened.includes(spawned?.id ?? ""));

	await sidebar.surface.handleWebviewMessage({ type: "selectSession", id: a1 });
	check("`selectSession` from the sidebar re-focuses a session", manager.activeSessionId === a1);

	// `resetSession` starts a new conversation *inside* the running agent.
	const fileBeforeReset = panelB1.last("session")?.session.sessionFile;
	await panelB1.surface.handleWebviewMessage({ type: "resetSession" });
	const afterReset = panelB1.last("snapshot")?.snapshot.session;
	check(
		"`resetSession` reuses the agent but starts a new session file",
		afterReset?.agentStatus === "ready" && Boolean(afterReset?.sessionFile) && afterReset?.sessionFile !== fileBeforeReset,
		`${fileBeforeReset?.slice(-24)} -> ${afterReset?.sessionFile?.slice(-24)}`,
	);

	await sidebar.surface.handleWebviewMessage({ type: "closeSession", id: spawned?.id ?? "" });
	check("`closeSession` from the sidebar drops the session", manager.sessions().length === beforeSpawn);

	// Closing a session tears down its agent and drops it from the roster.
	manager.closeSession(a1);
	check("closing a session closes its panel", closed.includes(a1));
	check(
		"closed session leaves the roster",
		manager.sessions().every(entry => entry.id !== a1) && manager.sessions().length === 2,
		manager.sessions().map(entry => entry.id).join(","),
	);

	manager.closeSession(a2);
	const beforeLast = sidebar.messages.length;
	manager.closeSession(b1);
	check("the last session cannot be closed", manager.sessions().length === 1);
	check(
		"refusing to close the last session warns the user",
		sidebar.messages.slice(beforeLast).some(message => message.type === "notify" && message.level === "warning"),
	);

	// A fresh session in a project whose earlier sessions are gone: ordinals are
	// minted, never reused, so a recycled slot cannot inherit a stale label.
	const usedOrdinals = manager.sessions().filter(entry => entry.projectId === projectB).map(entry => entry.ordinal);
	const b2 = manager.newSession(projectB);
	const spawnedOrdinal = manager.sessionEntry(b2 ?? "")?.ordinal ?? 0;
	check("new session lands in the requested project", manager.sessionEntry(b2 ?? "")?.projectId === projectB);
	check(
		"ordinals keep climbing instead of being reused",
		spawnedOrdinal > Math.max(0, ...usedOrdinals),
		`${spawnedOrdinal} > [${usedOrdinals.join(",")}]`,
	);

	manager.dispose();
	// Controller teardown is async and detached from dispose().
	await new Promise(resolve => setTimeout(resolve, 800));
}

main().then(
	() => {
		console.log(failures.length === 0 ? "\nall session checks passed" : `\n${failures.length} check(s) failed`);
		process.exit(failures.length === 0 ? 0 : 1);
	},
	error => {
		console.error(`smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
		process.exit(1);
	},
);
