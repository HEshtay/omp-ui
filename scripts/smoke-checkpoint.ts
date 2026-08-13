/**
 * End-to-end smoke test for workspace checkpoints, outside VS Code.
 *
 * Drives the production `CheckpointStore` against a real git repository in a
 * temp dir: snapshot, then mutate the tree in every way that matters — a text
 * edit, a deletion, a brand-new *binary* file, and an edit to a `.gitignore`d
 * path — and revert. Asserts the tree comes back byte-for-byte, that the file
 * created after the checkpoint is gone, and that the ignored path was never
 * touched, because ignored paths are outside a snapshot by construction.
 *
 * The binary cases are the point: `restore` moves a `git diff --binary` patch
 * between two git processes, and a patch that is decoded and re-encoded on the
 * way through corrupts files while reporting success.
 *
 * The store's only `vscode` import is a type, so this runs as plain Node with a
 * four-method log shim.
 *
 *   npm run smoke:checkpoint
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CheckpointStore } from "../src/checkpoint/store";

const SESSION_TOKEN = "smoke-checkpoint";

const A_ORIGINAL = Buffer.from("first line\nsecond line\n", "utf8");
const B_ORIGINAL = Buffer.from("nested file\n", "utf8");
const IGNORED_ORIGINAL = Buffer.from("build junk\n", "utf8");
const IGNORED_AFTER = Buffer.from("rewritten build junk\n", "utf8");

/** Leading NUL so git classifies it as binary; 0xFF so utf8 decoding would maul it. */
const C_BINARY = Buffer.from([0x00, 0xff, 0x7f, 0x01, 0x00, 0xfe, 0x42, 0x80, 0xff]);
const BIN_CHECKPOINTED = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x80, 0x7f, 0xc0, 0xff, 0x00]);
const BIN_CLOBBERED = Buffer.from([0xff, 0x00, 0x00, 0x13, 0xfd]);

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

/**
 * The store's only use of `vscode` is the `LogOutputChannel` type, and its only
 * use of a channel is logging, so no-ops satisfy it. Cast here rather than
 * loosening the store's own signature.
 */
const output = {
	debug(message: string): void {
		if (process.env.SMOKE_VERBOSE) console.log(`     debug: ${message}`);
	},
	info(): void {},
	warn(message: string): void {
		console.log(`     warn: ${message}`);
	},
	error(message: string): void {
		console.log(`     error: ${message}`);
	},
} as unknown as Parameters<typeof CheckpointStore.create>[2];

let repo: string | undefined;

/** Fixture git, separate from the store's own: a failure here is a broken test, so throw. */
function git(...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false, windowsHide: true });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim() || result.error?.message || result.status}`);
	}
	return result.stdout;
}

function write(relative: string, content: Buffer): void {
	const target = path.join(repo ?? "", relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

function read(relative: string): Buffer {
	return fs.readFileSync(path.join(repo ?? "", relative));
}

function exists(relative: string): boolean {
	return fs.existsSync(path.join(repo ?? "", relative));
}

/** Collapse multi-line output, so one `check` stays one line. */
function flat(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Every temp dir made, so no exit path leaks one. */
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function cleanup(): void {
	repo = undefined;
	// The store's `dispose()` cleanup is fire-and-forget, so a git process may
	// still hold one of these; Windows refuses to unlink a live process's cwd.
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

function checkpointRefs(): string[] {
	return git("for-each-ref", "--format=%(refname)", "refs/omp/checkpoints")
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

async function main(): Promise<void> {
	const root = tempDir("omp-checkpoint-");
	repo = root;

	git("init", "-q");
	git("config", "user.email", "smoke@omp.invalid");
	git("config", "user.name", "omp smoke");
	// A global signing key or a global `core.autocrlf` would make the fixture's
	// own commit depend on the machine running it. The *store* is proven against
	// autocrlf separately; here the fixture must be deterministic.
	git("config", "commit.gpgsign", "false");
	git("config", "core.autocrlf", "false");

	write("a.txt", A_ORIGINAL);
	write("sub/b.txt", B_ORIGINAL);
	write(".gitignore", Buffer.from("ignored/\n", "utf8"));
	write("ignored/junk.txt", IGNORED_ORIGINAL);
	git("add", "-A");
	git("commit", "-qm", "initial");

	const store = await CheckpointStore.create(root, SESSION_TOKEN, output);
	check("create() resolves a store inside a work tree", store !== undefined);
	if (!store) return;

	const first = await store.snapshot(0, "make the change I asked for\nsecond line of prompt");
	check("snapshot() returns a 40-char sha", /^[0-9a-f]{40}$/.test(first?.id ?? ""), first?.id);
	if (!first) return;
	check("the snapshot label is the clipped first prompt line", first.label === "make the change I asked for", first.label);
	check("find() accepts a short sha prefix", store.find(first.id.slice(0, 8))?.id === first.id);

	// The agent's turn: edit, delete, create binary, and scribble on an ignored path.
	write("a.txt", Buffer.from("clobbered by the agent\n", "utf8"));
	fs.rmSync(path.join(root, "sub", "b.txt"));
	write("c.txt", C_BINARY);
	write("ignored/junk.txt", IGNORED_AFTER);

	const preview = await store.preview(first.id);
	check("preview() counts exactly the three in-scope files", preview.files === 3, `files=${preview.files}`);
	check("preview() omits the ignored path from its stat", !preview.stat.includes("ignored/"), flat(preview.stat));

	const reverted = await store.restore(first.id);
	check("restore() reports three files changed", reverted === 3, String(reverted));
	check("restore() puts the edited file back byte-for-byte", read("a.txt").equals(A_ORIGINAL), flat(read("a.txt").toString("utf8")));
	check("restore() recreates the deleted file", exists("sub/b.txt") && read("sub/b.txt").equals(B_ORIGINAL));
	check("restore() removes a file created after the checkpoint", !exists("c.txt"));
	check(
		"restore() leaves a .gitignore'd path alone",
		read("ignored/junk.txt").equals(IGNORED_AFTER),
		flat(read("ignored/junk.txt").toString("utf8")),
	);

	const settled = await store.preview(first.id);
	check("preview() reports no drift once the tree matches the checkpoint", settled.files === 0, flat(settled.stat));
	check("restore() on an empty diff is a no-op", (await store.restore(first.id)) === 0);

	// Round two: the checkpoint itself holds binary content that is then rewritten.
	write("bin.dat", BIN_CHECKPOINTED);
	const second = await store.snapshot(1, "now touch the binary");
	check("a second snapshot succeeds", /^[0-9a-f]{40}$/.test(second?.id ?? ""), second?.id);
	if (!second) return;

	write("bin.dat", BIN_CLOBBERED);
	check("the binary really was rewritten", !read("bin.dat").equals(BIN_CHECKPOINTED));
	const binaryReverted = await store.restore(second.id);
	check("restore() reports the binary file changed", binaryReverted === 1, String(binaryReverted));
	check(
		"restore() rebuilds binary content byte-exactly",
		read("bin.dat").equals(BIN_CHECKPOINTED),
		read("bin.dat").toString("hex"),
	);

	const anchored = checkpointRefs();
	check("each snapshot is anchored by its own ref", anchored.length === 2, anchored.join(","));
	check("records are kept oldest first", store.records.map(record => record.turnIndex).join(",") === "0,1");

	await store.clear();
	check("clear() removes every checkpoint ref", checkpointRefs().length === 0, checkpointRefs().join(","));
	check("clear() empties the record list", store.records.length === 0);

	store.dispose();
	store.dispose();
	check("dispose() is synchronous and idempotent", true);

	// The degraded contract: no repository, no checkpoints, no throw. Skipped if
	// this machine's temp dir happens to sit inside somebody's repository.
	const outside = tempDir("omp-no-repo-");
	const probe = spawnSync("git", ["-C", outside, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		shell: false,
		windowsHide: true,
	});
	if (probe.status === 0) {
		console.log(`skip create() outside a work tree — ${outside} is inside ${probe.stdout.trim()}`);
	} else {
		const none = await CheckpointStore.create(outside, SESSION_TOKEN, output);
		check("create() resolves undefined outside a work tree", none === undefined);
	}
	// Let the fire-and-forget cleanup child exit before we delete its cwd.
	await sleep(250);
}

main().then(
	() => {
		cleanup();
		console.log(
			failures.length === 0
				? "\nPASS — all checkpoint checks passed"
				: `\nFAIL — ${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`,
		);
		process.exit(failures.length === 0 ? 0 : 1);
	},
	error => {
		cleanup();
		console.error(`\nFAIL — smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
		process.exit(1);
	},
);
