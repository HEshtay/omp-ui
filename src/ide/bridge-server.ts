import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import {
  IDE_BRIDGE_MAX_LINE_BYTES,
  IDE_BRIDGE_NEWLINE,
  type IdeBridgeNotification,
  type IdeBridgeRequest,
  type IdeBridgeResponse,
} from "./protocol";
import type { IdeTool, IdeToolContext } from "./tools/types";

/**
 * `sun_path` is 104 bytes on macOS (108 on Linux); staying under 104 including
 * the NUL terminator keeps the socket path portable.
 */
const POSIX_SOCKET_PATH_MAX = 104;

const EMPTY = Buffer.alloc(0);

interface Connection {
  socket: net.Socket;
  /** Bytes received since the last newline. */
  buffer: Buffer;
  /** Working directory from the `hello` frame, if it has arrived. */
  cwd: string | undefined;
  /** Only warn once per connection about a missing `hello`. */
  warnedMissingHello: boolean;
}

/** Platform-correct, collision-free path for one listener instance. */
function freshPipePath(): string {
  const token = randomBytes(8).toString("hex");
  if (process.platform === "win32") return `\\\\.\\pipe\\omp-ide-${token}`;
  const name = `omp-ide-${token}.sock`;
  const preferred = path.join(os.tmpdir(), name);
  // A long TMPDIR (macOS per-user temp dirs are deep) would overflow sun_path.
  return preferred.length < POSIX_SOCKET_PATH_MAX ? preferred : path.join("/tmp", name);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * Extension-host end of the IDE bridge: a newline-delimited JSON listener that
 * serves the `IdeTool` registry to shim processes.
 *
 * One listener serves every agent process in the window; each connection is a
 * separate agent, so requests on a connection are handled **concurrently** and
 * a misbehaving connection is isolated (malformed lines are dropped, an
 * oversized line destroys only that socket).
 */
export class IdeBridgeServer implements vscode.Disposable {
  readonly #output: vscode.LogOutputChannel;
  readonly #tools: IdeTool[];
  readonly #connections = new Set<Connection>();
  #server: net.Server | undefined;
  #pipePath: string | undefined;
  #starting: Promise<string> | undefined;
  #disposed = false;

  constructor(options: { output: vscode.LogOutputChannel; tools: IdeTool[] }) {
    this.#output = options.output;
    this.#tools = options.tools;
  }

  /** The listening pipe/socket path, once `start()` has resolved. */
  get pipePath(): string | undefined {
    return this.#pipePath;
  }

  /** Idempotent: concurrent and repeat calls share one listener. */
  async start(): Promise<string> {
    if (this.#disposed) throw new Error("IdeBridgeServer has been disposed");
    if (this.#pipePath) return this.#pipePath;
    this.#starting ??= this.#listen().catch((error: unknown) => {
      // Let a later attempt retry rather than caching the rejection forever.
      this.#starting = undefined;
      throw error;
    });
    return await this.#starting;
  }

  /** Tell every connected shim to re-issue `tools/list`. */
  notifyToolsChanged(): void {
    const notification: IdeBridgeNotification = { op: "tools_changed" };
    for (const connection of this.#connections) this.#write(connection, notification);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const pipePath = this.#pipePath;
    this.#pipePath = undefined;
    this.#starting = undefined;
    for (const connection of this.#connections) connection.socket.destroy();
    this.#connections.clear();
    this.#server?.close();
    this.#server = undefined;
    if (pipePath && process.platform !== "win32") {
      try {
        fs.rmSync(pipePath, { force: true });
      } catch (error: unknown) {
        this.#output.debug(`ide bridge: could not unlink ${pipePath}: ${errorMessage(error)}`);
      }
    }
    this.#output.info("ide bridge: stopped");
  }

  async #listen(): Promise<string> {
    const pipePath = freshPipePath();
    if (process.platform !== "win32") {
      // A crashed host can leave the socket file behind; bind would fail on it.
      await fs.promises.rm(pipePath, { force: true });
    }
    const server = net.createServer((socket) => this.#accept(socket));
    // Executor form, not `Promise.withResolvers`: Node 20 (the floor in
    // `engines`) does not have it.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(pipePath);
    });
    server.on("error", (error: Error) => {
      this.#output.error(`ide bridge: listener error: ${errorMessage(error)}`);
    });
    if (this.#disposed) {
      // Disposed while binding: don't leak the listener.
      server.close();
      if (process.platform !== "win32") await fs.promises.rm(pipePath, { force: true });
      throw new Error("IdeBridgeServer has been disposed");
    }
    this.#server = server;
    this.#pipePath = pipePath;
    this.#output.info(`ide bridge: listening on ${pipePath} (${this.#tools.length} tools)`);
    return pipePath;
  }

  #accept(socket: net.Socket): void {
    const connection: Connection = { socket, buffer: EMPTY, cwd: undefined, warnedMissingHello: false };
    this.#connections.add(connection);
    this.#output.info(`ide bridge: client connected (${this.#connections.size} live)`);
    socket.on("data", (chunk: Buffer) => this.#receive(connection, chunk));
    socket.on("error", (error: Error) => {
      this.#output.debug(`ide bridge: socket error: ${errorMessage(error)}`);
    });
    socket.on("close", () => {
      this.#connections.delete(connection);
      connection.buffer = EMPTY;
      this.#output.info(`ide bridge: client disconnected (${this.#connections.size} live)`);
    });
  }

  #receive(connection: Connection, chunk: Buffer): void {
    connection.buffer = connection.buffer.length === 0 ? chunk : Buffer.concat([connection.buffer, chunk]);
    for (;;) {
      const newline = connection.buffer.indexOf(IDE_BRIDGE_NEWLINE);
      if (newline === -1) break;
      const line = connection.buffer.subarray(0, newline).toString("utf8").trim();
      connection.buffer = connection.buffer.subarray(newline + 1);
      if (line.length > 0) this.#dispatch(connection, line);
    }
    if (connection.buffer.length > IDE_BRIDGE_MAX_LINE_BYTES) {
      this.#output.warn(
        `ide bridge: dropping client after ${connection.buffer.length} bytes without a newline`,
      );
      connection.buffer = EMPTY;
      connection.socket.destroy();
    }
  }

  #dispatch(connection: Connection, line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.#output.debug(`ide bridge: ignoring malformed line (${line.length} chars)`);
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      this.#output.debug("ide bridge: ignoring non-object frame");
      return;
    }
    const request = frame as Partial<IdeBridgeRequest> & Record<string, unknown>;
    if (request.op === "hello") {
      const cwd = request.cwd;
      if (typeof cwd === "string" && cwd.length > 0) {
        connection.cwd = cwd;
        this.#output.debug(`ide bridge: hello cwd=${cwd}`);
      } else {
        this.#output.debug("ide bridge: ignoring hello without cwd");
      }
      return;
    }
    const id = request.id;
    if (typeof id !== "number") {
      this.#output.debug(`ide bridge: ignoring frame without numeric id (op=${String(request.op)})`);
      return;
    }
    if (request.op === "list") {
      this.#write(connection, {
        id,
        ok: true,
        result: {
          tools: this.#tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      });
      return;
    }
    if (request.op === "call") {
      // Deliberately not awaited: concurrent calls on one connection.
      void this.#invoke(connection, id, request.tool, request.args);
      return;
    }
    this.#output.debug(`ide bridge: ignoring unknown op ${String(request.op)}`);
  }

  async #invoke(connection: Connection, id: number, name: unknown, args: unknown): Promise<void> {
    if (typeof name !== "string" || name.length === 0) {
      this.#write(connection, { id, ok: false, error: "call requires a tool name" });
      return;
    }
    const tool = this.#tools.find((candidate) => candidate.name === name);
    if (!tool) {
      this.#write(connection, { id, ok: false, error: `unknown tool: ${name}` });
      return;
    }
    if (!connection.cwd && !connection.warnedMissingHello) {
      connection.warnedMissingHello = true;
      this.#output.warn(`ide bridge: call ${name} before hello; falling back to ${process.cwd()}`);
    }
    const context: IdeToolContext = { cwd: connection.cwd ?? process.cwd(), output: this.#output };
    // A non-object `args` payload is treated as no arguments at all.
    const payload =
      typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const started = Date.now();
    try {
      const text = await tool.invoke(payload, context);
      this.#output.info(`ide bridge: ${name} ok in ${Date.now() - started}ms`);
      this.#write(connection, { id, ok: true, result: { text } });
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.#output.info(`ide bridge: ${name} error in ${Date.now() - started}ms: ${message}`);
      // A tool failure is a successful RPC carrying an error result, so the
      // model reads the message and can adapt. `ok: false` is for bridge faults.
      this.#write(connection, { id, ok: true, result: { text: message, isError: true } });
    }
  }

  #write(connection: Connection, message: IdeBridgeResponse | IdeBridgeNotification): void {
    const { socket } = connection;
    if (socket.destroyed || socket.writableEnded) return;
    socket.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.#output.debug(`ide bridge: write failed: ${errorMessage(error)}`);
    });
  }
}
