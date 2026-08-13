/**
 * Verification-loop tools: enumerate the workspace's own configured tasks, run
 * one, and read the real output and exit code back.
 *
 * **Why `vscode.tasks` and not the testing API — do not "fix" this later.**
 * `vscode.tests` only lets an extension run tests that *it* owns, through its
 * own `TestController`. There is no public API to invoke another extension's
 * `TestController`, enumerate its test items, or read its results, so the
 * testing API cannot run this workspace's real test suite. Tasks can:
 * `tasks.fetchTasks()` returns everything declared in `tasks.json` plus every
 * auto-detected provider (npm, gulp, tsc, …), and `tasks.executeTask()` runs
 * any of them. Tasks are therefore the only non-fictional verification surface
 * available to an extension.
 *
 * Output capture rides on the terminal shell-integration API, which depends on
 * a feature that may not be active. When it is unavailable we say so; we never
 * fabricate output. The exit code from `onDidEndTaskProcess` is authoritative.
 */
import * as vscode from "vscode";
import { MAX_RESULT_CHARS, optInt, optString, reqString, truncate } from "./format";
import type { IdeTool, IdeToolContext } from "./types";

const MAX_LISTED_TASKS = 200;
const MAX_SUGGESTED_TASKS = 20;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_TIMEOUT_SECONDS = 900;

/** Grace period for `onDidEndTaskProcess` after `onDidEndTask` fired first. */
const PROCESS_END_GRACE_MS = 400;
/** Bounded wait for the shell-integration stream to drain after the task ends. */
const OUTPUT_FLUSH_GRACE_MS = 1_000;
/** Raw characters kept while streaming; the tail is clipped exactly at the end. */
const RAW_RETENTION_CHARS = MAX_RESULT_CHARS * 4;
/** Slack for the separator/newlines that frame the captured output. */
const FRAMING_RESERVE_CHARS = 64;

/**
 * ANSI/OSC escape sequences. `TerminalShellExecution.read()` yields the raw
 * terminal stream, which includes SGR colouring, cursor moves and VS Code's own
 * OSC 633 shell-integration markers.
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

/** Label of the task currently executing through this bridge, if any. */
let inFlightTask: string | null = null;

type EndOutcome =
  | { kind: "process"; exitCode: number | undefined }
  | { kind: "ended" }
  | { kind: "timeout" };

type CaptureResult =
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "text"; text: string; omittedLines: number };

function countLines(text: string): number {
  let lines = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
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

/**
 * Accumulates a task's terminal output.
 *
 * VS Code exposes no link from a `TaskExecution` to its `Terminal`, so a task's
 * terminal is identified as one opened after we started listening, falling back
 * to a name match for the reused-terminal case.
 */
class TaskOutputCapture {
  readonly #task: vscode.Task;
  readonly #ctx: IdeToolContext;
  readonly #disposables: vscode.Disposable[] = [];
  readonly #newTerminals = new Set<vscode.Terminal>();
  readonly #pumps: Promise<void>[] = [];
  #raw = "";
  #omittedLines = 0;
  #hooked = false;

  constructor(task: vscode.Task, ctx: IdeToolContext) {
    this.#task = task;
    this.#ctx = ctx;
  }

  /** Subscribe. MUST run before `executeTask` so no early output is missed. */
  start(): void {
    if (
      typeof vscode.window.onDidStartTerminalShellExecution !== "function" ||
      typeof vscode.window.onDidOpenTerminal !== "function"
    ) {
      this.#ctx.output.debug("[ide] terminal shell integration unavailable; task output will not be captured");
      return;
    }
    this.#disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => this.#newTerminals.add(terminal)),
      vscode.window.onDidStartTerminalShellExecution((event) => this.#consume(event)),
    );
  }

  #consume(event: vscode.TerminalShellExecutionStartEvent): void {
    if (!this.#isTaskTerminal(event.terminal)) return;
    this.#hooked = true;
    // `read()` must be called immediately or the head of the stream is lost.
    this.#pumps.push(
      (async () => {
        try {
          for await (const chunk of event.execution.read()) this.#append(chunk);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#ctx.output.debug(`[ide] task output stream ended early: ${message}`);
        }
      })(),
    );
  }

  #isTaskTerminal(terminal: vscode.Terminal): boolean {
    if (this.#newTerminals.has(terminal)) return true;
    // VS Code reuses task terminals, so a re-run can land in a pre-existing one.
    // Task terminal names embed the task name ("npm: build", "Task - lint").
    return terminal.name.toLowerCase().includes(this.#task.name.toLowerCase());
  }

  #append(chunk: string): void {
    this.#raw += chunk;
    if (this.#raw.length > RAW_RETENTION_CHARS) this.#dropHead(this.#raw.length - RAW_RETENTION_CHARS);
  }

  /** Drop at least `atLeast` characters, cutting on a line boundary. */
  #dropHead(atLeast: number): void {
    const newline = this.#raw.indexOf("\n", atLeast);
    const cut = newline === -1 ? atLeast : newline + 1;
    this.#omittedLines += countLines(this.#raw.slice(0, cut));
    this.#raw = this.#raw.slice(cut);
  }

  /** Wait — with a hard bound — for the streams to drain, then unsubscribe. */
  async finish(): Promise<void> {
    if (this.#pumps.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, OUTPUT_FLUSH_GRACE_MS);
      });
      try {
        await Promise.race([Promise.all(this.#pumps), grace]);
      } finally {
        clearTimeout(timer);
      }
    }
    this.dispose();
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
    this.#disposables.length = 0;
  }

  /** ANSI-stripped tail of the captured output, clipped to `budget` characters. */
  result(budget: number): CaptureResult {
    if (!this.#hooked) return { kind: "unavailable" };
    const text = normalizeTerminalText(this.#raw);
    if (text === "") return { kind: "empty" };
    if (budget <= 0) return { kind: "text", text: "", omittedLines: this.#omittedLines + countLines(text) + 1 };
    if (text.length <= budget) return { kind: "text", text, omittedLines: this.#omittedLines };

    // Compiler and test failures live at the end, so keep the tail.
    const from = text.length - budget;
    const newline = text.indexOf("\n", from);
    const cut = newline === -1 ? from : newline + 1;
    return {
      kind: "text",
      text: text.slice(cut),
      omittedLines: this.#omittedLines + countLines(text.slice(0, cut)),
    };
  }
}

function taskLabel(task: vscode.Task): string {
  return `${task.name} [${task.source}]`;
}

function describeTask(task: vscode.Task): string {
  const detail = task.detail?.trim() || task.definition.type;
  // `TaskGroup.id` is the stable string "build" | "test" | "clean" | "rebuild".
  const group = task.group?.id;
  return `${task.name}  [${task.source}]  ${detail}${group ? `  (group: ${group})` : ""}`;
}

/** Rank tasks by how close their name is to `needle`, best first. */
function suggestTasks(tasks: readonly vscode.Task[], needle: string): string {
  const score = (name: string): number => {
    const lower = name.toLowerCase();
    if (lower.includes(needle) || needle.includes(lower)) return 1_000;
    let shared = 0;
    while (shared < lower.length && shared < needle.length && lower[shared] === needle[shared]) shared++;
    return shared;
  };
  const ranked = [...tasks].sort((a, b) => score(b.name) - score(a.name) || a.name.localeCompare(b.name));
  const shown = ranked.slice(0, MAX_SUGGESTED_TASKS).map(taskLabel);
  const rest = ranked.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, … ${rest} more` : "");
}

async function resolveTask(name: string, source: string | undefined): Promise<vscode.Task> {
  const tasks = await vscode.tasks.fetchTasks();
  const needle = name.toLowerCase();

  // Exact match wins, then case-insensitive exact, then substring.
  let candidates = tasks.filter((task) => task.name === name);
  if (candidates.length === 0) candidates = tasks.filter((task) => task.name.toLowerCase() === needle);
  if (candidates.length === 0) candidates = tasks.filter((task) => task.name.toLowerCase().includes(needle));

  if (candidates.length > 1 && source !== undefined) {
    const wanted = source.toLowerCase();
    const scoped = candidates.filter((task) => task.source.toLowerCase() === wanted);
    if (scoped.length > 0) candidates = scoped;
  }

  const [first] = candidates;
  if (candidates.length === 1 && first !== undefined) return first;

  if (candidates.length === 0) {
    if (tasks.length === 0) throw new Error("No tasks available in this workspace, so none can be run.");
    throw new Error(`No task matches "${name}". Available tasks: ${suggestTasks(tasks, needle)}.`);
  }
  throw new Error(
    `"${name}" matches several tasks: ${candidates.map(taskLabel).join(", ")}. ` +
      'Re-run with the exact name, and pass "source" to disambiguate.',
  );
}

function buildReport(
  task: vscode.Task,
  outcome: EndOutcome,
  timeoutSeconds: number,
  elapsedMs: number,
  capture: TaskOutputCapture,
): string {
  const elapsed = (elapsedMs / 1_000).toFixed(1);
  const head: string[] = [];
  switch (outcome.kind) {
    case "timeout":
      head.push(`Task "${task.name}" timed out after ${timeoutSeconds}s and was terminated.`);
      head.push("It never finished, so it neither succeeded nor failed on its own terms.");
      break;
    case "process":
      if (outcome.exitCode === undefined) {
        head.push(`Task "${task.name}" completed (no exit code reported) after ${elapsed}s.`);
        head.push(
          "The process was terminated before reporting an exit code, so success cannot be determined from it — read the output below.",
        );
      } else {
        head.push(`Task "${task.name}" exited with code ${outcome.exitCode} after ${elapsed}s.`);
        head.push(outcome.exitCode === 0 ? "That means the task succeeded." : "That means the task failed.");
      }
      break;
    case "ended":
      head.push(`Task "${task.name}" completed (no exit code reported) after ${elapsed}s.`);
      head.push(
        "It runs no process (background or custom execution), so success cannot be determined from an exit code — read the output below.",
      );
      break;
  }

  const failed = outcome.kind === "process" && outcome.exitCode !== undefined && outcome.exitCode !== 0;
  const tail = failed ? ["", "Re-run the diagnostics tool to see updated problems."] : [];

  const framing = head.join("\n").length + tail.join("\n").length + FRAMING_RESERVE_CHARS;
  const result = capture.result(MAX_RESULT_CHARS - framing);
  const body: string[] = [];
  switch (result.kind) {
    case "unavailable":
      body.push("Task output could not be captured (shell integration unavailable); exit code is authoritative.");
      break;
    case "empty":
      body.push("Task produced no output.");
      break;
    case "text":
      body.push("--- output (tail) ---");
      if (result.omittedLines > 0) body.push(`… ${result.omittedLines} earlier lines omitted`);
      body.push(result.text);
      break;
  }

  return truncate([...head, "", ...body, ...tail]);
}

async function runTask(task: vscode.Task, timeoutSeconds: number, ctx: IdeToolContext): Promise<string> {
  const capture = new TaskOutputCapture(task, ctx);
  const disposables: vscode.Disposable[] = [];
  const timers: NodeJS.Timeout[] = [];
  const startedAt = Date.now();

  let execution: vscode.TaskExecution | undefined;
  let settled = false;
  let settle: (outcome: EndOutcome) => void = () => {};
  const ended = new Promise<EndOutcome>((resolve) => {
    settle = resolve;
  });
  /** End events seen before `executeTask` handed us the execution identity. */
  const buffered: Array<[vscode.TaskExecution, EndOutcome]> = [];
  let processGrace: NodeJS.Timeout | undefined;

  const observe = (candidate: vscode.TaskExecution, outcome: EndOutcome): void => {
    if (execution === undefined) {
      buffered.push([candidate, outcome]);
      return;
    }
    if (candidate !== execution || settled) return;
    if (outcome.kind === "ended") {
      // `onDidEndTask` can fire before `onDidEndTaskProcess`. Wait a beat for the
      // authoritative exit code rather than reporting it as absent; the timer is
      // bounded, so a genuinely process-less task still completes.
      if (processGrace === undefined) {
        processGrace = setTimeout(() => {
          if (settled) return;
          settled = true;
          settle(outcome);
        }, PROCESS_END_GRACE_MS);
        timers.push(processGrace);
      }
      return;
    }
    settled = true;
    settle(outcome);
  };

  try {
    capture.start();
    disposables.push(
      vscode.tasks.onDidEndTaskProcess((event) =>
        observe(event.execution, { kind: "process", exitCode: event.exitCode }),
      ),
      vscode.tasks.onDidEndTask((event) => observe(event.execution, { kind: "ended" })),
    );

    const timedOut = new Promise<"timeout">((resolve) => {
      timers.push(setTimeout(() => resolve("timeout"), timeoutSeconds * 1_000));
    });

    // The launch is raced too: no path through this function may hang.
    const launched = await Promise.race([Promise.resolve(vscode.tasks.executeTask(task)), timedOut]);
    if (launched === "timeout") {
      ctx.output.warn(`[ide] task "${task.name}" did not start within ${timeoutSeconds}s`);
      await capture.finish();
      return buildReport(task, { kind: "timeout" }, timeoutSeconds, Date.now() - startedAt, capture);
    }

    execution = launched;
    for (const [candidate, outcome] of buffered.splice(0)) observe(candidate, outcome);

    const outcome = await Promise.race([ended, timedOut.then((): EndOutcome => ({ kind: "timeout" }))]);
    if (outcome.kind === "timeout") {
      try {
        execution.terminate();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.output.warn(`[ide] failed to terminate task "${task.name}": ${message}`);
      }
    }
    await capture.finish();
    return buildReport(task, outcome, timeoutSeconds, Date.now() - startedAt, capture);
  } finally {
    for (const disposable of disposables) disposable.dispose();
    for (const timer of timers) clearTimeout(timer);
    capture.dispose();
  }
}

export const taskTools: IdeTool[] = [
  {
    name: "list_tasks",
    description:
      "List the tasks this workspace configures (tasks.json plus auto-detected npm/gulp/tsc providers). " +
      "Use it to find the project's real build, test and lint commands before running one with run_task.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    async invoke(_args, ctx): Promise<string> {
      const tasks = await vscode.tasks.fetchTasks();
      if (tasks.length === 0) return "No tasks available in this workspace.";

      const bySource = new Map<string, vscode.Task[]>();
      for (const task of tasks) {
        const group = bySource.get(task.source);
        if (group) group.push(task);
        else bySource.set(task.source, [task]);
      }

      const lines: string[] = [];
      let omitted = 0;
      for (const source of [...bySource.keys()].sort((a, b) => a.localeCompare(b))) {
        for (const task of bySource.get(source) ?? []) {
          if (lines.length >= MAX_LISTED_TASKS) omitted++;
          else lines.push(describeTask(task));
        }
      }
      ctx.output.debug(`[ide] list_tasks: ${tasks.length} task(s) for ${ctx.cwd}`);
      return truncate(lines, { omitted });
    },
  },
  {
    name: "run_task",
    description:
      "Run one of this workspace's configured tasks (see list_tasks) and return its exit code and terminal output. " +
      "This is the verification loop: use it to build, test or lint after making changes.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Task name as reported by list_tasks. An exact match wins; a unique case-insensitive substring also resolves.",
        },
        source: {
          type: "string",
          description: 'Task source (e.g. "npm", "Workspace"). Only needed when several sources define the same task name.',
        },
        timeout: {
          type: "number",
          description: `Seconds to wait before terminating the task. Default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}.`,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async invoke(args, ctx): Promise<string> {
      const name = reqString(args, "name");
      const source = optString(args, "source");
      const timeoutSeconds = optInt(args, "timeout", DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS);

      // Checked and claimed synchronously — one task at a time per bridge.
      if (inFlightTask !== null) {
        throw new Error(
          `Task "${inFlightTask}" is already running from this IDE bridge. Wait for it to finish (or to hit its timeout) before starting another.`,
        );
      }
      inFlightTask = name;
      try {
        const task = await resolveTask(name, source);
        inFlightTask = taskLabel(task);
        ctx.output.info(`[ide] run_task ${inFlightTask} (timeout ${timeoutSeconds}s, cwd ${ctx.cwd})`);
        return await runTask(task, timeoutSeconds, ctx);
      } finally {
        inFlightTask = null;
      }
    },
  },
];
