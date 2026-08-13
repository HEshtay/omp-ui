import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";

export interface SpawnTarget {
	command: string;
	args: string[];
	/** Set when the resolved target is a Windows batch shim invoked through the command processor. */
	windowsVerbatimArguments?: boolean;
	/** The actual file we resolved to, for diagnostics. */
	resolvedPath: string;
}

const WINDOWS = process.platform === "win32";

function isExecutableFile(candidate: string): boolean {
	try {
		if (!statSync(candidate).isFile()) return false;
	} catch {
		return false;
	}
	if (WINDOWS) return true;
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Locate `executable` on PATH, honoring PATHEXT on Windows.
 *
 * Node's spawn only implicitly appends `.exe`, so a `.cmd`/`.ps1` shim — which
 * is what npm-global installs produce — would otherwise fail with ENOENT.
 */
export function findOnPath(executable: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (executable.includes("/") || executable.includes("\\")) {
		const absolute = isAbsolute(executable) ? executable : resolvePath(executable);
		return isExecutableFile(absolute) ? absolute : undefined;
	}

	const extensions = WINDOWS
		? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
		: [""];
	const searchPath = env.PATH ?? env.Path ?? "";
	// Windows resolves the current directory before PATH.
	const roots = WINDOWS ? [process.cwd(), ...searchPath.split(delimiter)] : searchPath.split(delimiter);

	for (const root of roots) {
		if (!root) continue;
		for (const extension of extensions) {
			const candidate = join(root, executable + extension);
			if (isExecutableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * Build a spawnable command for `executable`.
 *
 * Batch shims cannot be executed directly by CreateProcess, so they are routed
 * through the command processor with verbatim arguments — quoting the shim path
 * ourselves, since verbatim mode disables Node's own escaping.
 */
export function resolveSpawnTarget(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env): SpawnTarget {
	const resolved = findOnPath(executable, env);
	if (!resolved) {
		// Let the OS produce the ENOENT so the error message names the binary.
		return { command: executable, args, resolvedPath: executable };
	}

	const lower = resolved.toLowerCase();
	if (WINDOWS && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
		const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
		return {
			command: comspec,
			args: ["/d", "/s", "/c", `"${resolved}" ${args.map(quoteForCmd).join(" ")}`],
			windowsVerbatimArguments: true,
			resolvedPath: resolved,
		};
	}

	return { command: resolved, args, resolvedPath: resolved };
}

function quoteForCmd(arg: string): string {
	if (arg.length > 0 && !/[\s"^&|<>()]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '\\"')}"`;
}
