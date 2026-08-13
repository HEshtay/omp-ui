import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Shared output formatting, path resolution, and argument coercion for the IDE
 * tools.
 *
 * Every tool result is text handed straight to a language model, so the helpers
 * here enforce one house style: grep-shaped `path:line:col` lines, paths made
 * workspace-relative, 1-based line/column numbers (VS Code's API is 0-based),
 * and a hard character cap with an explicit truncation marker.
 */

/** Hard cap on the text any single tool may return. */
export const MAX_RESULT_CHARS = 24_000;

export interface TruncateOptions {
  /** Character budget for the joined result. Defaults to `MAX_RESULT_CHARS`. */
  limit?: number;
  /** Entries the caller already dropped, e.g. via a `limit` argument. */
  omitted?: number;
}

/**
 * Join `lines` head-first while staying inside the character budget, appending
 * an explicit `… N more (truncated)` marker when anything was left out.
 */
export function truncate(lines: readonly string[], options: TruncateOptions = {}): string {
  const limit = options.limit ?? MAX_RESULT_CHARS;
  const kept: string[] = [];
  let dropped = options.omitted ?? 0;
  let used = 0;

  for (const [index, line] of lines.entries()) {
    if (kept.length > 0 && used + line.length + 1 > limit) {
      dropped += lines.length - index;
      break;
    }
    // A single oversized first line still has to say something: clip it.
    const text = line.length + 1 > limit ? clip(line, limit) : line;
    kept.push(text);
    used += text.length + 1;
  }

  const marker = dropped > 0 ? `… ${dropped} more (truncated)` : "";
  if (kept.length === 0) return marker;
  return marker.length > 0 ? `${kept.join("\n")}\n${marker}` : kept.join("\n");
}

/** Cap one opaque blob of text (a patch body, a log tail), breaking on a line. */
export function clip(text: string, limit = MAX_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  const marker = "\n… (clipped)";
  const cut = Math.max(0, limit - marker.length);
  const head = text.slice(0, cut);
  const lastBreak = head.lastIndexOf("\n");
  return `${lastBreak > cut / 2 ? head.slice(0, lastBreak) : head}${marker}`;
}

/** Collapse whitespace to a single line and cap it. */
export function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `N thing` / `N things`. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Workspace-relative display path (absolute when the target is outside). */
export function relPath(target: vscode.Uri | string): string {
  return vscode.workspace.asRelativePath(target);
}

/** `<line>:<col>`, converting VS Code's 0-based position to 1-based. */
export function formatPosition(position: vscode.Position): string {
  return `${position.line + 1}:${position.character + 1}`;
}

/** `<rel>:<line>:<col>` for the start of `range`. */
export function formatRange(uri: vscode.Uri, range: vscode.Range): string {
  return `${relPath(uri)}:${formatPosition(range.start)}`;
}

/** `<rel>:<line>:<col>` for anything shaped like a `vscode.Location`. */
export function formatLocation(location: { uri: vscode.Uri; range: vscode.Range }): string {
  return formatRange(location.uri, location.range);
}

/** Trimmed, capped source text of a 0-based document line, as hit context. */
export function lineText(document: vscode.TextDocument, line: number): string {
  if (line < 0 || line >= document.lineCount) return "";
  return oneLine(document.lineAt(line).text, 200);
}

/**
 * Resolve a tool `path` argument to a URI: absolute paths are used verbatim,
 * relative ones resolve against the calling session's cwd (falling back to the
 * first workspace folder).
 */
export function resolveUri(input: string, cwd: string): vscode.Uri {
  const raw = input.trim();
  if (raw.length === 0) throw new Error("`path` must not be empty.");
  if (path.isAbsolute(raw)) return vscode.Uri.file(path.normalize(raw));
  const base = cwd.trim().length > 0 ? cwd.trim() : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (base === undefined) {
    throw new Error(
      `Cannot resolve the relative path \`${raw}\`: no working directory or workspace folder is available. Pass an absolute path.`,
    );
  }
  return vscode.Uri.file(path.resolve(base, raw));
}

/**
 * Load a document for inspection. Never shows it — these tools must not steal
 * focus or change the user's editor state.
 */
export async function openDocument(uri: vscode.Uri, spec: string): Promise<vscode.TextDocument> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot open \`${spec}\` (${uri.fsPath}): ${reason}`);
  }
}

/** A present, non-blank string argument, or `undefined`. */
export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`\`${key}\` must be a string, got ${describe(value)}.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function reqString(args: Record<string, unknown>, key: string): string {
  const value = optString(args, key);
  if (value === undefined) throw new Error(`\`${key}\` is required and must be a non-empty string.`);
  return value;
}

export function optInt(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  return coerceInt(value, key, min, max);
}

export function reqInt(
  args: Record<string, unknown>,
  key: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = args[key];
  if (value === undefined || value === null) throw new Error(`\`${key}\` is required and must be a number.`);
  return coerceInt(value, key, min, max);
}

export function optBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`\`${key}\` must be a boolean, got ${describe(value)}.`);
}

export function optChoice<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = optString(args, key);
  if (value === undefined) return fallback;
  const lowered = value.toLowerCase();
  const match = allowed.find((candidate) => candidate === lowered);
  if (match === undefined) {
    throw new Error(`\`${key}\` must be one of ${allowed.join(", ")}, got "${value}".`);
  }
  return match;
}

function coerceInt(value: unknown, key: string, min: number, max: number): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`\`${key}\` must be an integer between ${min} and ${max}, got ${describe(value)}.`);
  }
  return numeric;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return value === null ? "null" : Array.isArray(value) ? "an array" : "an object";
  return String(value);
}
