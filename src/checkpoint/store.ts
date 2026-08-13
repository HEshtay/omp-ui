import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

/**
 * Workspace snapshots, so there is an undo.
 *
 * omp's own `checkpoint`/`rewind` rewind the *conversation* only — they do not
 * touch the filesystem, whatever their summary string claims — and omp defaults
 * to `yolo` approval, so an agent turn can rewrite a tree with nothing to fall
 * back on. This store takes a full snapshot of the work tree before each turn
 * and can put it back.
 *
 * **It is built on git plumbing exclusively, and it borrows nothing.** A
 * snapshot never touches HEAD, the user's index, the stash, any branch, or the
 * working tree; a restore is the only operation that writes files. Concretely:
 * `git add -A` runs against a throwaway index in the temp dir named by
 * `GIT_INDEX_FILE`, `git write-tree` turns that into a tree object, and
 * `git commit-tree` wraps it in a **parentless** commit. Nothing in the user's
 * `.git` changes except one ref under `refs/omp/checkpoints/`, which exists only
 * to keep the commit off the GC's list and is deleted on `clear()`/`dispose()`.
 *
 * Parentless commits also mean this works in a repo whose HEAD is unborn, which
 * matters because a brand-new project is exactly when an agent is most
 * destructive.
 *
 * One consequence is load-bearing: `git add -A` honours `.gitignore`, so
 * ignored paths (`node_modules`, `dist`, build caches) are outside every
 * snapshot *and* outside every restore. That is intended. Snapshotting them
 * would make each checkpoint cost hundreds of megabytes, and reverting them
 * would delete build output the user's tooling owns rather than the agent.
 */

/** Message on every snapshot commit; the commits are machinery, never shown. */
const SNAPSHOT_MESSAGE = "omp checkpoint";

/**
 * Snapshots are cheap (a tree object shares blobs with everything already in
 * the odb) but not free, and a session with more than 50 undo points is a
 * session where the oldest ones have no meaning left.
 */
const MAX_RECORDS = 50;

const MAX_LABEL_CHARS = 120;

/** A `--stat` body is model-facing context, not a report; a page of it is plenty. */
const MAX_STAT_CHARS = 8_000;

/** A short sha the model echoed back is still unambiguous at this length. */
const MIN_PREFIX_CHARS = 7;

export interface CheckpointRecord {
  /** Commit sha of the snapshot. */
  readonly id: string;
  /** Number of user messages that preceded this snapshot. */
  readonly turnIndex: number;
  readonly createdAt: number;
  /** Clipped first line of the prompt that followed. */
  readonly label: string;
}

export interface RevertPreview {
  readonly files: number;
  readonly stat: string;
}

interface GitResult {
  /** `-1` when git could not be spawned at all. */
  readonly code: number;
  /** Left as bytes: a `--binary` patch must round-trip unmodified. */
  readonly stdout: Buffer;
  readonly stderr: string;
}

interface GitOptions {
  readonly stdin?: Buffer;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run git and capture it whole.
 *
 * stdout stays a `Buffer` on purpose. `restore()` moves a `git diff --binary`
 * patch from one git process into another, and a patch decoded to utf8 and
 * re-encoded is a patch whose base85 literal blobs and CRLF bytes may no longer
 * be what git wrote — which corrupts the user's files while reporting success.
 * Callers decode only the outputs they know are text.
 */
function runGit(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  // Executor form, not `Promise.withResolvers`: Node 20 (the floor in
  // `engines`) does not have it.
  return new Promise<GitResult>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    // An inherited GIT_INDEX_FILE would silently redirect `add`/`write-tree` at
    // someone else's index, so only our own snapshot calls may set it.
    if (options.env?.GIT_INDEX_FILE === undefined) delete env.GIT_INDEX_FILE;

    const child = spawn("git", [...args], { cwd, env, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const settle = (code: number, stderrText: string): void => {
      resolve({ code, stdout: Buffer.concat(stdout), stderr: stderrText.trim() });
    };
    // A missing git binary arrives as a spawn error, not an exit code.
    // Normalising it to a result gives every caller one failure shape.
    child.on("error", (error: Error) => settle(-1, error.message));
    child.on("close", (code) => settle(code ?? -1, Buffer.concat(stderr).toString("utf8")));

    // Always close stdin: git waiting on a pipe that never ends never exits.
    child.stdin.on("error", () => {
      /* A patch rejected before we finish writing surfaces as a non-zero exit. */
    });
    child.stdin.end(options.stdin);
  });
}

function gitFailure(result: GitResult): string {
  return result.stderr || `git exited ${result.code}`;
}

function text(result: GitResult): string {
  return result.stdout.toString("utf8").trim();
}

/**
 * Refnames forbid whitespace, `~^:?*[\`, `..` and a trailing `.lock`. The token
 * only has to be stable and unique per session, so squashing everything outside
 * a safe alphabet — dots included — is free.
 */
function refSafe(token: string): string {
  const safe = token.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "session";
}

function clipLabel(label: string): string {
  const firstLine = label.split("\n", 1)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_LABEL_CHARS ? collapsed : `${collapsed.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function clipStat(stat: string): string {
  const body = stat.trimEnd();
  if (body.length <= MAX_STAT_CHARS) return body;
  const head = body.slice(0, MAX_STAT_CHARS);
  const lastBreak = head.lastIndexOf("\n");
  return `${lastBreak > 0 ? head.slice(0, lastBreak) : head}\n… (truncated)`;
}

/**
 * git's own trailing `N files changed` line is authoritative; counting the
 * per-file rows is the fallback for a git that stops printing it.
 */
function countChangedFiles(stat: string): number {
  const lines = stat.split("\n").filter((line) => line.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) return 0;
  const summary = /^\s*(\d+) files? changed/.exec(last)?.[1];
  return summary === undefined ? lines.length : Number(summary);
}

export class CheckpointStore {
  readonly #repoRoot: string;
  readonly #refPrefix: string;
  readonly #output: vscode.LogOutputChannel;
  readonly #records: CheckpointRecord[] = [];
  #disposed = false;

  private constructor(repoRoot: string, sessionToken: string, output: vscode.LogOutputChannel) {
    this.#repoRoot = repoRoot;
    this.#refPrefix = `refs/omp/checkpoints/${refSafe(sessionToken)}`;
    this.#output = output;
  }

  /**
   * Resolves `undefined` — never throws — when git is missing or `cwd` is not
   * inside a work tree. Checkpointing is a bonus capability; a workspace
   * without git still gets a working agent, just no undo.
   */
  static async create(
    cwd: string,
    sessionToken: string,
    output: vscode.LogOutputChannel,
  ): Promise<CheckpointStore | undefined> {
    const probe = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const repoRoot = text(probe);
    if (probe.code !== 0 || repoRoot.length === 0) {
      output.debug(`checkpoints: unavailable in ${cwd}: ${gitFailure(probe)}`);
      return undefined;
    }
    return new CheckpointStore(repoRoot, sessionToken, output);
  }

  /** Oldest first. */
  get records(): readonly CheckpointRecord[] {
    return this.#records;
  }

  /** The work tree as it stands, recorded as the point `turnIndex` can return to. */
  async snapshot(turnIndex: number, label: string): Promise<CheckpointRecord | undefined> {
    if (this.#disposed) return undefined;
    const id = await this.#snapshotCommit();
    if (id === undefined) return undefined;

    const ref = `${this.#refPrefix}/${turnIndex}`;
    const update = await this.#git(["update-ref", ref, id]);
    if (update.code !== 0) {
      // The commit is real and restorable right now, just unreachable and so at
      // the mercy of the next `git gc`. Losing an undo point later beats
      // refusing to offer one at all.
      this.#output.warn(`checkpoints: could not anchor ${id.slice(0, 8)} at ${ref}: ${gitFailure(update)}`);
    }

    const record: CheckpointRecord = { id, turnIndex, createdAt: Date.now(), label: clipLabel(label) };
    // A repeated `turnIndex` is the same logical point re-taken (a retried
    // turn), and its ref has just been overwritten, so it replaces the old
    // record rather than stranding it.
    const existing = this.#records.findIndex((candidate) => candidate.turnIndex === turnIndex);
    if (existing >= 0) this.#records.splice(existing, 1);
    this.#records.push(record);
    await this.#trim();
    return record;
  }

  /** What reverting to `id` would do — hence the diff runs *from* now *to* the checkpoint. */
  async preview(id: string): Promise<RevertPreview> {
    const now = await this.#requireSnapshot();
    const diff = await this.#git(["diff", "--stat", now, id]);
    if (diff.code !== 0) throw new Error(`could not diff checkpoint ${id}: ${gitFailure(diff)}`);
    const stat = text(diff);
    return { files: countChangedFiles(stat), stat: clipStat(stat) };
  }

  /** Puts the work tree back as it was at `id`. Returns the number of files changed. */
  async restore(id: string): Promise<number> {
    const now = await this.#requireSnapshot();

    const names = await this.#git(["diff", "--name-only", now, id]);
    if (names.code !== 0) throw new Error(`could not diff checkpoint ${id}: ${gitFailure(names)}`);
    const files = text(names).split("\n").filter((line) => line.length > 0).length;

    const diff = await this.#git(["diff", "--binary", now, id]);
    if (diff.code !== 0) throw new Error(`could not diff checkpoint ${id}: ${gitFailure(diff)}`);
    // `now` was staged from the work tree moments ago, so every context line
    // matches and no three-way merge is needed, and the patch's deletion hunks
    // remove whatever was created after the checkpoint. Line-ending conversion
    // stays symmetric — `add` normalises into the blob, `apply` converts back
    // out — so the round-trip is byte-exact even under Windows' default
    // `core.autocrlf=true`.
    const patch = diff.stdout;
    if (patch.length === 0) return 0;

    const apply = await this.#git(["apply", "--binary", "--whitespace=nowarn", "-"], { stdin: patch });
    // A partially applied patch is a corrupted work tree. Say so loudly; the
    // caller must not report a successful revert over the top of it.
    if (apply.code !== 0) throw new Error(`could not restore checkpoint ${id}: ${gitFailure(apply)}`);
    return files;
  }

  /** Exact sha, or an unambiguous prefix of one, as the model tends to shorten. */
  find(id: string): CheckpointRecord | undefined {
    const needle = id.trim();
    const exact = this.#records.find((record) => record.id === needle);
    if (exact || needle.length < MIN_PREFIX_CHARS) return exact;
    const matches = this.#records.filter((record) => record.id.startsWith(needle));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Forget every checkpoint and release the commits back to git's GC. */
  async clear(): Promise<void> {
    this.#records.length = 0;
    await this.#deleteRefs();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#records.length = 0;
    // Fire-and-forget: shutdown will not wait for us. A ref that outlives the
    // window is inert — it is namespaced per session, holds one unreachable
    // commit, and the next `clear()` for that session sweeps it.
    void this.#deleteRefs().catch((error: unknown) => {
      this.#output.debug(`checkpoints: ref cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Commit the current work tree without disturbing anything: a fresh index in
   * the temp dir, so `add -A` stages into a file nobody else reads, and no
   * parent, so the commit is a standalone snapshot rather than history.
   */
  async #snapshotCommit(): Promise<string | undefined> {
    const indexFile = path.join(os.tmpdir(), `omp-checkpoint-${randomBytes(8).toString("hex")}.index`);
    const env: NodeJS.ProcessEnv = {
      GIT_INDEX_FILE: indexFile,
      // `commit-tree` refuses to run without a committer identity. A repo with
      // no configured user must still be snapshottable, and the identity on a
      // commit the user never sees carries no meaning.
      GIT_AUTHOR_NAME: "omp",
      GIT_AUTHOR_EMAIL: "omp@localhost",
      GIT_COMMITTER_NAME: "omp",
      GIT_COMMITTER_EMAIL: "omp@localhost",
    };
    try {
      const staged = await this.#git(["add", "-A"], { env });
      if (staged.code !== 0) return this.#snapshotFailed("add", staged);

      const tree = await this.#git(["write-tree"], { env });
      if (tree.code !== 0) return this.#snapshotFailed("write-tree", tree);

      const commit = await this.#git(["commit-tree", text(tree), "-m", SNAPSHOT_MESSAGE], { env });
      if (commit.code !== 0) return this.#snapshotFailed("commit-tree", commit);
      return text(commit);
    } finally {
      // git writes `<index>.lock` next to the index and renames it into place;
      // a failed call can leave the lock behind.
      await fs.promises.rm(indexFile, { force: true }).catch(() => undefined);
      await fs.promises.rm(`${indexFile}.lock`, { force: true }).catch(() => undefined);
    }
  }

  #snapshotFailed(stage: string, result: GitResult): undefined {
    this.#output.warn(`checkpoints: snapshot failed at git ${stage}: ${gitFailure(result)}`);
    return undefined;
  }

  /** Both comparisons need a commit standing for "the tree right now". */
  async #requireSnapshot(): Promise<string> {
    if (this.#disposed) throw new Error("checkpoint store has been disposed");
    const now = await this.#snapshotCommit();
    if (now === undefined) throw new Error("could not snapshot the current workspace to compare against");
    return now;
  }

  async #trim(): Promise<void> {
    while (this.#records.length > MAX_RECORDS) {
      const dropped = this.#records.shift();
      if (!dropped) return;
      await this.#git(["update-ref", "-d", `${this.#refPrefix}/${dropped.turnIndex}`]);
    }
  }

  async #deleteRefs(): Promise<void> {
    const listed = await this.#git(["for-each-ref", "--format=%(refname)", this.#refPrefix]);
    if (listed.code !== 0) {
      this.#output.debug(`checkpoints: could not list ${this.#refPrefix}: ${gitFailure(listed)}`);
      return;
    }
    for (const ref of text(listed).split("\n")) {
      const name = ref.trim();
      if (name.length === 0) continue;
      const deleted = await this.#git(["update-ref", "-d", name]);
      if (deleted.code !== 0) this.#output.debug(`checkpoints: could not delete ${name}: ${gitFailure(deleted)}`);
    }
  }

  /**
   * `-C` pins the repository even if the process cwd moves, and the spawn cwd
   * matches it so `git apply` resolves patch paths from the repo root.
   */
  #git(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
    return runGit(this.#repoRoot, ["-C", this.#repoRoot, ...args], options);
  }
}
