import * as path from "node:path";
import * as vscode from "vscode";
import {
  MAX_RESULT_CHARS,
  oneLine,
  optChoice,
  optInt,
  optString,
  relPath,
  resolveUri,
  truncate,
} from "./format";
import type { IdeTool, IdeToolContext } from "./types";

/**
 * `diagnostics` — the live Problems list.
 *
 * This closes the edit→error loop with zero build cost: VS Code's language
 * servers and linters have already computed what is wrong, so the agent can
 * read it instead of running a compiler.
 */

/** Indexed by `vscode.DiagnosticSeverity` (Error 0 … Hint 3). */
const SEVERITY_NAMES = ["error", "warning", "info", "hint"] as const;

type SeverityName = (typeof SEVERITY_NAMES)[number];

const DEFAULT_SEVERITY: SeverityName = "warning";
const DEFAULT_LIMIT = 200;

/** See `diagnosticsForFile` — the settle window is best-effort, not a promise. */
const SETTLE_POLL_MS = 150;
const SETTLE_TIMEOUT_MS = 2_000;

interface Entry {
  uri: vscode.Uri;
  diagnostic: vscode.Diagnostic;
}

export const diagnosticsTools: IdeTool[] = [
  {
    name: "diagnostics",
    description:
      "Live errors and warnings from VS Code's language servers and linters — the Problems panel, with no build step. Scope it to a file or folder, or omit `path` for the whole workspace. Use this to check work after an edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File or folder to report on (workspace-relative or absolute). Omit for every file the IDE knows about.",
        },
        severity: {
          type: "string",
          enum: [...SEVERITY_NAMES],
          description: 'Minimum severity to include. Defaults to "warning".',
        },
        limit: {
          type: "number",
          description: "Maximum number of diagnostics to return. Defaults to 200.",
        },
      },
      additionalProperties: false,
    },
    invoke: runDiagnostics,
  },
];

async function runDiagnostics(args: Record<string, unknown>, ctx: IdeToolContext): Promise<string> {
  const requestedPath = optString(args, "path");
  const requestedSeverity = optString(args, "severity");
  const minSeverity = SEVERITY_NAMES.indexOf(optChoice(args, "severity", SEVERITY_NAMES, DEFAULT_SEVERITY));
  const limit = optInt(args, "limit", DEFAULT_LIMIT, 1, 5_000);

  let entries: Entry[];
  let justOpened = false;

  if (requestedPath === undefined) {
    entries = collectAll();
  } else {
    const uri = resolveUri(requestedPath, ctx.cwd);
    const kind = await statKind(uri);
    if (kind === "missing") {
      throw new Error(`No such file or folder: \`${requestedPath}\` (${uri.fsPath}).`);
    }
    if (kind === "directory") {
      // Folders cannot be opened, so this reports only what language servers
      // have already seen — files nobody has touched contribute nothing.
      entries = collectAll().filter((entry) => isUnder(uri.fsPath, entry.uri.fsPath));
    } else {
      const settled = await diagnosticsForFile(uri, ctx.output);
      entries = settled.diagnostics.map((diagnostic) => ({ uri, diagnostic }));
      justOpened = settled.justOpened;
    }
  }

  const matches = entries
    .filter((entry) => severityIndex(entry.diagnostic.severity) <= minSeverity)
    .sort(compareEntries);

  if (matches.length === 0) {
    const applied: string[] = [];
    if (requestedPath !== undefined) applied.push(relPath(resolveUri(requestedPath, ctx.cwd)));
    if (requestedSeverity !== undefined) applied.push(`severity >= ${SEVERITY_NAMES[minSeverity]}`);
    const scope = applied.length > 0 ? `No diagnostics for ${applied.join(", ")}.` : "No diagnostics.";
    return justOpened
      ? `${scope} The document was opened only just now, so its language server may not have reported yet.`
      : scope;
  }

  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const entry of matches) {
    const index = severityIndex(entry.diagnostic.severity);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const header = `${counts[0]} errors, ${counts[1]} warnings, ${counts[2]} info, ${counts[3]} hints`;

  const shown = matches.slice(0, limit);
  const lines = shown.map((entry) => formatEntry(entry));
  const body = truncate(lines, {
    omitted: matches.length - shown.length,
    limit: MAX_RESULT_CHARS - header.length - 2,
  });
  return `${header}\n\n${body}`;
}

function collectAll(): Entry[] {
  const entries: Entry[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    for (const diagnostic of diagnostics) entries.push({ uri, diagnostic });
  }
  return entries;
}

/**
 * Diagnostics for a file only exist once a language server has seen the
 * document, so open it (never showing it) and give the server a moment.
 *
 * This is best-effort and *not* deterministic: VS Code exposes no "diagnostics
 * for this document are final" signal. We poll every `SETTLE_POLL_MS` for up to
 * `SETTLE_TIMEOUT_MS` and return as soon as anything appears — so a genuinely
 * clean file always costs the full timeout, and a slow server may still report
 * nothing at all. `justOpened` lets the caller say so out loud.
 */
async function diagnosticsForFile(
  uri: vscode.Uri,
  output: vscode.LogOutputChannel,
): Promise<{ diagnostics: readonly vscode.Diagnostic[]; justOpened: boolean }> {
  const known = vscode.languages.getDiagnostics(uri);
  const alreadyOpen = vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === uri.toString());
  if (alreadyOpen || known.length > 0) return { diagnostics: known, justOpened: false };

  try {
    await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    output.debug(`diagnostics: cannot open ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { diagnostics: known, justOpened: false };
  }

  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const found = vscode.languages.getDiagnostics(uri);
    if (found.length > 0 || Date.now() >= deadline) return { diagnostics: found, justOpened: true };
    const settle = Promise.withResolvers<void>();
    setTimeout(settle.resolve, SETTLE_POLL_MS);
    await settle.promise;
  }
}

async function statKind(uri: vscode.Uri): Promise<"file" | "directory" | "missing"> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) === 0 ? "file" : "directory";
  } catch {
    return "missing";
  }
}

/** `path.relative` is case-insensitive on win32, which is what we want here. */
function isUnder(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function severityIndex(severity: vscode.DiagnosticSeverity): number {
  return severity >= 0 && severity <= 3 ? severity : SEVERITY_NAMES.length - 1;
}

function compareEntries(left: Entry, right: Entry): number {
  const bySeverity = severityIndex(left.diagnostic.severity) - severityIndex(right.diagnostic.severity);
  if (bySeverity !== 0) return bySeverity;
  const byPath = relPath(left.uri).localeCompare(relPath(right.uri));
  if (byPath !== 0) return byPath;
  const byLine = left.diagnostic.range.start.line - right.diagnostic.range.start.line;
  return byLine !== 0 ? byLine : left.diagnostic.range.start.character - right.diagnostic.range.start.character;
}

function formatEntry(entry: Entry): string {
  const start = entry.diagnostic.range.start;
  const label = (SEVERITY_NAMES[severityIndex(entry.diagnostic.severity)] ?? "hint").toUpperCase();
  const location = `${relPath(entry.uri)}:${start.line + 1}:${start.character + 1}`;
  return `${location}  ${label}  ${oneLine(entry.diagnostic.message)}${tagSuffix(entry.diagnostic)}${relatedSuffix(entry)}`;
}

/** `[<source> <code>]`, omitted entirely when the diagnostic carries neither. */
function tagSuffix(diagnostic: vscode.Diagnostic): string {
  const raw = diagnostic.code;
  let code = "";
  if (typeof raw === "string" || typeof raw === "number") {
    code = String(raw);
  } else if (raw !== undefined && typeof raw === "object" && "value" in raw) {
    code = String(raw.value);
  }
  const parts = [diagnostic.source?.trim() ?? "", code].filter((part) => part.length > 0);
  return parts.length > 0 ? `  [${parts.join(" ")}]` : "";
}

/**
 * A single related location in *another* file is the useful case (the "first
 * declared here" pointer); longer chains are noise at this density.
 */
function relatedSuffix(entry: Entry): string {
  const related = entry.diagnostic.relatedInformation;
  if (related === undefined || related.length !== 1) return "";
  const only = related[0];
  if (only === undefined || only.location.uri.toString() === entry.uri.toString()) return "";
  return `  -> ${relPath(only.location.uri)}:${only.location.range.start.line + 1}`;
}
