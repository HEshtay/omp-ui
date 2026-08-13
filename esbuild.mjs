import { build, context } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions[]} */
const targets = [
	{
		// Extension host: `vscode` is provided by the host at runtime.
		entryPoints: ["src/extension.ts"],
		outfile: "dist/extension.js",
		external: ["vscode"],
	},
	{
		// MCP stdio shim, spawned by the agent outside the extension host. It
		// must not reference `vscode` at all, so nothing is marked external.
		entryPoints: ["src/ide/mcp-shim.ts"],
		outfile: "dist/mcp-shim.js",
	},
].map((target) => ({
	bundle: true,
	platform: "node",
	target: "node20",
	format: "cjs",
	sourcemap: !production,
	minify: production,
	logLevel: "info",
	...target,
}));

if (watch) {
	const contexts = await Promise.all(targets.map((options) => context(options)));
	await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
	await Promise.all(targets.map((options) => build(options)));
}
