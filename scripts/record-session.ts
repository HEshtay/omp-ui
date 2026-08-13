/**
 * Record a real omp session as the exact `HostMessage` stream the webview sees.
 *
 * Runs the production `ChatController` against a live `omp --mode rpc-ui` with
 * the `vscode` module stubbed, and writes the captured frames so the webview can
 * be replayed against real agent traffic instead of hand-written fixtures.
 *
 *   npm run record -- "your prompt"
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { ChatController } from "../src/chat/controller";
import type { HostMessage } from "../src/shared/bridge";
import { harness } from "./harness/vscode-stub";

const prompt = process.argv.slice(2).join(" ") || "Summarize this repository in three bullets.";
const outputPath = process.env.RECORD_OUT ?? "dist/recorded-session.json";

interface Frame {
	atMs: number;
	message: HostMessage;
}

async function main(): Promise<void> {
	const frames: Frame[] = [];
	const started = Date.now();

	const controller = new ChatController({
		// The stub's channel satisfies the LogOutputChannel surface the controller uses.
		output: harness.createLogChannel() as never,
		diffs: { store: () => ({ toString: () => "" }) } as never,
		workspaceFolder: { uri: { fsPath: process.cwd() }, name: "omp-ui", index: 0 } as never,
	});

	const settled = Promise.withResolvers<void>();
	controller.subscribe(message => {
		frames.push({ atMs: Date.now() - started, message });
		if (message.type === "events") {
			for (const event of message.events) {
				if (event.type === "agent_end" && event.isTerminal !== false) settled.resolve();
			}
		}
	});

	await controller.handleWebviewMessage({ type: "ready" });
	await controller.start();

	console.log("prompting…");
	await controller.handleWebviewMessage({ type: "submit", text: prompt, images: [] });

	const timeout = setTimeout(() => settled.reject(new Error("no terminal agent_end within 240s")), 240_000);
	await settled.promise;
	clearTimeout(timeout);

	// Let trailing state refreshes land before snapshotting.
	await new Promise(resolve => setTimeout(resolve, 1500));
	frames.push({ atMs: Date.now() - started, message: { type: "snapshot", snapshot: controller.snapshot(), draft: controller.draft } });

	const snapshot = controller.snapshot();
	console.log(`captured ${frames.length} frames`);
	console.log(`items=${snapshot.chat.items.length} toolCalls=${Object.keys(snapshot.chat.toolCalls).length}`);
	console.log(`model=${snapshot.session.model?.provider}/${snapshot.session.model?.id} commands=${snapshot.commands.length} models=${snapshot.models.length}`);

	mkdirSync(outputPath.slice(0, outputPath.lastIndexOf("/")), { recursive: true });
	writeFileSync(outputPath, JSON.stringify(frames, null, "\t"));
	console.log(`wrote ${outputPath}`);

	controller.dispose();
	// The controller's client teardown is async and detached from dispose().
	await new Promise(resolve => setTimeout(resolve, 800));
}

main().then(
	() => process.exit(0),
	error => {
		console.error(`record failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);
