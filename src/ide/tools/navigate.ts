import * as vscode from "vscode";
import {
  MAX_RESULT_CHARS,
  formatLocation,
  lineText,
  oneLine,
  openDocument,
  optInt,
  optString,
  plural,
  relPath,
  reqInt,
  reqString,
  resolveUri,
  truncate,
} from "./format";
import type { IdeTool, IdeToolContext } from "./types";

/**
 * `definition` and `references` — LSP navigation through VS Code's own, already
 * warm language servers. We go through the built-in executable commands rather
 * than talking to a server ourselves, so whatever the user has installed for a
 * language is what answers.
 */

const DEFAULT_REFERENCE_LIMIT = 100;

interface Reference {
  uri: vscode.Uri;
  range: vscode.Range;
}

const positionProperties = {
  path: {
    type: "string",
    description: "File containing the symbol (workspace-relative or absolute).",
  },
  line: {
    type: "number",
    description: "1-based line number of the symbol.",
  },
  symbol: {
    type: "string",
    description:
      "Symbol text to locate on that line; its first occurrence fixes the column. Preferred over `character`.",
  },
  character: {
    type: "number",
    description: "1-based column, used only when `symbol` is omitted. Defaults to 1.",
  },
} satisfies Record<string, Record<string, unknown>>;

export const navigateTools: IdeTool[] = [
  {
    name: "definition",
    description:
      "Jump to a symbol's definition using the language server already running in VS Code — resolves through imports, type aliases, and re-exports, which text search cannot.",
    inputSchema: {
      type: "object",
      properties: { ...positionProperties },
      required: ["path", "line"],
      additionalProperties: false,
    },
    invoke: runDefinition,
  },
  {
    name: "references",
    description:
      "Find every reference to a symbol using the language server already running in VS Code — real call sites grouped by file, without the false positives of a text search.",
    inputSchema: {
      type: "object",
      properties: {
        ...positionProperties,
        limit: {
          type: "number",
          description: "Maximum number of references to return. Defaults to 100.",
        },
      },
      required: ["path", "line"],
      additionalProperties: false,
    },
    invoke: runReferences,
  },
];

async function runDefinition(args: Record<string, unknown>, ctx: IdeToolContext): Promise<string> {
  const target = await resolveTarget(args, ctx);
  const raw = await vscode.commands.executeCommand<unknown>(
    "vscode.executeDefinitionProvider",
    target.document.uri,
    target.position,
  );
  const found = normalize(raw);
  if (found.length === 0) return "No definition found.";

  const context = documentCache(ctx);
  const lines: string[] = [];
  for (const reference of found) lines.push(await describeReference(reference, context));
  return truncate(lines);
}

async function runReferences(args: Record<string, unknown>, ctx: IdeToolContext): Promise<string> {
  const limit = optInt(args, "limit", DEFAULT_REFERENCE_LIMIT, 1, 2_000);
  const target = await resolveTarget(args, ctx);
  const raw = await vscode.commands.executeCommand<unknown>(
    "vscode.executeReferenceProvider",
    target.document.uri,
    target.position,
  );
  const found = normalize(raw);
  if (found.length === 0) return "No references found.";

  const shown = found.slice(0, limit);
  const counts = new Map<string, number>();
  for (const reference of shown) {
    const key = reference.uri.toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // `normalize` already sorted by path, so the total file count is the number of
  // distinct keys across everything found, not just what fits under `limit`.
  const totalFiles = new Set(found.map((reference) => reference.uri.toString())).size;
  const header = `${plural(found.length, "reference")} in ${plural(totalFiles, "file")}`;

  const context = documentCache(ctx);
  const lines: string[] = [];
  let currentFile = "";
  for (const reference of shown) {
    const key = reference.uri.toString();
    if (key !== currentFile) {
      if (lines.length > 0) lines.push("");
      lines.push(`${relPath(reference.uri)} (${counts.get(key) ?? 0})`);
      currentFile = key;
    }
    lines.push(await describeReference(reference, context));
  }

  const body = truncate(lines, {
    omitted: found.length - shown.length,
    limit: MAX_RESULT_CHARS - header.length - 2,
  });
  return `${header}\n\n${body}`;
}

interface Target {
  document: vscode.TextDocument;
  position: vscode.Position;
}

/**
 * Turn `{ path, line, symbol?, character? }` into a document position. The
 * document is opened but never shown: these tools must not move the user's
 * cursor or steal focus.
 */
async function resolveTarget(args: Record<string, unknown>, ctx: IdeToolContext): Promise<Target> {
  const spec = reqString(args, "path");
  const uri = resolveUri(spec, ctx.cwd);
  const document = await openDocument(uri, spec);

  const line = reqInt(args, "line", 1);
  if (line > document.lineCount) {
    throw new Error(`\`line\` ${line} is past the end of ${relPath(uri)}, which has ${document.lineCount} lines.`);
  }
  const text = document.lineAt(line - 1).text;

  const symbol = optString(args, "symbol");
  if (symbol !== undefined) {
    const index = text.indexOf(symbol);
    if (index < 0) {
      const actual = oneLine(text, 200);
      throw new Error(
        `\`symbol\` "${symbol}" does not occur on ${relPath(uri)}:${line}. That line ${actual.length > 0 ? `reads: ${actual}` : "is blank"}.`,
      );
    }
    return { document, position: new vscode.Position(line - 1, index) };
  }

  const character = optInt(args, "character", 1, 1);
  if (character - 1 > text.length) {
    throw new Error(
      `\`character\` ${character} is past the end of ${relPath(uri)}:${line}, which has ${text.length} characters.`,
    );
  }
  return { document, position: new vscode.Position(line - 1, character - 1) };
}

/**
 * Definition and reference providers may answer with `Location[]` or with
 * `LocationLink[]`; for a link the selection range is the tighter, more useful
 * target. Anything unrecognised is dropped rather than guessed at.
 */
function normalize(result: unknown): Reference[] {
  if (!Array.isArray(result)) return [];
  const items: readonly unknown[] = result;
  const references: Reference[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const candidate = item as Partial<vscode.Location> & Partial<vscode.LocationLink>;
    const uri = candidate.targetUri ?? candidate.uri;
    const range = candidate.targetSelectionRange ?? candidate.targetRange ?? candidate.range;
    if (uri === undefined || range === undefined) continue;
    references.push({ uri, range });
  }

  const seen = new Set<string>();
  const unique = references.filter((reference) => {
    const key = `${reference.uri.toString()}#${reference.range.start.line}:${reference.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.sort((left, right) => {
    const byPath = relPath(left.uri).localeCompare(relPath(right.uri));
    if (byPath !== 0) return byPath;
    const byLine = left.range.start.line - right.range.start.line;
    return byLine !== 0 ? byLine : left.range.start.character - right.range.start.character;
  });
}

/** `<rel>:<line>:<col>  <source line>` — the location plus its context. */
async function describeReference(
  reference: Reference,
  context: (uri: vscode.Uri) => Promise<vscode.TextDocument | undefined>,
): Promise<string> {
  const location = formatLocation(reference);
  const document = await context(reference.uri);
  const text = document === undefined ? "" : lineText(document, reference.range.start.line);
  return text.length > 0 ? `${location}  ${text}` : location;
}

/**
 * Per-invocation document cache: rendering context text means loading every
 * target file, and a reference list hits the same files repeatedly. Unreadable
 * targets (deleted, binary, outside the workspace) degrade to no context.
 */
function documentCache(ctx: IdeToolContext): (uri: vscode.Uri) => Promise<vscode.TextDocument | undefined> {
  const cache = new Map<string, vscode.TextDocument | undefined>();
  return async (uri: vscode.Uri) => {
    const key = uri.toString();
    const hit = cache.get(key);
    if (hit !== undefined || cache.has(key)) return hit;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      cache.set(key, document);
      return document;
    } catch (error) {
      ctx.output.debug(`navigate: cannot read ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
      cache.set(key, undefined);
      return undefined;
    }
  };
}
