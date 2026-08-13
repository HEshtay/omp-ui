/**
 * End-to-end smoke test for the RPC bridge, outside VS Code.
 *
 * Spawns a real `omp --mode rpc-ui`, drives one prompt through the same client
 * and reducer the extension uses, and prints what the transcript would render.
 *
 *   npm run smoke -- "say hello"
 */

import { OmpRpcClient } from "../src/rpc/client";
import { applyEvent, createChatState } from "../src/shared/chat-model";
import type { ChatState } from "../src/shared/chat-model";
import type { AgentSessionEvent } from "../src/shared/protocol";

const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: bridge ok";

let chat: ChatState = createChatState();
let settled: (() => void) | undefined;

const client = new OmpRpcClient(
	{
		executable: process.env.OMP_PATH ?? "omp",
		extraArgs: ["--no-session"],
		cwd: process.cwd(),
		log: message => console.log(`[rpc] ${message}`),
	},
	{
		onSessionEvent: (event: AgentSessionEvent) => {
			chat = applyEvent(chat, event);
			if (event.type === "tool_execution_start") console.log(`[tool] ${event.toolName}`);
			if (event.type === "agent_end" && event.isTerminal !== false) settled?.();
		},
		onSubagentFrame: frame => console.log(`[subagent] ${frame.type}`),
		onUiRequest: request => {
			console.log(`[ui] ${request.method}`);
			// Auto-approve so an approval gate cannot hang the smoke run.
			if (request.method === "select") {
				client.respondToUi({ type: "extension_ui_response", id: request.id, value: request.options[0] ?? "" });
			} else if (request.method === "confirm") {
				client.respondToUi({ type: "extension_ui_response", id: request.id, confirmed: true });
			} else if (request.method === "input" || request.method === "editor") {
				client.respondToUi({ type: "extension_ui_response", id: request.id, cancelled: true });
			}
		},
		onCommands: commands => console.log(`[commands] ${commands.length} available`),
		onSessionInfo: info => console.log(`[session] ${info.sessionId ?? "?"} ${info.title ?? ""}`),
		onConfigUpdate: () => {},
		onCommandOutput: text => console.log(`[output] ${text}`),
		onExtensionError: frame => console.warn(`[extension] ${frame.extensionPath}: ${frame.error}`),
		onStderr: text => process.stderr.write(text),
		onExit: (code, signal) => console.log(`[exit] code=${code} signal=${signal}`),
	},
);

async function main(): Promise<void> {
	const started = Date.now();
	await client.start();
	console.log(`[rpc] ready in ${Date.now() - started}ms, protocol v${client.protocolVersion}`);

	const state = await client.request("get_state");
	console.log(`[state] model=${state.model?.provider}/${state.model?.id} session=${state.sessionId}`);

	const models = await client.request("get_available_models");
	console.log(`[models] ${models.models.length} available`);

	const done = Promise.withResolvers<void>();
	settled = done.resolve;
	const timeout = setTimeout(() => done.reject(new Error("no terminal agent_end within 120s")), 120_000);

	const ack = await client.request("prompt", { message: prompt });
	console.log(`[prompt] accepted, agentInvoked=${ack?.agentInvoked ?? "unknown"}`);
	if (ack?.agentInvoked === false) {
		clearTimeout(timeout);
	} else {
		await done.promise;
		clearTimeout(timeout);
	}

	console.log("\n--- rendered transcript ---");
	for (const item of chat.items) {
		if (item.kind === "assistant") {
			for (const block of item.content) {
				if (block.type === "text") console.log(`assistant: ${block.text}`);
				else if (block.type === "thinking") console.log(`thinking: ${block.thinking.slice(0, 80)}…`);
				else if (block.type === "toolCall") console.log(`toolCall: ${block.name}`);
			}
			console.log(
				`  [${item.model ?? "?"} · ${item.usage?.totalTokens ?? 0} tokens · $${(item.usage?.cost.total ?? 0).toFixed(4)}]`,
			);
		} else if (item.kind === "user") {
			console.log(`user: ${item.text}`);
		} else {
			console.log(`${item.kind}: ${JSON.stringify(item).slice(0, 120)}`);
		}
	}
	for (const call of Object.values(chat.toolCalls)) {
		console.log(`tool ${call.name} -> ${call.status}`);
	}

	await client.dispose();
}

main().catch(async error => {
	console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
	await client.dispose();
	process.exitCode = 1;
});
