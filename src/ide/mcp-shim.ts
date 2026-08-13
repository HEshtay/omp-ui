/**
 * Standalone MCP stdio server launched by the `omp` agent as the `vscode-ide`
 * server, and a thin proxy onto `IdeBridgeServer` in the extension host.
 *
 * Runs **outside** the extension host: it must never import `vscode`, webview
 * code, or anything from `src/shared/` — only `./protocol` and `node:`
 * builtins. Bundled to `dist/mcp-shim.js` (CJS, Node 20).
 *
 * stdout is the protocol channel and carries nothing but JSON-RPC frames.
 * Without `OMP_IDE_BRIDGE_PIPE` the process is a deliberately silent zero-tool
 * server: a terminal `omp` session sees a clean handshake, no tools, and no
 * stderr chatter.
 */
import * as net from "node:net";
import {
  IDE_BRIDGE_CONNECT_TIMEOUT_MS,
  IDE_BRIDGE_CWD_ENV,
  IDE_BRIDGE_MAX_LINE_BYTES,
  IDE_BRIDGE_NEWLINE,
  IDE_BRIDGE_PIPE_ENV,
  IDE_BRIDGE_REQUEST_TIMEOUT_MS,
  IDE_BRIDGE_SERVER_NAME,
  type IdeBridgeCallResult,
  type IdeBridgeHello,
  type IdeBridgeListResult,
  type IdeBridgeRequest,
  type IdeToolDescriptor,
} from "./protocol";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_VERSION = "0.1.0";
const UNAVAILABLE = "The VS Code IDE bridge is not available in this session.";
const EMPTY = Buffer.alloc(0);

// `mcp.json` registers these two variables by *name*, and omp resolves such a
// value to the named variable's contents — but when the variable is unset it
// falls back to the literal name (`resolveConfigValue`). An unresolved
// placeholder therefore means "no bridge in this session", not "connect to a
// pipe called OMP_IDE_BRIDGE_PIPE": a terminal session must degrade silently
// instead of reporting a connection failure.
const rawPipe = (process.env[IDE_BRIDGE_PIPE_ENV] ?? "").trim();
const pipePath = rawPipe === IDE_BRIDGE_PIPE_ENV ? "" : rawPipe;
const configured = pipePath.length > 0;
const rawCwd = process.env[IDE_BRIDGE_CWD_ENV];
const sessionCwd = !rawCwd || rawCwd === IDE_BRIDGE_CWD_ENV ? process.cwd() : rawCwd;

type JsonRpcId = string | number;

interface JsonRpcFrame {
  id?: JsonRpcId | null;
  method?: unknown;
  params?: unknown;
}

/** The bridge answered, but refused the request (unknown tool, bad frame, …). */
class BridgeFault extends Error {}

/** The bridge could not be reached, timed out, or is not configured. */
class BridgeUnavailable extends Error {}

/** Diagnostics are allowed only when a pipe was configured; otherwise stay silent. */
function diagnose(message: string): void {
  if (configured) process.stderr.write(`omp-ide-shim: ${message}\n`);
}

function send(message: Record<string, unknown>): void {
  if (!process.stdout.writable) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Lazily-connected client for the host bridge. A failed connection or request
 * degrades to a thrown `BridgeUnavailable` and drops the socket, so the very
 * next request retries the connection.
 */
class BridgeClient {
  readonly #pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  #socket: net.Socket | undefined;
  #connecting: Promise<net.Socket> | undefined;
  #buffer: Buffer = EMPTY;
  #nextId = 1;
  #closed = false;

  readonly #onToolsChanged: () => void;

  constructor(onToolsChanged: () => void) {
    this.#onToolsChanged = onToolsChanged;
  }

  async request(request: { op: "list" } | { op: "call"; tool: string; args: unknown }): Promise<unknown> {
    if (!configured) throw new BridgeUnavailable(UNAVAILABLE);
    if (this.#closed) throw new BridgeUnavailable(UNAVAILABLE);
    const socket = await this.#connect();
    const id = this.#nextId++;
    // Executor form, not `Promise.withResolvers`: the shim runs on whatever
    // Node the agent has, and Node 20 does not have it.
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeUnavailable(`bridge request timed out after ${IDE_BRIDGE_REQUEST_TIMEOUT_MS}ms`));
      }, IDE_BRIDGE_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      const frame: IdeBridgeRequest =
        request.op === "list" ? { id, op: "list" } : { id, op: "call", tool: request.tool, args: request.args };
      socket.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (!error) return;
        this.#settle(id, undefined, new BridgeUnavailable(error.message));
      });
    });
  }

  dispose(): void {
    this.#closed = true;
    this.#connecting = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#buffer = EMPTY;
    this.#rejectAll(new BridgeUnavailable("bridge client disposed"));
    socket?.destroy();
  }

  async #connect(): Promise<net.Socket> {
    const existing = this.#socket;
    if (existing && !existing.destroyed) return existing;
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });
    return await this.#connecting;
  }

  async #open(): Promise<net.Socket> {
    return await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new BridgeUnavailable(`bridge connect timed out after ${IDE_BRIDGE_CONNECT_TIMEOUT_MS}ms`));
      }, IDE_BRIDGE_CONNECT_TIMEOUT_MS);
      const onError = (error: Error) => {
        clearTimeout(timer);
        socket.removeAllListeners("connect");
        reject(new BridgeUnavailable(error.message));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        socket.on("error", (error: Error) => diagnose(`socket error: ${error.message}`));
        socket.on("data", (chunk: Buffer) => this.#receive(chunk));
        socket.on("close", () => {
          if (this.#socket === socket) {
            this.#socket = undefined;
            this.#buffer = EMPTY;
          }
          this.#rejectAll(new BridgeUnavailable("bridge connection closed"));
        });
        const hello: IdeBridgeHello = { op: "hello", cwd: sessionCwd };
        socket.write(`${JSON.stringify(hello)}\n`);
        this.#socket = socket;
        resolve(socket);
      });
    });
  }

  #receive(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const newline = this.#buffer.indexOf(IDE_BRIDGE_NEWLINE);
      if (newline === -1) break;
      const line = this.#buffer.subarray(0, newline).toString("utf8").trim();
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length > 0) this.#handleFrame(line);
    }
    if (this.#buffer.length > IDE_BRIDGE_MAX_LINE_BYTES) {
      diagnose("host sent an oversized line; dropping the connection");
      this.#buffer = EMPTY;
      this.#socket?.destroy();
    }
  }

  #handleFrame(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      diagnose("ignoring malformed host frame");
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    const message = frame as Record<string, unknown>;
    if (message.op === "tools_changed") {
      this.#onToolsChanged();
      return;
    }
    const id = message.id;
    if (typeof id !== "number") return;
    if (message.ok === true) {
      this.#settle(id, message.result, undefined);
      return;
    }
    const error = typeof message.error === "string" ? message.error : "bridge request failed";
    this.#settle(id, undefined, new BridgeFault(error));
  }

  #settle(id: number, result: unknown, error: Error | undefined): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  #rejectAll(error: Error): void {
    for (const [id] of [...this.#pending]) this.#settle(id, undefined, error);
  }
}

const bridge = new BridgeClient(() => {
  send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
});

async function listTools(): Promise<IdeToolDescriptor[]> {
  if (!configured) return [];
  try {
    const result = (await bridge.request({ op: "list" })) as IdeBridgeListResult | undefined;
    const tools = result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((tool) => ({
      name: String(tool.name),
      description: String(tool.description ?? ""),
      inputSchema:
        typeof tool.inputSchema === "object" && tool.inputSchema !== null
          ? tool.inputSchema
          : { type: "object", properties: {} },
    }));
  } catch (error: unknown) {
    diagnose(`tools/list degraded: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function callTool(params: unknown): Promise<Record<string, unknown>> {
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const name = record.name;
  if (typeof name !== "string" || name.length === 0) {
    return { content: [{ type: "text", text: "tools/call requires a string `name`." }], isError: true };
  }
  try {
    const result = (await bridge.request({
      op: "call",
      tool: name,
      args: record.arguments ?? {},
    })) as IdeBridgeCallResult | undefined;
    const text = typeof result?.text === "string" ? result.text : "";
    const content = { content: [{ type: "text", text }] };
    return result?.isError ? { ...content, isError: true } : content;
  } catch (error: unknown) {
    // A refusal from the host carries a useful message; an unreachable bridge
    // must read as the plain unavailable notice.
    const text = error instanceof BridgeFault ? error.message : UNAVAILABLE;
    if (!(error instanceof BridgeFault)) {
      diagnose(`tools/call ${name} degraded: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { content: [{ type: "text", text }], isError: true };
  }
}

async function handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
  switch (method) {
    case "initialize": {
      const requested = typeof params === "object" && params !== null
        ? (params as Record<string, unknown>).protocolVersion
        : undefined;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof requested === "string" && requested.length > 0 ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: IDE_BRIDGE_SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }
    case "ping": {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    case "tools/list": {
      send({ jsonrpc: "2.0", id, result: { tools: await listTools() } });
      return;
    }
    case "tools/call": {
      send({ jsonrpc: "2.0", id, result: await callTool(params) });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function dispatch(line: string): void {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const message = frame as JsonRpcFrame;
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  // A frame without an id is a notification: `notifications/initialized`,
  // `notifications/cancelled`, and anything unknown are silently ignored.
  if (id === undefined || id === null) return;
  if (method.length === 0) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  // Not awaited: a slow tool call must not block the next frame.
  void handleRequest(id, method, message.params).catch((error: unknown) => {
    diagnose(`request ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
  });
}

let stdinBuffer: Buffer = EMPTY;
process.stdin.on("data", (chunk: Buffer) => {
  stdinBuffer = stdinBuffer.length === 0 ? chunk : Buffer.concat([stdinBuffer, chunk]);
  for (;;) {
    const newline = stdinBuffer.indexOf(IDE_BRIDGE_NEWLINE);
    if (newline === -1) break;
    const line = stdinBuffer.subarray(0, newline).toString("utf8").trim();
    stdinBuffer = stdinBuffer.subarray(newline + 1);
    if (line.length > 0) dispatch(line);
  }
  if (stdinBuffer.length > IDE_BRIDGE_MAX_LINE_BYTES) {
    diagnose("client sent an oversized line; discarding it");
    stdinBuffer = EMPTY;
  }
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  bridge.dispose();
  process.exitCode = 0;
}

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
// The agent can vanish mid-write; that is a clean shutdown, not a crash.
process.stdout.on("error", shutdown);
process.stdin.on("error", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
