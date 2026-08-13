import * as path from "node:path";
import * as vscode from "vscode";
import { MAX_RESULT_CHARS, clip, optBool, optString, plural, relPath, resolveUri, truncate } from "./format";
import type { IdeTool, IdeToolContext } from "./types";
import { isRecord } from "../../shared/guards";

/**
 * `scm_diff` — the actual change set, which is what review and commit stages
 * need. We go through the built-in `vscode.git` extension rather than shelling
 * out to `git`, so we report exactly the repository VS Code has open.
 *
 * That API is untyped from our side (we deliberately depend on no git typings),
 * so the interfaces below are a minimal structural mirror of *only* the members
 * we touch, established by runtime guards. A missing extension or a changed
 * shape degrades to a plain "unavailable" message instead of throwing.
 */

interface GitChange {
  readonly filePath: string;
  readonly originalPath: string | undefined;
  /** `vscode.git`'s `Status` enum value, or -1 when absent. */
  readonly status: number;
}

interface GitRepositoryState {
  readonly indexChanges?: unknown;
  readonly workingTreeChanges?: unknown;
}

interface GitRepository {
  readonly rootUri: { readonly fsPath: string };
  readonly state: GitRepositoryState;
  /** Given a path argument, the git API resolves to unified patch text. */
  diffWithHEAD(filePath: string): Promise<unknown>;
  diffIndexWithHEAD(filePath: string): Promise<unknown>;
}

interface GitApi {
  readonly repositories: readonly unknown[];
}

/**
 * `vscode.git`'s `Status` enum, by value, mapped to porcelain letters
 * (extensions/git/src/api/git.d.ts: INDEX_MODIFIED … BOTH_MODIFIED).
 */
const STATUS_LETTERS = [
  "M", // 0  INDEX_MODIFIED
  "A", // 1  INDEX_ADDED
  "D", // 2  INDEX_DELETED
  "R", // 3  INDEX_RENAMED
  "R", // 4  INDEX_COPIED
  "M", // 5  MODIFIED
  "D", // 6  DELETED
  "?", // 7  UNTRACKED
  "?", // 8  IGNORED
  "A", // 9  INTENT_TO_ADD
  "U", // 10 ADDED_BY_US
  "U", // 11 ADDED_BY_THEM
  "U", // 12 DELETED_BY_US
  "U", // 13 DELETED_BY_THEM
  "U", // 14 BOTH_ADDED
  "U", // 15 BOTH_DELETED
  "U", // 16 BOTH_MODIFIED
] as const;

/** INDEX_RENAMED and INDEX_COPIED carry a meaningful `originalUri`. */
const RENAMED_STATUSES: Record<number, true> = { 3: true, 4: true };

export const scmTools: IdeTool[] = [
  {
    name: "scm_diff",
    description:
      "The current git change set as VS Code sees it: unified patch text for the working tree (or the index) against HEAD, or a name+status summary with `stat`. Use before review, commit, or summarising your own work.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Limit the diff to one file (workspace-relative or absolute).",
        },
        staged: {
          type: "boolean",
          description: "true = staged changes (index vs HEAD); false (default) = working tree vs HEAD.",
        },
        stat: {
          type: "boolean",
          description: "true = status letters and paths only, no patch bodies. Defaults to false.",
        },
      },
      additionalProperties: false,
    },
    invoke: runScmDiff,
  },
];

async function runScmDiff(args: Record<string, unknown>, ctx: IdeToolContext): Promise<string> {
  const spec = optString(args, "path");
  const staged = optBool(args, "staged", false);
  const statOnly = optBool(args, "stat", false);

  const api = await gitApi(ctx.output);
  if (api === undefined) {
    return "Git integration is unavailable: the built-in `vscode.git` extension is missing or disabled, or its API changed shape.";
  }

  const repositories: GitRepository[] = [];
  for (const candidate of api.repositories) {
    if (isGitRepository(candidate)) repositories.push(candidate);
  }
  if (repositories.length === 0) {
    return "Git integration is available but no repository is open in this window.";
  }

  const picked = pickRepository(repositories, ctx.cwd);
  const notes: string[] = [];
  if (!picked.contains) {
    const because =
      ctx.cwd.trim().length === 0 ? "No working directory was supplied" : `No open repository contains ${ctx.cwd}`;
    notes.push(`${because}; reporting on ${relPath(picked.repository.rootUri.fsPath)}.`);
  }

  const scope = staged ? "staged vs HEAD" : "working tree vs HEAD";
  const state = picked.repository.state;
  let changes = readChanges(staged ? state.indexChanges : state.workingTreeChanges);

  let target: vscode.Uri | undefined;
  if (spec !== undefined) {
    target = resolveUri(spec, ctx.cwd);
    const wanted = path.resolve(target.fsPath);
    changes = changes.filter((change) => path.relative(wanted, path.resolve(change.filePath)) === "");
  }

  if (changes.length === 0) {
    const suffix = target === undefined ? ` (${scope})` : ` for ${relPath(target)} (${scope})`;
    return `No changes relative to HEAD${suffix}.`;
  }

  const header = `${plural(changes.length, "file")} changed, ${scope}, in ${relPath(picked.repository.rootUri.fsPath)}`;
  const prefix = [...notes, header, ""].join("\n");

  if (statOnly) {
    const lines = changes.map((change) => `${statusLetter(change.status)}  ${describePath(change)}`).sort();
    return `${prefix}\n${truncate(lines, { limit: MAX_RESULT_CHARS - prefix.length - 1 })}`;
  }
  return renderPatches(picked.repository, changes, staged, prefix, ctx);
}

/**
 * One patch per changed file, then fill the budget with whole patches: a diff
 * cut mid-hunk is worse than a diff that names the files it dropped. A single
 * patch larger than the entire budget is the one case we clip.
 */
async function renderPatches(
  repository: GitRepository,
  changes: readonly GitChange[],
  staged: boolean,
  prefix: string,
  ctx: IdeToolContext,
): Promise<string> {
  const budget = MAX_RESULT_CHARS - prefix.length;
  const emitted: string[] = [];
  let used = 0;
  let omitted = 0;

  for (const [index, change] of changes.entries()) {
    let raw: unknown;
    try {
      raw = staged
        ? await repository.diffIndexWithHEAD(change.filePath)
        : await repository.diffWithHEAD(change.filePath);
    } catch (error) {
      ctx.output.debug(`scm_diff: ${change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      raw = undefined;
    }

    const patch = typeof raw === "string" ? raw.trimEnd() : "";
    const chunk =
      patch.length > 0
        ? patch
        : `# ${statusLetter(change.status)}  ${describePath(change)}: no textual diff (untracked, binary, or empty).`;

    if (emitted.length > 0 && used + chunk.length + 1 > budget) {
      omitted = changes.length - index;
      break;
    }
    const text = chunk.length + 1 > budget ? clip(chunk, budget) : chunk;
    emitted.push(text);
    used += text.length + 1;
  }

  const tail =
    omitted > 0 ? `\n… ${omitted} more changed file${omitted === 1 ? "" : "s"} omitted (truncated)` : "";
  return `${prefix}\n${emitted.join("\n")}${tail}`;
}

async function gitApi(output: vscode.LogOutputChannel): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<unknown>("vscode.git");
  if (extension === undefined) return undefined;

  let exported: unknown;
  try {
    exported = extension.isActive ? extension.exports : await extension.activate();
  } catch (error) {
    output.debug(`scm_diff: activating vscode.git failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  if (!isRecord(exported) || typeof exported.getAPI !== "function") return undefined;
  // Narrowed to `function` above; the call itself is still guarded and its
  // result re-validated, so nothing downstream trusts this signature.
  const getAPI = exported.getAPI as (version: number) => unknown;
  try {
    const api = getAPI.call(exported, 1);
    return isRecord(api) && Array.isArray(api.repositories) ? { repositories: api.repositories } : undefined;
  } catch (error) {
    output.debug(`scm_diff: git getAPI(1) failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function isGitRepository(value: unknown): value is GitRepository {
  if (!isRecord(value)) return false;
  const root = value.rootUri;
  if (!isRecord(root) || typeof root.fsPath !== "string") return false;
  if (!isRecord(value.state)) return false;
  return typeof value.diffWithHEAD === "function" && typeof value.diffIndexWithHEAD === "function";
}

/** Longest repository root containing `cwd` wins; otherwise the first one. */
function pickRepository(
  repositories: readonly GitRepository[],
  cwd: string,
): { repository: GitRepository; contains: boolean } {
  const first = repositories[0];
  if (first === undefined) throw new Error("scm_diff: no repository to report on.");
  if (cwd.trim().length === 0) return { repository: first, contains: false };

  let best: GitRepository | undefined;
  for (const repository of repositories) {
    const root = repository.rootUri.fsPath;
    // `path.relative` compares case-insensitively on win32, which is correct here.
    const relative = path.relative(root, cwd);
    const inside = relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (!inside) continue;
    if (best === undefined || root.length > best.rootUri.fsPath.length) best = repository;
  }
  return best === undefined ? { repository: first, contains: false } : { repository: best, contains: true };
}

function readChanges(source: unknown): GitChange[] {
  const items: readonly unknown[] = Array.isArray(source) ? source : [];
  const changes: GitChange[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const uri = item.uri;
    if (!isRecord(uri) || typeof uri.fsPath !== "string") continue;
    const original = item.originalUri;
    changes.push({
      filePath: uri.fsPath,
      originalPath: isRecord(original) && typeof original.fsPath === "string" ? original.fsPath : undefined,
      status: typeof item.status === "number" ? item.status : -1,
    });
  }
  return changes;
}

function statusLetter(status: number): string {
  return STATUS_LETTERS[status] ?? "?";
}

/** `old -> new` for a rename or copy, so the pairing is not lost. */
function describePath(change: GitChange): string {
  const to = relPath(change.filePath);
  if (RENAMED_STATUSES[change.status] !== true || change.originalPath === undefined) return to;
  const from = relPath(change.originalPath);
  return from === to ? to : `${from} -> ${to}`;
}
