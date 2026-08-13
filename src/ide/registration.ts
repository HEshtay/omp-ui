import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IDE_BRIDGE_CWD_ENV, IDE_BRIDGE_PIPE_ENV, IDE_BRIDGE_SERVER_NAME } from "./protocol";

/**
 * omp discovers MCP servers *only* from `mcp.json` files — the project's
 * `.omp/mcp.json` and the user's `~/.omp/agent/mcp.json`. Neither `config.yml`
 * nor a `--config` overlay can declare one, so registering the IDE bridge means
 * editing the user-level file in place. The user file rather than the project
 * file, so the bridge follows the developer across every repository and never
 * shows up in a diff.
 */
const MCP_CONFIG_PATH = path.join(os.homedir(), ".omp", "agent", "mcp.json");

const MCP_SCHEMA_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** Structural equality over parsed JSON, so an unchanged entry skips the write. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}

/**
 * Read the user MCP config, or `undefined` when it must not be written.
 *
 * A missing or empty file yields an empty document. A *malformed* one yields
 * `undefined`: silently replacing a config a human hand-edited (and broke)
 * would destroy their other servers, which is far worse than not registering.
 */
async function readConfig(
  log: (message: string) => void,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(MCP_CONFIG_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    log(`cannot read ${MCP_CONFIG_PATH}: ${String(error)}`);
    return undefined;
  }
  if (raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log(`refusing to touch ${MCP_CONFIG_PATH}: not valid JSON (${String(error)})`);
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log(`refusing to touch ${MCP_CONFIG_PATH}: expected a JSON object at the top level`);
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(MCP_CONFIG_PATH), { recursive: true });
  await writeFile(MCP_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Point `~/.omp/agent/mcp.json` at this build's shim, idempotently.
 *
 * Called on every activation, because the shim path lives inside the extension
 * install directory and moves on upgrade — the registration has to self-heal.
 * Every unrelated key and every other server entry survives: we parse, mutate
 * only our own `mcpServers` slot, and re-serialize.
 */
export async function registerIdeBridge(
  shimPath: string,
  log: (message: string) => void,
): Promise<void> {
  const config = await readConfig(log);
  if (!config) return;

  const existing = config.mcpServers;
  const servers =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  const entry = {
    // VS Code's own binary is Electron, and nothing guarantees a plain `node`
    // on the agent's PATH. ELECTRON_RUN_AS_NODE=1 (below) makes that same
    // binary behave as a bare Node interpreter, so `process.execPath` is always
    // a usable runtime for the shim.
    command: process.execPath,
    args: [shimPath],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // Deliberately the *names* of the variables, not their values: before
      // connecting, omp resolves an `env` value that names a **set**
      // environment variable to that variable's contents. So the shim receives
      // whatever this extension put on the `omp` child's environment under
      // these two keys — the bridge address stays per-window and per-session
      // instead of being baked into a global config file.
      //
      // When the variable is *unset* — a terminal `omp` this extension did not
      // launch — the resolution falls through and the shim is handed the
      // literal string `"OMP_IDE_BRIDGE_PIPE"`. The shim treats a value equal
      // to its own variable name as "unconfigured" and advertises zero tools,
      // which is why this indirection is safe in both directions.
      //
      // Do not add `envPolicy: "literal"` here: it disables exactly the
      // resolution this depends on.
      [IDE_BRIDGE_PIPE_ENV]: IDE_BRIDGE_PIPE_ENV,
      [IDE_BRIDGE_CWD_ENV]: IDE_BRIDGE_CWD_ENV,
    },
  };

  if (config.$schema !== undefined && deepEqual(servers[IDE_BRIDGE_SERVER_NAME], entry)) {
    log(`${IDE_BRIDGE_SERVER_NAME} already registered in ${MCP_CONFIG_PATH}`);
    return;
  }

  if (config.$schema === undefined) config.$schema = MCP_SCHEMA_URL;
  servers[IDE_BRIDGE_SERVER_NAME] = entry;
  config.mcpServers = servers;
  await writeConfig(config);
  log(`registered ${IDE_BRIDGE_SERVER_NAME} in ${MCP_CONFIG_PATH} -> ${shimPath}`);
}

/**
 * Remove only our server entry. An emptied `mcpServers` object is left in
 * place; pruning it would be a change we were not asked to make.
 */
export async function unregisterIdeBridge(log: (message: string) => void): Promise<void> {
  const config = await readConfig(log);
  if (!config) return;
  const servers = config.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return;
  if (!(IDE_BRIDGE_SERVER_NAME in servers)) return;
  delete (servers as Record<string, unknown>)[IDE_BRIDGE_SERVER_NAME];
  await writeConfig(config);
  log(`removed ${IDE_BRIDGE_SERVER_NAME} from ${MCP_CONFIG_PATH}`);
}
