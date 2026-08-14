/**
 * Smoke test for the `openFile` webview message, outside VS Code.
 *
 * Path links in the transcript are not all files — a `read` of a directory, a
 * glob row and a grep `# dir` header all post `openFile` with a directory —
 * and `openTextDocument` rejects those with "that is actually a directory",
 * which the dispatch catch turned into an error toast. A directory must be
 * revealed in the Explorer instead.
 *
 * No agent process is involved: `openFile` never touches the RPC client.
 *
 *   npm run smoke:openfile
 */

import path from "node:path";
import { ChatController } from "../src/chat/controller";
import type { HostMessage } from "../src/shared/bridge";
import { harness } from "./harness/vscode-stub";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

const notifications: HostMessage[] = [];

const controller = new ChatController({
	// The stub's channel satisfies the LogOutputChannel surface the controller uses.
	output: harness.createLogChannel() as never,
	diffs: { store: () => ({ toString: () => "" }) } as never,
	workspaceFolder: { uri: { fsPath: process.cwd() }, name: "omp-ui", index: 0 } as never,
});
controller.subscribe(message => {
	if (message.type === "notify") notifications.push(message);
});

/** One `openFile` round, with the recorders cleared first. */
async function openFile(target: string, line?: number): Promise<{ revealed: string | undefined; error: string | undefined }> {
	harness.executed.length = 0;
	notifications.length = 0;
	await controller.handleWebviewMessage(line === undefined ? { type: "openFile", path: target } : { type: "openFile", path: target, line });
	const reveal = harness.executed.find(entry => entry.command === "revealInExplorer");
	const uri = reveal?.args[0] as { fsPath?: string } | undefined;
	const failed = notifications.find(message => message.type === "notify" && message.level === "error");
	return {
		revealed: uri?.fsPath,
		error: failed?.type === "notify" ? failed.message : undefined,
	};
}

async function main(): Promise<void> {
	const directory = path.join(process.cwd(), "webview", "src", "components");
	const file = path.join(directory, "Icon.tsx");
	const missing = path.join(directory, "NoSuchFile.tsx");

	// The reported regression: clicking the path link of a `read` on a directory.
	const onDirectory = await openFile(directory);
	check("a directory is revealed in the Explorer", onDirectory.revealed === directory, onDirectory.revealed ?? "not revealed");
	check("a directory raises no error toast", onDirectory.error === undefined, onDirectory.error);

	// Listings mark directories with a trailing separator; the URI must not carry it.
	const withSlash = await openFile(`${directory}${path.sep}`);
	check("a trailing separator is trimmed before revealing", withSlash.revealed === directory, withSlash.revealed ?? "not revealed");
	check("a trailing separator raises no error toast", withSlash.error === undefined, withSlash.error);

	// A line number cannot apply to a directory, and must not change the outcome.
	const withLine = await openFile(directory, 12);
	check("a directory with a line number still reveals", withLine.revealed === directory && withLine.error === undefined, withLine.error);

	// Files must keep going to the editor. The stub has no real editor, so the
	// harness's own `openTextDocument` refusal is the proof it took that path.
	const onFile = await openFile(file);
	check("a file is not revealed in the Explorer", onFile.revealed === undefined, onFile.revealed);
	check(
		"a file goes to openTextDocument",
		onFile.error?.includes("openTextDocument is not available in the harness") === true,
		onFile.error,
	);

	// A missing path is VS Code's to diagnose, not something to swallow or reveal.
	const onMissing = await openFile(missing);
	check("a missing path is not revealed in the Explorer", onMissing.revealed === undefined, onMissing.revealed);
	check("a missing path still reports an error", onMissing.error !== undefined, onMissing.error);

	controller.dispose();
}

main().then(
	() => {
		console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed: ${failures.join(", ")}`);
		process.exit(failures.length === 0 ? 0 : 1);
	},
	error => {
		console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);
