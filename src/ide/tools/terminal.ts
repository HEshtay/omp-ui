import * as vscode from "vscode";
import { MAX_RESULT_CHARS, optBool, optInt, optString, plural } from "./format";
import type { IdeTool } from "./types";
import { type TerminalExecution, recentExecutions } from "../terminal-recorder";

/**
 * `terminal_read` — the commands the *user* ran, which the agent otherwise never
 * sees. Its own `bash` runs in another process; a human's terminal scrollback is
 * a different world, and "what did you just try?" is usually the whole question.
 *
 * The data comes from `terminal-recorder`, a passive listener. Two negative
 * answers must never be confused, and the wording below keeps them apart:
 * *capture is unavailable* (this host has no shell-integration API, so commands
 * may well have run and we would not know) versus *nothing ran* (we were
 * listening and saw nothing). Reporting the first as the second would be a lie
 * the agent then acts on.
 */

const DEFAULT_LIMIT = 5;
/** The recorder's own ring holds 20, so asking for more cannot return more. */
const MAX_LIMIT = 20;

/** Indented like the output it precedes, and charged against the same budget. */
const DROPPED_MARKER = "  … (earlier output dropped)";

const UNAVAILABLE =
  "Terminal capture is unavailable: this VS Code host does not expose the terminal shell-integration API, so nothing the user ran was recorded. This does NOT mean the terminal is idle — commands may well have run and there is no way to see them from here. Ask the user to paste the output, or run the command yourself.";

const NOTHING_RECORDED =
  "No terminal commands recorded. Shell integration is active and we were listening, so nothing has run in an integrated terminal since this session started. Commands run before then, or in a terminal outside VS Code, are never visible here.";

export const terminalTools: IdeTool[] = [
  {
    name: "terminal_read",
    description:
      "Commands the user ran in VS Code's integrated terminal, newest first, with exit codes and captured output. This is their terminal, not yours — use it when they say something failed, mention output you cannot see, or refer to a command they just ran.",
    inputSchema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description: "Only report terminals whose name contains this text (case-insensitive).",
        },
        limit: {
          type: "number",
          description: "Maximum number of executions to return, newest first. Defaults to 5, maximum 20.",
        },
        include_output: {
          type: "boolean",
          description: "true (default) = include each command's captured output; false = command lines and exit codes only.",
        },
      },
      additionalProperties: false,
    },
    invoke: runTerminalRead,
  },
];

async function runTerminalRead(args: Record<string, unknown>): Promise<string> {
  const filter = optString(args, "terminal")?.toLowerCase();
  const limit = optInt(args, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  const includeOutput = optBool(args, "include_output", true);

  // The recorder subscribes under exactly this condition, so probing it here is
  // what tells an empty buffer from a buffer that was never fed.
  if (
    typeof vscode.window.onDidStartTerminalShellExecution !== "function" ||
    typeof vscode.window.onDidEndTerminalShellExecution !== "function"
  ) {
    return UNAVAILABLE;
  }

  const recorded = recentExecutions();
  if (recorded.length === 0) return NOTHING_RECORDED;

  const matches = filter === undefined
    ? recorded
    : recorded.filter((execution) => execution.terminal.toLowerCase().includes(filter));
  if (matches.length === 0) {
    const names = [...new Set(recorded.map((execution) => execution.terminal))].join(", ");
    return `No recorded commands from a terminal matching \`${filter}\`. Terminals with recorded commands: ${names}.`;
  }

  // The recorder hands them over oldest first; the newest command is the one the
  // user is asking about.
  const ordered = [...matches].reverse().slice(0, limit);
  const header =
    ordered.length < matches.length
      ? `${plural(ordered.length, "command")} of ${matches.length} recorded, newest first`
      : `${plural(ordered.length, "recorded command")}, newest first`;

  const now = Date.now();
  const blocks: string[] = [];
  let remaining = MAX_RESULT_CHARS - header.length - 2;
  for (const [index, execution] of ordered.entries()) {
    // A fair share of what is left, so one noisy build log cannot crowd out the
    // commands behind it; whatever an entry does not use rolls forward.
    const share = Math.floor(remaining / (ordered.length - index));
    const block = describe(execution, includeOutput, share, now);
    if (block.length > remaining) {
      blocks.push(`… ${ordered.length - index} more not shown (result size limit)`);
      break;
    }
    blocks.push(block);
    remaining -= block.length + 2;
  }

  return `${header}\n\n${blocks.join("\n\n")}`;
}

function describe(execution: TerminalExecution, includeOutput: boolean, budget: number, now: number): string {
  const command = `${execution.terminal}$ ${execution.command}`;
  const state = status(execution, now);
  if (!includeOutput) return `${command}\n${state}`;
  return [command, state, ...outputLines(execution, budget - command.length - state.length - 4)].join("\n");
}

function status(execution: TerminalExecution, now: number): string {
  if (execution.endedAt === undefined) return `running  (started ${elapsed(now - execution.startedAt)} ago)`;
  const timing = `took ${elapsed(execution.endedAt - execution.startedAt)}, ended ${elapsed(now - execution.endedAt)} ago`;
  // A shell can end an execution without reporting a status; do not call that 0.
  const outcome = execution.exitCode === undefined ? "exit code not reported" : `exit ${execution.exitCode}`;
  return `${outcome}  (${timing})`;
}

/**
 * Captured output, indented two spaces, kept from the end: whatever a command
 * was complaining about is on its last lines.
 */
function outputLines(execution: TerminalExecution, budget: number): string[] {
  if (execution.output.length === 0) {
    return [execution.endedAt === undefined ? "  (no output captured yet)" : "  (no output captured)"];
  }

  const source = execution.output.split("\n");
  const kept: string[] = [];
  let dropped = execution.truncated;
  // Reserved up front so the marker itself can never push the block over budget.
  let used = DROPPED_MARKER.length + 1;

  for (let index = source.length - 1; index >= 0; index--) {
    const line = `  ${source[index] ?? ""}`;
    if (used + line.length + 1 > budget) {
      // A single line longer than the whole budget still has to say something.
      if (kept.length === 0 && budget > DROPPED_MARKER.length + 8) {
        kept.push(`  …${line.trimStart().slice(-(budget - used - 4))}`);
      }
      dropped = true;
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }

  kept.reverse();
  return dropped ? [DROPPED_MARKER, ...kept] : kept;
}

/** Coarse, human-readable age: exact milliseconds tell the agent nothing useful. */
function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
