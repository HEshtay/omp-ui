import * as path from "node:path";
import * as vscode from "vscode";
import {
  MAX_RESULT_CHARS,
  formatPosition,
  openDocument,
  optBool,
  optInt,
  plural,
  relPath,
  reqString,
  resolveUri,
  truncate,
} from "./format";
import type { IdeTool, IdeToolContext } from "./types";
import { isRecord } from "../../shared/guards";

/**
 * `editor_state` and `read_buffer` — where the user is, and what their buffers
 * actually contain.
 *
 * The agent's own `read` tool runs in a separate process and reads bytes from
 * disk, so it silently returns the last-*saved* version of any file the user is
 * still editing. Nothing in that process can see the cursor, the selection, the
 * open tabs, or which buffers are dirty either. These two tools are the only
 * honest answer: `editor_state` names the unsaved files (and says outright that
 * `read` is looking at something else), and `read_buffer` hands back the
 * in-memory text VS Code is showing.
 *
 * `window.tabGroups` is the only tab-level API and a restricted host may not
 * provide it; the fallback is `workspace.textDocuments`, which knows every open
 * document but nothing about tab order or visibility, and says so.
 */

/** Rendered when at least one open buffer differs from disk. */
const STALE_READ_WARNING =
  "Your `read` tool reads from disk and will return the last saved version of the unsaved files above. Use `read_buffer` for the text the user is actually looking at.";

/** The count is always exact; naming every path stops being useful long before this. */
const MAX_LISTED_UNSAVED = 50;

interface OpenFile {
  readonly uri: vscode.Uri;
  readonly dirty: boolean;
}

interface OpenFiles {
  readonly files: readonly OpenFile[];
  /** `tabs` preserves the user's tab order; `documents` is the degraded fallback. */
  readonly source: "tabs" | "documents";
}

export const editorTools: IdeTool[] = [
  {
    name: "editor_state",
    description:
      "What the user is looking at right now: the active file with the cursor position, the selection, the visible line range, the open tabs, and — critically — which files have unsaved changes, because your `read` tool sees the on-disk version of those. Check this before assuming a file's contents or when the user says \"this file\", \"here\", or \"the selection\".",
    inputSchema: {
      type: "object",
      properties: {
        include_open_editors: {
          type: "boolean",
          description: "true (default) = list every open editor; false = report only the active one.",
        },
      },
      additionalProperties: false,
    },
    invoke: runEditorState,
  },
  {
    name: "read_buffer",
    description:
      "Read a file as VS Code has it in memory, including the user's unsaved edits — the version your own `read` tool cannot see. The header states whether the buffer actually differs from disk, so you can tell whether this call bought you anything.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File to read (workspace-relative or absolute).",
        },
        start_line: {
          type: "number",
          description: "First line to return, 1-based inclusive. Defaults to 1.",
        },
        end_line: {
          type: "number",
          description: "Last line to return, 1-based inclusive. Defaults to the last line of the file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    invoke: runReadBuffer,
  },
];

/** Everything here is host state, so this is the one IDE tool that needs no session cwd. */
async function runEditorState(args: Record<string, unknown>): Promise<string> {
  const includeOpen = optBool(args, "include_open_editors", true);
  const editor = vscode.window.activeTextEditor;
  const open = collectOpenFiles();

  if (editor === undefined && open.files.length === 0) {
    return "No editor is open in VS Code, so there is no cursor, selection, or unsaved buffer to report.";
  }

  const head: string[] = [];
  if (editor === undefined) {
    head.push("active: none — files are open but no text editor has focus");
  } else {
    head.push(...describeActive(editor));
  }

  const unsaved = unsavedFiles(open);
  const listed = unsaved.slice(0, MAX_LISTED_UNSAVED);
  const elided = unsaved.length - listed.length;
  const unsavedLine =
    unsaved.length === 0
      ? "unsaved files (0): none — every open buffer matches disk"
      : `unsaved files (${unsaved.length}): ${listed.join(", ")}${elided > 0 ? `, … ${elided} more` : ""}`;

  const tail = unsaved.length === 0 ? [unsavedLine] : [unsavedLine, "", STALE_READ_WARNING];
  if (!includeOpen || open.files.length === 0) return [...head, ...tail].join("\n");

  const openLines = [
    open.source === "tabs"
      ? `open editors (${open.files.length}):`
      : `open editors (${open.files.length}, from open documents — this host does not expose tab order):`,
    ...open.files.map((file) => `  ${relPath(file.uri)}${file.dirty ? " (unsaved)" : ""}`),
  ];
  // The unsaved list and its warning are the point of this tool, so they keep
  // their budget and the tab list absorbs any truncation.
  const reserve = [...head, ...tail].reduce((total, line) => total + line.length + 1, 0) + 2;
  const block = truncate(openLines, { limit: Math.max(0, MAX_RESULT_CHARS - reserve) });

  return [...head, "", block, "", ...tail].join("\n");
}

/** Cursor, selection and viewport — the three things a separate process cannot see. */
function describeActive(editor: vscode.TextEditor): string[] {
  const document = editor.document;
  const location = `${relPath(document.uri)}:${formatPosition(editor.selection.active)}`;
  const lines = [`active: ${location}${document.isDirty ? " (unsaved)" : ""}`];

  const selection = editor.selection;
  if (!selection.isEmpty) {
    const span = `${relPath(document.uri)}:${formatPosition(selection.start)}-${formatPosition(selection.end)}`;
    const length = document.offsetAt(selection.end) - document.offsetAt(selection.start);
    const extra = editor.selections.length > 1 ? `, ${plural(editor.selections.length, "selection")}` : "";
    lines.push(`selection: ${span} (${plural(length, "char")}${extra})`);
  }

  // Folding splits the viewport into several ranges; the outer bounds are what
  // "on screen" means to the user.
  const visible = editor.visibleRanges;
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (first !== undefined && last !== undefined) {
    lines.push(`visible: lines ${first.start.line + 1}-${last.end.line + 1} of ${document.lineCount}`);
  }

  return lines;
}

function collectOpenFiles(): OpenFiles {
  // Widened deliberately: `tabGroups` arrived in 1.68 and a restricted host may
  // omit it, which the non-optional typing does not admit.
  const groups: vscode.TabGroups | undefined = vscode.window.tabGroups;
  const all: readonly vscode.TabGroup[] | undefined = groups?.all;
  if (all !== undefined) {
    const files: OpenFile[] = [];
    const seen = new Set<string>();
    for (const group of all) {
      for (const tab of group.tabs) {
        const uri = tabUri(tab.input);
        if (uri === undefined) continue;
        // The same file split across two groups is one file to the agent.
        const key = uri.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({ uri, dirty: tab.isDirty });
      }
    }
    return { files, source: "tabs" };
  }

  const files = interestingDocuments()
    .map((document) => ({ uri: document.uri, dirty: document.isDirty }))
    .sort((left, right) => relPath(left.uri).localeCompare(relPath(right.uri)));
  return { files, source: "documents" };
}

/**
 * `workspace.textDocuments` also holds the buffers behind diff views, output
 * channels and SCM inputs; only real files and untitled drafts are files the
 * user could be editing.
 */
function interestingDocuments(): vscode.TextDocument[] {
  const documents: readonly vscode.TextDocument[] | undefined = vscode.workspace.textDocuments;
  if (documents === undefined) return [];
  return documents.filter((document) => document.uri.scheme === "file" || document.uri.scheme === "untitled");
}

/**
 * Dirty state comes from the documents rather than the tabs: a tab is the only
 * place tab order lives, but a document is the thing that is or is not saved,
 * and a buffer with no tab (an extension-opened document) still shadows disk.
 */
function unsavedFiles(open: OpenFiles): string[] {
  const paths = new Set<string>();
  for (const document of interestingDocuments()) {
    if (document.isDirty) paths.add(relPath(document.uri));
  }
  for (const file of open.files) {
    if (file.dirty) paths.add(relPath(file.uri));
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

/**
 * Text, notebook and diff tabs carry a URI; webview, terminal and settings tabs
 * do not. `Tab.input` is typed as a union ending in `unknown`, so this is a
 * structural probe rather than an `instanceof` chain.
 */
function tabUri(input: unknown): vscode.Uri | undefined {
  if (!isRecord(input)) return undefined;
  // For a diff tab the right-hand side is the editable document.
  const candidate = input.modified ?? input.uri;
  return isUri(candidate) ? candidate : undefined;
}

function isUri(value: unknown): value is vscode.Uri {
  return isRecord(value) && typeof value.scheme === "string" && typeof value.fsPath === "string";
}

async function runReadBuffer(args: Record<string, unknown>, ctx: IdeToolContext): Promise<string> {
  const spec = reqString(args, "path");
  const uri = resolveUri(spec, ctx.cwd);
  const document = findOpenDocument(uri) ?? (await openDocument(uri, spec));

  const total = document.lineCount;
  const startLine = optInt(args, "start_line", 1);
  const endLine = optInt(args, "end_line", total);
  if (startLine > total) {
    throw new Error(`\`start_line\` ${startLine} is past the end of ${relPath(document.uri)} (${total} lines).`);
  }
  if (endLine > total) {
    throw new Error(`\`end_line\` ${endLine} is past the end of ${relPath(document.uri)} (${total} lines).`);
  }
  if (endLine < startLine) {
    throw new Error(`\`end_line\` ${endLine} is before \`start_line\` ${startLine}.`);
  }

  const state = document.isDirty ? "unsaved" : "saved — identical to disk";
  const header = `${relPath(document.uri)} (${state}, ${plural(total, "line")})`;

  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    lines.push(`${line}: ${document.lineAt(line - 1).text}`);
  }
  const body = truncate(lines, { limit: MAX_RESULT_CHARS - header.length - 2 });
  return `${header}\n\n${body}`;
}

/**
 * An already-open document is the user's live buffer. `openTextDocument` would
 * return the same object, but going through the open set first means a file the
 * IDE has never seen is the only case that touches the filesystem.
 */
function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const documents: readonly vscode.TextDocument[] | undefined = vscode.workspace.textDocuments;
  if (documents === undefined) return undefined;
  return documents.find((document) => sameFile(document.uri, uri));
}

/** `path.relative` is case-insensitive on win32, which is what the filesystem is. */
function sameFile(left: vscode.Uri, right: vscode.Uri): boolean {
  if (left.toString() === right.toString()) return true;
  return left.scheme === right.scheme && path.relative(left.fsPath, right.fsPath) === "";
}
