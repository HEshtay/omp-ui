import * as vscode from "vscode";
import { MAX_RESULT_CHARS, openDocument, optString, plural, relPath, resolveUri, truncate } from "./format";
import type { IdeTool, IdeToolContext } from "./types";

/**
 * `symbols` — the structure the language server already knows: a workspace-wide
 * fuzzy symbol search, or one file's symbol tree. Cheaper and far more accurate
 * than grepping for `class Foo`.
 */

const MAX_SYMBOLS = 300;

/** Indexed by `vscode.SymbolKind`; readable names, never raw enum numbers. */
const SYMBOL_KINDS = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum-member",
  "struct",
  "event",
  "operator",
  "type-parameter",
] as const;

interface SymbolEntry {
  /** Nesting level in a document symbol tree; always 0 for a flat list. */
  depth: number;
  kind: vscode.SymbolKind;
  name: string;
  /** ` (in Container)` or empty. */
  container: string;
  uri: vscode.Uri;
  /** 0-based, as VS Code reports it. */
  line: number;
}

export const symbolTools: IdeTool[] = [
  {
    name: "symbols",
    description:
      "Symbol index from VS Code's language servers. Pass `query` for a fuzzy workspace-wide symbol search, or `path` for one file's symbol tree (classes, methods, fields) with line numbers. Exactly one of the two.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Fuzzy symbol name to search for across the workspace.",
        },
        path: {
          type: "string",
          description: "File whose symbol tree to list (workspace-relative or absolute).",
        },
      },
      additionalProperties: false,
    },
    invoke: runSymbols,
  },
];

async function runSymbols(args: Record<string, unknown>, ctx: IdeToolContext): Promise<string> {
  const query = optString(args, "query");
  const spec = optString(args, "path");
  if (query !== undefined && spec !== undefined) {
    throw new Error("Pass either `query` (workspace symbol search) or `path` (one file's symbol tree), not both.");
  }

  if (query !== undefined) {
    const entries = await workspaceSymbols(query);
    if (entries.length === 0) return `No symbols matching "${query}".`;
    return render(`${plural(entries.length, "symbol")} matching "${query}"`, entries);
  }

  if (spec !== undefined) {
    const uri = resolveUri(spec, ctx.cwd);
    const entries = await documentSymbols(uri, spec);
    if (entries.length === 0) {
      return `No symbols in ${relPath(uri)}. No language server provided a symbol tree for this file.`;
    }
    return render(`${plural(entries.length, "symbol")} in ${relPath(uri)}`, entries);
  }

  throw new Error("Pass exactly one of `query` (workspace symbol search) or `path` (one file's symbol tree).");
}

function render(header: string, entries: readonly SymbolEntry[]): string {
  const shown = entries.slice(0, MAX_SYMBOLS);
  const lines = shown.map((entry) => {
    const kind = SYMBOL_KINDS[entry.kind] ?? `kind-${entry.kind}`;
    return `${"  ".repeat(entry.depth)}${kind} ${entry.name}${entry.container}  ${relPath(entry.uri)}:${entry.line + 1}`;
  });
  const body = truncate(lines, {
    omitted: entries.length - shown.length,
    limit: MAX_RESULT_CHARS - header.length - 2,
  });
  return `${header}\n\n${body}`;
}

async function workspaceSymbols(query: string): Promise<SymbolEntry[]> {
  const raw = await vscode.commands.executeCommand<unknown>("vscode.executeWorkspaceSymbolProvider", query);
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [];

  const entries: SymbolEntry[] = [];
  for (const item of items) {
    const entry = fromSymbolInformation(item);
    if (entry !== undefined) entries.push(entry);
  }
  return entries.sort((left, right) => {
    const byPath = relPath(left.uri).localeCompare(relPath(right.uri));
    return byPath !== 0 ? byPath : left.line - right.line;
  });
}

async function documentSymbols(uri: vscode.Uri, spec: string): Promise<SymbolEntry[]> {
  // Opened (never shown) so the language server has certainly parsed the file.
  await openDocument(uri, spec);
  const raw = await vscode.commands.executeCommand<unknown>("vscode.executeDocumentSymbolProvider", uri);
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [];

  const roots: vscode.DocumentSymbol[] = [];
  const flat: SymbolEntry[] = [];
  for (const item of items) {
    const nested = asDocumentSymbol(item);
    if (nested !== undefined) {
      roots.push(nested);
      continue;
    }
    // Some providers still answer with the flat `SymbolInformation[]` shape.
    const entry = fromSymbolInformation(item);
    if (entry !== undefined) flat.push(entry);
  }

  const tree: SymbolEntry[] = [];
  // One call, so the whole top level is ordered together, not per item.
  if (roots.length > 0) collectTree(uri, roots, 0, tree);
  if (tree.length > 0) return tree;
  return flat.sort((left, right) => left.line - right.line);
}

/** Depth-first, each level ordered by position, so the tree reads like the file. */
function collectTree(
  uri: vscode.Uri,
  symbols: readonly vscode.DocumentSymbol[],
  depth: number,
  out: SymbolEntry[],
): void {
  const ordered = [...symbols].sort((left, right) => left.range.start.line - right.range.start.line);
  for (const symbol of ordered) {
    // The name range is the better anchor; fall back for providers that omit it.
    const selection: vscode.Range | undefined = symbol.selectionRange;
    out.push({
      depth,
      kind: symbol.kind,
      name: symbol.name,
      container: "",
      uri,
      line: (selection ?? symbol.range).start.line,
    });
    const children: readonly vscode.DocumentSymbol[] | undefined = symbol.children;
    if (children !== undefined && children.length > 0) collectTree(uri, children, depth + 1, out);
  }
}

function fromSymbolInformation(value: unknown): SymbolEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<vscode.SymbolInformation>;
  const location = candidate.location;
  if (typeof candidate.name !== "string" || typeof candidate.kind !== "number") return undefined;
  if (location === undefined || location.uri === undefined || location.range === undefined) return undefined;
  const container = typeof candidate.containerName === "string" ? candidate.containerName.trim() : "";
  return {
    depth: 0,
    kind: candidate.kind,
    name: candidate.name,
    container: container.length > 0 ? ` (in ${container})` : "",
    uri: location.uri,
    line: location.range.start.line,
  };
}

function asDocumentSymbol(value: unknown): vscode.DocumentSymbol | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<vscode.DocumentSymbol> & { location?: unknown };
  if (typeof candidate.name !== "string" || typeof candidate.kind !== "number") return undefined;
  // A `DocumentSymbol` carries its own range; a `SymbolInformation` has a `location`.
  if (candidate.range === undefined || candidate.location !== undefined) return undefined;
  return candidate as vscode.DocumentSymbol;
}
