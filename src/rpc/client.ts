import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { deferred } from "../shared/deferred";
import { frameType, isRecord } from "../shared/guards";
import { isAgentSessionEvent } from "../shared/protocol";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcCommandType,
	RpcExtensionErrorFrame,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponseData,
	RpcSubagentFrame,
	SlashCommand,
} from "../shared/protocol";
import { RpcFrameDecoder } from "./frame";
import { resolveSpawnTarget } from "./spawn-target";

export interface OmpClientOptions {
	executable: string;
	extraArgs: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	/** Milliseconds to wait for the `ready` frame before giving up. */
	readyTimeoutMs?: number;
	log(message: string): void;
}

export interface OmpClientHandlers {
	onSessionEvent(event: AgentSessionEvent): void;
	onSubagentFrame(frame: RpcSubagentFrame): void;
	onUiRequest(request: RpcExtensionUIRequest): void;
	onCommands(commands: SlashCommand[]): void;
	onSessionInfo(info: { title?: string; sessionId?: string }): void;
	onConfigUpdate(update: { model?: unknown; thinkingLevel?: unknown }): void;
	onCommandOutput(text: string): void;
	onExtensionError(frame: RpcExtensionErrorFrame): void;
	onStderr(text: string): void;
	onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

interface PendingRequest {
	command: RpcCommandType;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

export class RpcClientError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "RpcClientError";
	}
}

const DEFAULT_READY_TIMEOUT_MS = 60_000;

/**
 * Owns one `omp --mode rpc-ui` child process and its newline-delimited JSON
 * protocol.
 *
 * Responses correlate strictly on `id` — the agent runs commands concurrently
 * and makes no ordering promise. Session events, UI requests, and side-channel
 * frames are demultiplexed on `type` and pushed to handlers.
 */
export class OmpRpcClient {
	#process: ChildProcessWithoutNullStreams | undefined;
	#decoder = new RpcFrameDecoder();
	#stdout = new StringDecoder("utf8");
	#stderr = new StringDecoder("utf8");
	#buffer = "";
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#disposed = false;
	#protocolVersion: 1 | 2 = 1;

	constructor(
		private readonly options: OmpClientOptions,
		private readonly handlers: OmpClientHandlers,
	) {}

	get protocolVersion(): 1 | 2 {
		return this.#protocolVersion;
	}

	get running(): boolean {
		return this.#process !== undefined && this.#process.exitCode === null && !this.#disposed;
	}

	/** Spawn the agent, wait for its ready frame, then negotiate lossless framing. */
	async start(): Promise<void> {
		const args = ["--mode", "rpc-ui", ...this.options.extraArgs];
		const target = resolveSpawnTarget(this.options.executable, args, process.env);
		this.options.log(`spawn: ${target.resolvedPath} ${args.join(" ")}  (cwd=${this.options.cwd})`);

		const child = spawn(target.command, target.args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
		}) as ChildProcessWithoutNullStreams;
		this.#process = child;

		const readyTimeout = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const ready = deferred<void>();
		const readyTimer = setTimeout(() => {
			this.#onReady = undefined;
			ready.reject(new Error(`omp did not send a ready frame within ${readyTimeout / 1000}s`));
		}, readyTimeout);
		const settleReady = (error?: Error) => {
			if (!this.#onReady) return;
			this.#onReady = undefined;
			clearTimeout(readyTimer);
			if (error) ready.reject(error);
			else ready.resolve();
		};
		this.#onReady = () => settleReady();
		child.once("error", error => settleReady(error instanceof Error ? error : new Error(String(error))));
		child.once("exit", (code, signal) =>
			settleReady(new Error(`omp exited before becoming ready (code=${code} signal=${signal})`)),
		);

		child.stdout.on("data", (chunk: Buffer) => this.#ingest(this.#stdout.write(chunk)));
		child.stderr.on("data", (chunk: Buffer) => this.handlers.onStderr(this.#stderr.write(chunk)));
		child.on("error", error => this.options.log(`process error: ${String(error)}`));
		child.on("exit", (code, signal) => {
			this.#rejectAll(new Error(`omp exited (code=${code} signal=${signal})`));
			this.handlers.onExit(code, signal);
		});

		await ready.promise;

		try {
			const negotiated = await this.request("negotiate_protocol", { protocolVersion: 2 });
			if (negotiated.protocolVersion === 2) this.#protocolVersion = 2;
		} catch (error) {
			// A v1-only runtime keeps working; oversized frames just degrade.
			this.options.log(`protocol v2 unavailable, staying on v1: ${describe(error)}`);
		}
	}

	#onReady: (() => void) | undefined;

	/** Issue a command and resolve with its `data` payload. */
	request<K extends keyof RpcResponseData>(
		type: K,
		params?: Omit<Extract<RpcCommand, { type: K }>, "type" | "id">,
	): Promise<RpcResponseData[K]>;
	request(type: RpcCommandType, params?: Record<string, unknown>): Promise<unknown>;
	request(type: RpcCommandType, params?: Record<string, unknown>): Promise<unknown> {
		if (!this.running) return Promise.reject(new RpcClientError("omp is not running", type));
		const id = `req_${++this.#nextRequestId}`;
		const frame = { ...params, id, type } as RpcCommand;
		const { promise, resolve, reject } = deferred<unknown>();
		this.#pending.set(id, { command: type, resolve, reject });
		try {
			this.#write(frame);
		} catch (error) {
			this.#pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	/** Answer a blocking `extension_ui_request`. Responses are a side channel — never queued. */
	respondToUi(response: RpcExtensionUIResponse): void {
		if (!this.running) return;
		this.#write(response);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const child = this.#process;
		this.#process = undefined;
		this.#rejectAll(new Error("omp client disposed"));
		if (!child || child.exitCode !== null) return;

		// Closing stdin is the protocol's graceful shutdown: the agent drains
		// accepted commands, disposes the session, and exits 0.
		try {
			child.stdin.end();
		} catch {
			// Already closed.
		}
		const exited = deferred<void>();
		const killTimer = setTimeout(() => {
			child.kill("SIGKILL");
			exited.resolve();
		}, 5000);
		child.once("exit", () => {
			clearTimeout(killTimer);
			exited.resolve();
		});
		await exited.promise;
	}

	#write(frame: object): void {
		const child = this.#process;
		if (!child) throw new RpcClientError("omp is not running", "write");
		child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	#rejectAll(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	#ingest(text: string): void {
		this.#buffer += text;
		let newline = this.#buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line) this.#handleLine(line);
			newline = this.#buffer.indexOf("\n");
		}
	}

	#handleLine(line: string): void {
		let frame: Record<string, unknown> | undefined;
		try {
			frame = this.#decoder.push(JSON.parse(line));
		} catch (error) {
			this.#decoder.reset();
			this.options.log(`dropping malformed frame: ${describe(error)}`);
			return;
		}
		if (!frame) return;
		try {
			this.#dispatch(frame);
		} catch (error) {
			this.options.log(`frame handler threw: ${describe(error)}`);
		}
	}

	#dispatch(frame: Record<string, unknown>): void {
		const type = frameType(frame);
		if (!type) return;

		switch (type) {
			case "ready":
				this.#onReady?.();
				return;

			case "response": {
				const id = typeof frame.id === "string" ? frame.id : undefined;
				const command = typeof frame.command === "string" ? frame.command : "unknown";
				if (!id) {
					// Unknown-command and parse failures answer without an id.
					if (frame.success === false) this.options.log(`uncorrelated failure (${command}): ${String(frame.error)}`);
					return;
				}
				const pending = this.#pending.get(id);
				if (!pending) return;
				this.#pending.delete(id);
				if (frame.success === true) {
					pending.resolve(frame.data);
				} else {
					pending.reject(
						new RpcClientError(
							typeof frame.error === "string" ? frame.error : `${command} failed`,
							command,
							typeof frame.code === "string" ? frame.code : undefined,
						),
					);
				}
				return;
			}

			case "extension_ui_request":
				this.handlers.onUiRequest(frame as unknown as RpcExtensionUIRequest);
				return;

			case "available_commands_update":
				if (Array.isArray(frame.commands)) this.handlers.onCommands(frame.commands as SlashCommand[]);
				return;

			case "session_info_update":
				this.handlers.onSessionInfo({
					title: typeof frame.title === "string" ? frame.title : undefined,
					sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
				});
				return;

			case "config_update":
				this.handlers.onConfigUpdate({ model: frame.model, thinkingLevel: frame.thinkingLevel });
				return;

			case "command_output":
				if (typeof frame.text === "string") this.handlers.onCommandOutput(frame.text);
				return;

			case "extension_error":
				this.handlers.onExtensionError(frame as unknown as RpcExtensionErrorFrame);
				return;

			case "subagent_lifecycle":
			case "subagent_progress":
			case "subagent_event":
				if (isRecord(frame.payload)) this.handlers.onSubagentFrame(frame as unknown as RpcSubagentFrame);
				return;

			case "rpc_frame_error":
				this.options.log(`agent dropped an oversized frame: ${String(frame.error)}`);
				return;

			// Prompt scheduling hints and host-tool/URI callbacks we never opt into.
			case "prompt_result":
			case "host_tool_call":
			case "host_tool_cancel":
			case "host_uri_request":
			case "host_uri_cancel":
				return;

			default:
				if (isAgentSessionEvent(frame)) this.handlers.onSessionEvent(frame as AgentSessionEvent);
				return;
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
