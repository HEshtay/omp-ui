/**
 * End-to-end smoke test for the IDE bridge, outside VS Code.
 *
 * Runs a real `IdeBridgeServer` over a real named pipe / unix socket, spawns the
 * real `dist/mcp-shim.js` as omp would, and drives raw MCP JSON-RPC over the
 * shim's stdio. Asserts the handshake, the tool list, a call that round-trips
 * through the bridge, an unknown-tool error that does not kill the shim, and the
 * degraded contract when no bridge address is in the environment.
 *
 * The tool list is a local stub, so this proves the *transport*, not any
 * particular IDE tool's behaviour.
 *
 *   npm run build:extension && npm run smoke:ide
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { IdeBridgeServer } from "../src/ide/bridge-server";
import { IDE_BRIDGE_CWD_ENV, IDE_BRIDGE_PIPE_ENV } from "../src/ide/protocol";
import type { IdeTool } from "../src/ide/tools/types";
import { deferred } from "../src/shared/deferred";
import { harness } from "./harness/vscode-stub";

const SHIM = path.resolve(__dirname, "..", "dist", "mcp-shim.js");
const PROTOCOL_VERSION = "2025-03-26";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

/** Stub tools: one that echoes its argument, one that always throws. */
const stubTools: IdeTool[] = [
	{
		name: "smoke_echo",
		description: "Echo the `text` argument back.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		async invoke(args, ctx) {
			if (typeof args.text !== "string") throw new Error("`text` must be a string");
			return `echo:${args.text} cwd:${ctx.cwd}`;
		},
	},
	{
		name: "smoke_boom",
		description: "Always throws, to prove a tool failure is reported not fatal.",
		inputSchema: { type: "object", properties: {} },
		async invoke() {
			throw new Error("boom");
		},
	},
];

/** Every shim we spawn, so no exit path leaks a child. */
const children: ShimClient[] = [];

/** A spawned shim, driven as an MCP client over newline-delimited JSON-RPC. */
class ShimClient {
	readonly stderr: string[] = [];
	#child: ChildProcessWithoutNullStreams;
	#buffer = "";
	#nextId = 1;
	#pending = new Map<number, (message: Record<string, unknown>) => void>();
	#exited = false;

	constructor(env: Record<string, string | undefined>) {
		this.#child = spawn(process.execPath, [SHIM], {
			cwd: process.cwd(),
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		}) as ChildProcessWithoutNullStreams;
		children.push(this);
		this.#child.on("exit", () => {
			this.#exited = true;
		});
		this.#child.stderr.setEncoding("utf8");
		this.#child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
		this.#child.stdout.setEncoding("utf8");
		this.#child.stdout.on("data", (chunk: string) => this.#onData(chunk));
	}

	get alive(): boolean {
		return !this.#exited;
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		let index = this.#buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.#buffer.slice(0, index).trim();
			this.#buffer = this.#buffer.slice(index + 1);
			index = this.#buffer.indexOf("\n");
			if (line === "") continue;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(line) as Record<string, unknown>;
			} catch {
				failures.push(`shim wrote a non-JSON line: ${line.slice(0, 120)}`);
				continue;
			}
			const id = message.id;
			if (typeof id !== "number") continue; // server-initiated notification
			this.#pending.get(id)?.(message);
			this.#pending.delete(id);
		}
	}

	/** Send a request and resolve with the whole JSON-RPC response envelope. */
	request(method: string, params?: unknown, timeoutMs = 10_000): Promise<Record<string, unknown>> {
		const id = this.#nextId++;
		const done = deferred<Record<string, unknown>>();
		const timeout = setTimeout(
			() => done.reject(new Error(`no response to ${method} within ${timeoutMs}ms`)),
			timeoutMs,
		);
		this.#pending.set(id, message => {
			clearTimeout(timeout);
			done.resolve(message);
		});
		this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return done.promise;
	}

	notify(method: string, params?: unknown): void {
		this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	kill(): void {
		if (!this.#exited) this.#child.kill();
	}
}

function killAll(): void {
	for (const client of children) client.kill();
}

function toolNames(response: Record<string, unknown>): string[] {
	const result = response.result as { tools?: { name?: unknown }[] } | undefined;
	return (result?.tools ?? []).map(tool => String(tool.name));
}

function isErrorResult(response: Record<string, unknown>): boolean {
	if (response.error !== undefined) return true;
	return (response.result as { isError?: unknown } | undefined)?.isError === true;
}

async function main(): Promise<void> {
	if (!existsSync(SHIM)) {
		throw new Error(`${SHIM} is missing — run \`npm run build:extension\` first`);
	}

	// The stub's channel satisfies the LogOutputChannel surface the bridge uses.
	const server = new IdeBridgeServer({ output: harness.createLogChannel() as never, tools: stubTools });
	const pipePath = await server.start();
	check("bridge server starts and reports a pipe path", pipePath.length > 0, pipePath);
	check("pipePath matches the value start() returned", server.pipePath === pipePath);

	// ---------------------------------------------------------------- connected
	const cwd = process.cwd();
	const shim = new ShimClient({ [IDE_BRIDGE_PIPE_ENV]: pipePath, [IDE_BRIDGE_CWD_ENV]: cwd });

	const init = await shim.request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "smoke-ide-bridge", version: "0" },
	});
	const initResult = init.result as { protocolVersion?: unknown } | undefined;
	check(
		`initialize negotiates ${PROTOCOL_VERSION}`,
		initResult?.protocolVersion === PROTOCOL_VERSION,
		String(initResult?.protocolVersion),
	);
	shim.notify("notifications/initialized");

	const listed = await shim.request("tools/list");
	const names = toolNames(listed);
	check(
		"tools/list proxies the bridge's tool list",
		stubTools.every(tool => names.includes(tool.name)) && names.length === stubTools.length,
		names.join(","),
	);

	const called = await shim.request("tools/call", {
		name: "smoke_echo",
		arguments: { text: "bridge ok" },
	});
	const content = (called.result as { content?: { text?: unknown }[] } | undefined)?.content ?? [];
	const text = content.map(part => String(part.text ?? "")).join("");
	check(
		"tools/call round-trips through the bridge",
		text.includes("echo:bridge ok") && !isErrorResult(called),
		text,
	);
	check("the tool sees the session cwd we injected", text.includes(`cwd:${cwd}`), text);

	const failed = await shim.request("tools/call", { name: "smoke_boom", arguments: {} });
	check("a throwing tool comes back as an error result", isErrorResult(failed));

	const unknown = await shim.request("tools/call", { name: "no_such_tool", arguments: {} });
	check("an unknown tool comes back as an error result", isErrorResult(unknown));

	const afterError = await shim.request("tools/list");
	check(
		"the shim survives an errored call",
		shim.alive && toolNames(afterError).length === stubTools.length,
	);
	check("nothing was written to stderr", shim.stderr.length === 0, shim.stderr.join("").slice(0, 200));

	// ----------------------------------------------------------------- degraded
	// Two shapes of "no bridge here", both of which a plain terminal `omp` can
	// produce. Absent: `undefined` values are dropped from the child environment,
	// which also keeps this hermetic when the smoke test itself runs inside an
	// extension-launched omp session. Unresolved: omp's `mcp.json` env resolution
	// falls through to the *literal* variable name when the variable is unset, so
	// that string is what the shim actually receives outside VS Code.
	const degraded: Record<string, Record<string, string | undefined>> = {
		"with no bridge variables at all": {
			[IDE_BRIDGE_PIPE_ENV]: undefined,
			[IDE_BRIDGE_CWD_ENV]: undefined,
		},
		"with omp's unresolved variable names": {
			[IDE_BRIDGE_PIPE_ENV]: IDE_BRIDGE_PIPE_ENV,
			[IDE_BRIDGE_CWD_ENV]: IDE_BRIDGE_CWD_ENV,
		},
	};

	for (const [label, env] of Object.entries(degraded)) {
		const lone = new ShimClient(env);
		const loneInit = await lone.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "smoke-ide-bridge", version: "0" },
		});
		const loneResult = loneInit.result as { protocolVersion?: unknown } | undefined;
		check(
			`initialize still succeeds ${label}`,
			loneResult?.protocolVersion === PROTOCOL_VERSION,
			String(loneResult?.protocolVersion),
		);
		lone.notify("notifications/initialized");
		const loneNames = toolNames(await lone.request("tools/list"));
		check(`a shim ${label} advertises zero tools`, loneNames.length === 0, loneNames.join(","));
		check(`a shim ${label} is silent on stderr`, lone.stderr.length === 0, lone.stderr.join("").slice(0, 200));
	}

	killAll();
	server.dispose();
}

main().then(
	() => {
		killAll();
		console.log(failures.length === 0 ? "\nPASS — all ide bridge checks passed" : `\nFAIL — ${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
		process.exit(failures.length === 0 ? 0 : 1);
	},
	error => {
		killAll();
		console.error(`\nFAIL — smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
		process.exit(1);
	},
);
