/**
 * Wire contract for the IDE-as-MCP-server bridge.
 *
 * The agent (`omp`) discovers MCP servers only from `mcp.json`, and it speaks
 * MCP over a stdio child process. VS Code's API, however, only exists inside
 * the extension host. So the bridge is deliberately **two hops**:
 *
 * ```text
 *   omp agent  ──MCP/JSON-RPC over stdio──▶  dist/mcp-shim.js
 *                                                 │
 *                              this contract, newline-delimited JSON
 *                              over a named pipe (win32) / unix socket
 *                                                 ▼
 *                                    IdeBridgeServer (extension host)
 *                                        → IdeTool.invoke(...)
 * ```
 *
 * The pipe path reaches the shim through `OMP_IDE_BRIDGE_PIPE` in the agent
 * process environment; `OMP_IDE_BRIDGE_CWD` carries the owning session's
 * working directory. An IPC pipe is used rather than an HTTP listener because
 * it needs no TCP port and no bearer token — the OS filesystem/pipe ACL is the
 * authorization boundary.
 *
 * Because the MCP server is registered **user-level**, the same shim is also
 * launched by plain terminal `omp` sessions that this extension does not drive.
 * Those processes have no `OMP_IDE_BRIDGE_PIPE`, so the shim completes the MCP
 * handshake and advertises **zero tools** instead of failing to connect: an
 * unconfigured session sees a silent, tool-less server rather than an error.
 *
 * Both hops are newline-delimited JSON — one JSON object per line, correlated
 * strictly by `id`, with no ordering promise.
 */

/** shim -> host, once per connection, before any request. */
export type IdeBridgeHello = { op: "hello"; cwd: string };

/** shim -> host */
export type IdeBridgeRequest =
  | IdeBridgeHello
  | { id: number; op: "list" }
  | { id: number; op: "call"; tool: string; args: unknown };

/** host -> shim, correlated by id */
export type IdeBridgeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** host -> shim, unsolicited */
export type IdeBridgeNotification = { op: "tools_changed" };

/** `list` result payload */
export interface IdeToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** `result` of a `list` request. */
export interface IdeBridgeListResult {
  tools: IdeToolDescriptor[];
}

/** `result` of a `call` request. A tool-level failure is `isError`, not `ok: false`. */
export interface IdeBridgeCallResult {
  text: string;
  isError?: boolean;
}

export const IDE_BRIDGE_PIPE_ENV = "OMP_IDE_BRIDGE_PIPE";
export const IDE_BRIDGE_CWD_ENV = "OMP_IDE_BRIDGE_CWD";
export const IDE_BRIDGE_SERVER_NAME = "vscode-ide";

/** Frame delimiter for both hops. */
export const IDE_BRIDGE_NEWLINE = 0x0a;

/** A single un-terminated line larger than this is a protocol fault, not a payload. */
export const IDE_BRIDGE_MAX_LINE_BYTES = 1024 * 1024;

/** How long the shim waits for the host pipe to accept a connection. */
export const IDE_BRIDGE_CONNECT_TIMEOUT_MS = 5_000;

/** How long the shim waits for a `list`/`call` response before degrading. */
export const IDE_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
