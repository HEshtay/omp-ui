import * as vscode from "vscode";

/**
 * A passive record of what the *user* ran in the integrated terminal.
 *
 * Their commands and output are invisible to the agent: the agent's own `bash`
 * runs in a different process, and nothing hands it the scrollback of a terminal
 * a human typed into. So we listen — we never write to a terminal here, never
 * execute anything, and never open one.
 *
 * A task the agent started through `run_task` also arrives on these events;
 * there is no API linking a `TaskExecution` to its terminal, so the two cannot
 * be told apart, and seeing a command the agent already knows about is harmless.
 *
 * The whole thing degrades to nothing when the terminal shell-integration API is
 * absent: `recentExecutions()` then stays empty, and `terminal_read` must report
 * that capture is unavailable rather than that the user has run nothing.
 *
 * Memory is bounded in both directions — a fixed number of executions, and a
 * fixed amount of retained output per execution. It drops; it never grows.
 */

/** Executions kept; older ones are dropped from the head. */
const MAX_EXECUTIONS = 20;

/**
 * Retained characters of raw terminal stream per execution. A build log easily
 * runs to megabytes, and this buffer lives for the whole session.
 */
const MAX_OUTPUT_CHARS = 32 * 1024;

/**
 * How far past the cut a newline may be and still be used as the new start. A
 * minified bundle or a progress bar can be one line of megabytes; aligning on it
 * would throw away everything we were told to keep.
 */
const LINE_ALIGN_SLACK = 4 * 1024;

/**
 * ANSI/OSC escape sequences, duplicated from `tools/tasks.ts`, which remains the
 * source of truth for this pattern — the two capture paths are independent and
 * neither should have to import the other's module just for a regex.
 */
const ANSI_ESCAPE_RE = new RegExp(
  [
    // OSC: ESC ] … (BEL | ST)
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
    // CSI and friends: ESC [ … final-byte
    "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]",
    // Leftover ST and other single-character escapes
    "\\u001B[@-Z\\\\-_]",
  ].join("|"),
  "g",
);

export interface TerminalExecution {
  terminal: string;
  command: string;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  output: string;
  truncated: boolean;
}

/** The mutable in-buffer form: `output` is the raw stream, normalized on read. */
interface Recorded {
  terminal: string;
  command: string;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  raw: string;
  truncated: boolean;
}

/** Oldest first. Bounded by `MAX_EXECUTIONS`. */
const buffer: Recorded[] = [];

/**
 * Streaming executions, so the end event can find its record. Keyed by the
 * execution object itself, and pruned whenever its record leaves `buffer`, so
 * this cannot outgrow the ring even if an end event never arrives.
 */
const streaming = new Map<vscode.TerminalShellExecution, Recorded>();

/** A second `startTerminalRecorder` would double-record every command. */
let active = false;

export function startTerminalRecorder(output: vscode.LogOutputChannel): vscode.Disposable {
  if (
    typeof vscode.window.onDidStartTerminalShellExecution !== "function" ||
    typeof vscode.window.onDidEndTerminalShellExecution !== "function"
  ) {
    output.debug("[ide] terminal shell integration unavailable; the user's terminal commands will not be recorded");
    return new vscode.Disposable(() => {});
  }
  if (active) {
    output.warn("[ide] terminal recorder already running; ignoring the second start");
    return new vscode.Disposable(() => {});
  }
  active = true;

  const subscriptions = [
    vscode.window.onDidStartTerminalShellExecution((event) => began(event, output)),
    vscode.window.onDidEndTerminalShellExecution(ended),
  ];
  return new vscode.Disposable(() => {
    for (const subscription of subscriptions) subscription.dispose();
    // Nothing may read this after the extension is torn down, and holding on to
    // a session's worth of terminal output would be the one real leak here.
    buffer.length = 0;
    streaming.clear();
    active = false;
  });
}

/** Recorded executions, oldest first, with escape sequences already stripped. */
export function recentExecutions(): readonly TerminalExecution[] {
  return buffer.map((record) => ({
    terminal: record.terminal,
    command: record.command,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    output: normalizeTerminalText(record.raw),
    truncated: record.truncated,
  }));
}

function began(event: vscode.TerminalShellExecutionStartEvent, output: vscode.LogOutputChannel): void {
  // Shells without command-line reporting still give us the execution and its
  // exit code; say so rather than inventing a command.
  const commandLine = event.execution.commandLine.value.trim();
  const record: Recorded = {
    terminal: event.terminal.name,
    command: commandLine.length > 0 ? commandLine : "(command line not reported by this shell)",
    startedAt: Date.now(),
    raw: "",
    truncated: false,
  };

  buffer.push(record);
  while (buffer.length > MAX_EXECUTIONS) {
    const dropped = buffer.shift();
    for (const [execution, candidate] of streaming) {
      if (candidate === dropped) streaming.delete(execution);
    }
  }

  streaming.set(event.execution, record);
  void (async () => {
    try {
      // `read()` must be called immediately or the head of the stream is lost; an
      // async function body runs synchronously up to its first await, so it is.
      for await (const chunk of event.execution.read()) append(record, chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.debug(`[ide] terminal output stream ended early: ${message}`);
    }
  })();
}

function ended(event: vscode.TerminalShellExecutionEndEvent): void {
  const record = streaming.get(event.execution);
  // An execution already in flight when we subscribed has no record to close.
  if (record === undefined) return;
  record.exitCode = event.exitCode;
  record.endedAt = Date.now();
  streaming.delete(event.execution);
}

/** Keep the tail: what a command was complaining about is at the end. */
function append(record: Recorded, chunk: string): void {
  record.raw += chunk;
  if (record.raw.length <= MAX_OUTPUT_CHARS) return;
  const excess = record.raw.length - MAX_OUTPUT_CHARS;
  const newline = record.raw.indexOf("\n", excess);
  const aligned = newline !== -1 && newline - excess <= LINE_ALIGN_SLACK;
  record.raw = record.raw.slice(aligned ? newline + 1 : excess);
  record.truncated = true;
}

/** Strip escape sequences and collapse carriage-return redraws. */
function normalizeTerminalText(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\r+\n/g, "\n")
    // A lone CR rewrites the current line (progress bars); keep the final state.
    .replace(/[^\n]*\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
