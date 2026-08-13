/**
 * Structured test running: detect the project's own test framework, run it
 * through its own machine-readable reporter, and hand the agent typed counts and
 * failures instead of scraped terminal text.
 *
 * **Why this spawns a process instead of using `vscode.tests` — do not "fix"
 * this later.** `tasks.ts` documents the same constraint for tasks and it holds
 * here with full force: the `vscode.tests` namespace exposes exactly one member,
 * `createTestController`. An extension can therefore only run tests that *it*
 * owns, through a controller it created itself. There is no public API to
 * enumerate another extension's `TestItem`s, invoke its `TestRunProfile`, or
 * read its `TestRun` results, so the Test Explorer's view of this workspace's
 * real suite is unreachable from here. The only non-fictional way to obtain
 * structured results is to run the project's own runner with its own
 * machine-readable reporter and parse that output. That is what this module
 * does, and why it must keep doing it.
 *
 * `run_task` (tasks.ts) stays the general verification loop and returns text;
 * `run_tests` complements it by returning structure — counts, and per-failure
 * name, file and line — so a failure can be acted on without re-reading a
 * truncated log.
 *
 * Honesty rules, same as tasks.ts: when a reporter's payload cannot be parsed we
 * report the exit code plus a clipped output tail, explicitly labelled unparsed.
 * We never synthesise a zero-failure result from an unreadable run.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findOnPath, resolveSpawnTarget } from "../../rpc/spawn-target";
import { isRecord } from "../../shared/guards";
import { MAX_RESULT_CHARS, clip, optBool, optInt, optString, plural, relPath, truncate } from "./format";
import type { IdeTool, IdeToolContext } from "./types";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 1_800;
/** Collection is cheap next to a full run, but must still not hang forever. */
const LIST_TIMEOUT_SECONDS = 120;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 5_000;

/** Retained stdout/stderr per stream. The head is dropped, the tail kept. */
const MAX_CAPTURE_CHARS = 1024 * 1024;
/** Failures listed in full detail; the rest are summarised by `truncate`. */
const MAX_LISTED_FAILURES = 50;
/** Message lines kept per failure — enough for an assertion diff, not a stack. */
const MAX_FAILURE_MESSAGE_LINES = 6;
const MAX_FAILURE_LINE_CHARS = 240;
/** Slack for the separator/newlines that frame a report. */
const FRAMING_RESERVE_CHARS = 96;
/** Grace between the polite terminate and the forced tree kill. */
const KILL_GRACE_MS = 3_000;

export type Framework = "vitest" | "jest" | "mocha" | "pytest" | "cargo" | "go" | "dotnet";

/** Detection and override precedence. */
const FRAMEWORKS: readonly Framework[] = ["vitest", "jest", "mocha", "pytest", "cargo", "go", "dotnet"];

export interface TestFailure {
  name: string;
  file?: string;
  line?: number;
  message: string;
}

export interface TestRunResult {
  framework: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs?: number;
  failures: TestFailure[];
  exitCode: number | null;
  stderrTail?: string;
}

/**
 * Last parsed run per cwd, so `rerun: "failed"` can replay exactly the tests
 * that failed. Unparsed runs are deliberately not recorded: replaying a guess
 * would be worse than admitting there is nothing to replay.
 */
const lastRuns = new Map<string, TestRunResult>();

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

async function readTextIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    // Absent or unreadable is simply "not a marker".
    return undefined;
  }
}

function jsRunnerMarkers(packageJson: string | undefined): Set<Framework> {
  const found = new Set<Framework>();
  if (packageJson === undefined) return found;

  let root: unknown;
  try {
    root = JSON.parse(packageJson);
  } catch {
    // A malformed manifest is not a detection failure; it is just no evidence.
    return found;
  }
  if (!isRecord(root)) return found;

  const names: string[] = [];
  for (const key of ["devDependencies", "dependencies"]) {
    const section = root[key];
    if (isRecord(section)) names.push(...Object.keys(section));
  }
  const scripts = isRecord(root.scripts)
    ? Object.values(root.scripts).filter((value): value is string => typeof value === "string")
    : [];

  for (const candidate of ["vitest", "jest", "mocha"] as const) {
    const declared = names.some((name) => name === candidate || name.startsWith(`${candidate}-`) || name.endsWith(`/${candidate}`));
    const scripted = scripts.some((script) => new RegExp(`\\b${candidate}\\b`).test(script));
    if (declared || scripted) found.add(candidate);
  }
  return found;
}

/**
 * A .NET solution usually sits at the root with its projects one level down, so
 * the scan stops at depth two rather than walking an unbounded tree.
 */
async function hasDotnetProject(cwd: string): Promise<boolean> {
  const roots = [cwd];
  try {
    for (const entry of await readdir(cwd, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        roots.push(path.join(cwd, entry.name));
      }
    }
  } catch {
    return false;
  }
  for (const root of roots) {
    try {
      for (const entry of await readdir(root)) {
        if (/\.(?:csproj|fsproj|sln)$/i.test(entry)) return true;
      }
    } catch {
      // Unreadable directory: no evidence, keep looking.
    }
  }
  return false;
}

/** Every framework this workspace shows on-disk evidence of, best guess first. */
export async function detectFrameworks(cwd: string): Promise<Framework[]> {
  const [packageJson, pyproject, setupCfg, pytestIni, toxIni, cargoToml, goMod, dotnet] = await Promise.all([
    readTextIfPresent(path.join(cwd, "package.json")),
    readTextIfPresent(path.join(cwd, "pyproject.toml")),
    readTextIfPresent(path.join(cwd, "setup.cfg")),
    readTextIfPresent(path.join(cwd, "pytest.ini")),
    readTextIfPresent(path.join(cwd, "tox.ini")),
    readTextIfPresent(path.join(cwd, "Cargo.toml")),
    readTextIfPresent(path.join(cwd, "go.mod")),
    hasDotnetProject(cwd),
  ]);

  const js = jsRunnerMarkers(packageJson);
  const pytest =
    pytestIni !== undefined ||
    toxIni !== undefined ||
    (pyproject?.includes("[tool.pytest") ?? false) ||
    (setupCfg?.includes("[tool:pytest]") ?? false);

  const detected: Framework[] = [];
  for (const framework of FRAMEWORKS) {
    switch (framework) {
      case "vitest":
      case "jest":
      case "mocha":
        if (js.has(framework)) detected.push(framework);
        break;
      case "pytest":
        if (pytest) detected.push(framework);
        break;
      case "cargo":
        if (cargoToml !== undefined) detected.push(framework);
        break;
      case "go":
        if (goMod !== undefined) detected.push(framework);
        break;
      case "dotnet":
        if (dotnet) detected.push(framework);
        break;
    }
  }
  return detected;
}

// ---------------------------------------------------------------------------
// Minimal XML reading
// ---------------------------------------------------------------------------
//
// JUnit and TRX only need element names, attributes and the text of a couple of
// known children. A focused scanner is the right size of tool for that; pulling
// in an XML parser would break this package's zero-dependency rule for no gain.

interface XmlElement {
  readonly attributes: Readonly<Record<string, string>>;
  /** Inner markup, empty for a self-closing element. */
  readonly body: string;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") || entity.startsWith("#X")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Index of the `>` closing the tag that starts at `from`, skipping any `>` that
 * sits inside a quoted attribute value — XML permits a raw `>` there, and
 * pytest's failure messages do contain them.
 */
function findTagEnd(xml: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < xml.length; index++) {
    const char = xml[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const name = match[1];
    const value = match[2] ?? match[3];
    if (name !== undefined && value !== undefined) attributes[name] = decodeXml(value);
  }
  return attributes;
}

/** Every `<name …>` element at any depth, with attributes and inner markup. */
function scanElements(xml: string, name: string): XmlElement[] {
  const elements: XmlElement[] = [];
  const opener = new RegExp(`<${name}(?=[\\s/>])`, "g");
  for (let match = opener.exec(xml); match !== null; match = opener.exec(xml)) {
    const tagStart = match.index;
    const tagEnd = findTagEnd(xml, tagStart);
    if (tagEnd < 0) break;
    const inner = xml.slice(tagStart + name.length + 1, tagEnd);
    const attributes = parseAttributes(inner);
    if (inner.trimEnd().endsWith("/")) {
      elements.push({ attributes, body: "" });
    } else {
      const close = xml.indexOf(`</${name}`, tagEnd);
      elements.push({ attributes, body: close < 0 ? xml.slice(tagEnd + 1) : xml.slice(tagEnd + 1, close) });
    }
    opener.lastIndex = tagEnd + 1;
  }
  return elements;
}

/** Text of the first `<name>…</name>` child in `body`. */
function childText(body: string, name: string): string | undefined {
  const element = scanElements(body, name)[0];
  if (element === undefined) return undefined;
  const text = decodeXml(element.body).trim();
  return text.length > 0 ? text : undefined;
}

// ---------------------------------------------------------------------------
// Parser plumbing
// ---------------------------------------------------------------------------

/** A reporter payload parser. `undefined` means "this made no sense to me". */
export type TestParser = (text: string) => TestRunResult | undefined;

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericAttribute(element: XmlElement, key: string): number | undefined {
  const raw = element.attributes[key];
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse a JSON document that may be surrounded by the runner's own chatter. */
function parseJsonLoose(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** First `<file>:<line>` reference to `file` in a stack or message blob. */
function lineFromStack(text: string, file: string): number | undefined {
  const base = path.basename(file.replace(/\\/g, "/"));
  if (base.length === 0) return undefined;
  const match = new RegExp(`${escapeRegExp(base)}:(\\d+)`).exec(text);
  const captured = match?.[1];
  return captured === undefined ? undefined : Number.parseInt(captured, 10);
}

/** `panicked at src/lib.rs:42:9:` — Rust's location shape, drive letter and all. */
function rustPanicLocation(text: string): { file: string; line: number } | undefined {
  const match = /panicked at ((?:[a-zA-Z]:)?[^\s:][^:\n]*):(\d+):(?:\d+)/.exec(text);
  const file = match?.[1];
  const line = match?.[2];
  if (file === undefined || line === undefined) return undefined;
  return { file, line: Number.parseInt(line, 10) };
}

function firstMeaningfulLine(text: string, fallback: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
}

const NO_MESSAGE = "(no failure message reported)";

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Vitest's `--reporter=json` deliberately mirrors Jest's JSON shape, so one
 * implementation serves both; the framework name is the only difference.
 */
function parseJestStyleJson(text: string, framework: Framework): TestRunResult | undefined {
  const root = parseJsonLoose(text);
  if (!isRecord(root)) return undefined;

  const passed = numberField(root, "numPassedTests");
  const failed = numberField(root, "numFailedTests");
  if (passed === undefined || failed === undefined) return undefined;

  const skipped = (numberField(root, "numPendingTests") ?? 0) + (numberField(root, "numTodoTests") ?? 0);
  const failures: TestFailure[] = [];
  const suites = Array.isArray(root.testResults) ? root.testResults : [];
  let latestEnd = 0;

  for (const suite of suites) {
    if (!isRecord(suite)) continue;
    const file = stringField(suite, "name");
    const end = numberField(suite, "endTime");
    if (end !== undefined) latestEnd = Math.max(latestEnd, end);

    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    let suiteFailures = 0;
    for (const assertion of assertions) {
      if (!isRecord(assertion) || assertion.status !== "failed") continue;
      suiteFailures++;
      const messages = Array.isArray(assertion.failureMessages)
        ? assertion.failureMessages.filter((value): value is string => typeof value === "string")
        : [];
      const message = messages.join("\n").trim();
      const location = isRecord(assertion.location) ? numberField(assertion.location, "line") : undefined;
      failures.push({
        name: stringField(assertion, "fullName") ?? stringField(assertion, "title") ?? "(unnamed test)",
        file,
        line: location ?? (file !== undefined ? lineFromStack(message, file) : undefined),
        message: message.length > 0 ? message : NO_MESSAGE,
      });
    }

    // A suite that never ran (import or transform error) has no failed
    // assertions to report, only a file-level message. Surface it, or the agent
    // sees a non-zero failure count with nothing to look at.
    const suiteMessage = stringField(suite, "failureMessage");
    if (suiteFailures === 0 && suiteMessage !== undefined) {
      failures.push({
        name: `${file ?? "(unknown file)"} (suite failed to run)`,
        file,
        line: file !== undefined ? lineFromStack(suiteMessage, file) : undefined,
        message: suiteMessage.trim(),
      });
    }
  }

  const start = numberField(root, "startTime");
  return {
    framework,
    passed,
    failed,
    skipped,
    durationMs: start !== undefined && latestEnd > start ? latestEnd - start : undefined,
    failures,
    exitCode: null,
  };
}

export const parseVitestJson: TestParser = (text) => parseJestStyleJson(text, "vitest");
export const parseJestJson: TestParser = (text) => parseJestStyleJson(text, "jest");

export const parseMochaJson: TestParser = (text) => {
  const root = parseJsonLoose(text);
  if (!isRecord(root) || !isRecord(root.stats)) return undefined;

  const passed = numberField(root.stats, "passes");
  const failed = numberField(root.stats, "failures");
  if (passed === undefined || failed === undefined) return undefined;

  const failures: TestFailure[] = [];
  for (const entry of Array.isArray(root.failures) ? root.failures : []) {
    if (!isRecord(entry)) continue;
    const file = stringField(entry, "file");
    const error = isRecord(entry.err) ? entry.err : undefined;
    const message = error === undefined ? undefined : stringField(error, "message");
    const stack = error === undefined ? undefined : stringField(error, "stack");
    failures.push({
      name: stringField(entry, "fullTitle") ?? stringField(entry, "title") ?? "(unnamed test)",
      file,
      line: file !== undefined && stack !== undefined ? lineFromStack(stack, file) : undefined,
      message: message ?? (stack !== undefined ? firstMeaningfulLine(stack, NO_MESSAGE) : NO_MESSAGE),
    });
  }

  return {
    framework: "mocha",
    passed,
    failed,
    skipped: numberField(root.stats, "pending") ?? 0,
    durationMs: numberField(root.stats, "duration"),
    failures,
    exitCode: null,
  };
};

export const parsePytestJunitXml: TestParser = (text) => {
  const cases = scanElements(text, "testcase");
  if (cases.length === 0 && !text.includes("<testsuite")) return undefined;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let seconds = 0;
  const failures: TestFailure[] = [];

  for (const testcase of cases) {
    seconds += numericAttribute(testcase, "time") ?? 0;
    const problems = [...scanElements(testcase.body, "failure"), ...scanElements(testcase.body, "error")];
    const name = testcase.attributes.name ?? "(unnamed test)";
    const classname = testcase.attributes.classname;

    if (problems.length > 0) {
      failed++;
      const detail = problems
        .map((problem) =>
          [problem.attributes.message, decodeXml(problem.body).trim()]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join("\n"),
        )
        .join("\n")
        .trim();
      // pytest writes `line` from its own 0-based report location, so it needs
      // the +1 that every other position in these tools already carries.
      const rawLine = numericAttribute(testcase, "line");
      failures.push({
        name: classname !== undefined && classname.length > 0 ? `${classname}::${name}` : name,
        file: testcase.attributes.file,
        line: rawLine === undefined ? undefined : rawLine + 1,
        message: detail.length > 0 ? detail : NO_MESSAGE,
      });
      continue;
    }
    if (scanElements(testcase.body, "skipped").length > 0) skipped++;
    else passed++;
  }

  return {
    framework: "pytest",
    passed,
    failed,
    skipped,
    durationMs: seconds > 0 ? Math.round(seconds * 1_000) : undefined,
    failures,
    exitCode: null,
  };
};

export const parseTrxXml: TestParser = (text) => {
  const results = scanElements(text, "UnitTestResult");
  const counters = scanElements(text, "Counters")[0];
  if (results.length === 0 && counters === undefined) return undefined;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs = 0;
  const failures: TestFailure[] = [];

  for (const result of results) {
    durationMs += parseTrxDuration(result.attributes.duration);
    const outcome = result.attributes.outcome ?? "";
    if (outcome === "Passed") {
      passed++;
      continue;
    }
    if (outcome === "Failed" || outcome === "Error" || outcome === "Timeout" || outcome === "Aborted") {
      failed++;
      const message = childText(result.body, "Message");
      const stack = childText(result.body, "StackTrace");
      const location = stack === undefined ? undefined : trxStackLocation(stack);
      failures.push({
        name: result.attributes.testName ?? "(unnamed test)",
        file: location?.file,
        line: location?.line,
        message: message ?? (stack !== undefined ? firstMeaningfulLine(stack, NO_MESSAGE) : NO_MESSAGE),
      });
      continue;
    }
    skipped++;
  }

  // `<Counters>` is vstest's own tally and outranks our walk when both exist.
  if (counters !== undefined) {
    const counted = numericAttribute(counters, "passed");
    const failedCount = numericAttribute(counters, "failed");
    if (counted !== undefined && failedCount !== undefined) {
      passed = counted;
      failed = failedCount + (numericAttribute(counters, "error") ?? 0);
      const total = numericAttribute(counters, "total");
      const notExecuted = numericAttribute(counters, "notExecuted");
      skipped = notExecuted ?? (total === undefined ? skipped : Math.max(0, total - passed - failed));
    }
  }

  return {
    framework: "dotnet",
    passed,
    failed,
    skipped,
    durationMs: durationMs > 0 ? durationMs : undefined,
    failures,
    exitCode: null,
  };
};

/** TRX durations are `hh:mm:ss.fffffff`. */
function parseTrxDuration(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  const hours = match?.[1];
  const minutes = match?.[2];
  const seconds = match?.[3];
  if (hours === undefined || minutes === undefined || seconds === undefined) return 0;
  return Math.round((Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)) * 1_000);
}

/** `at Ns.Type.Method() in C:\src\File.cs:line 42`. */
function trxStackLocation(stack: string): { file: string; line: number } | undefined {
  const match = /\sin\s(.+?):line\s(\d+)/.exec(stack);
  const file = match?.[1];
  const line = match?.[2];
  if (file === undefined || line === undefined) return undefined;
  return { file: file.trim(), line: Number.parseInt(line, 10) };
}

interface GoTestRecord {
  outcome?: "pass" | "fail" | "skip";
  output: string[];
}

export const parseGoTestJson: TestParser = (text) => {
  const tests = new Map<string, GoTestRecord>();
  let packageSeconds = 0;
  let events = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // `go test -json` interleaves plain build errors; they are not events.
      continue;
    }
    if (!isRecord(event)) continue;
    const action = stringField(event, "Action");
    if (action === undefined) continue;
    events++;

    const test = stringField(event, "Test");
    if (test === undefined) {
      if (action === "pass" || action === "fail") packageSeconds += numberField(event, "Elapsed") ?? 0;
      continue;
    }

    const key = `${stringField(event, "Package") ?? ""}\u0000${test}`;
    const record: GoTestRecord = tests.get(key) ?? { output: [] };
    if (action === "output") {
      const output = stringField(event, "Output");
      if (output !== undefined) record.output.push(output);
    } else if (action === "pass" || action === "fail" || action === "skip") {
      record.outcome = action;
    }
    tests.set(key, record);
  }

  if (events === 0) return undefined;

  // Go reports a parent test's own pass/fail alongside every subtest's, so
  // counting both double-counts. Leaves are the real tests; a parent is only
  // reported as a failure when none of its subtests carries the blame.
  const isParent = (key: string): boolean => {
    for (const other of tests.keys()) {
      if (other !== key && other.startsWith(`${key}/`)) return true;
    }
    return false;
  };
  const hasFailedDescendant = (key: string): boolean => {
    for (const [other, record] of tests) {
      if (other !== key && other.startsWith(`${key}/`) && record.outcome === "fail") return true;
    }
    return false;
  };

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: TestFailure[] = [];

  for (const [key, record] of tests) {
    const parent = isParent(key);
    if (!parent) {
      if (record.outcome === "pass") passed++;
      else if (record.outcome === "fail") failed++;
      else if (record.outcome === "skip") skipped++;
    }
    if (record.outcome !== "fail" || (parent && hasFailedDescendant(key))) continue;

    const [pkg = "", test = key] = key.split("\u0000");
    const body = record.output.join("");
    // Go's own failure lines are `    file.go:42: message`, relative to the
    // package directory rather than the workspace, so the name stays as-is.
    const located = /(^|\n)\s*([\w.\-/\\]+\.go):(\d+):[ \t]*(.*)/.exec(body);
    const file = located?.[2];
    const line = located?.[3];
    const message = located?.[4];
    failures.push({
      name: pkg.length > 0 ? `${pkg}.${test}` : test,
      file,
      line: line === undefined ? undefined : Number.parseInt(line, 10),
      message: message !== undefined && message.trim().length > 0 ? message.trim() : firstMeaningfulLine(body, NO_MESSAGE),
    });
  }

  return {
    framework: "go",
    passed,
    failed,
    skipped,
    durationMs: packageSeconds > 0 ? Math.round(packageSeconds * 1_000) : undefined,
    failures,
    exitCode: null,
  };
};

/**
 * `cargo nextest run --message-format libtest-json` emits libtest's own NDJSON
 * event stream: `test` events per test, a closing `suite` event with the tally.
 */
export const parseNextestLibtestJson: TestParser = (text) => {
  let summary: Record<string, unknown> | undefined;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let seconds = 0;
  let events = 0;
  const failures: TestFailure[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const type = stringField(event, "type");
    const action = stringField(event, "event");
    if (type === undefined || action === undefined) continue;
    events++;

    if (type === "suite") {
      if (action !== "started") summary = event;
      continue;
    }
    if (type !== "test") continue;

    if (action === "ok") passed++;
    else if (action === "ignored") skipped++;
    else if (action === "failed" || action === "timeout") {
      failed++;
      const body = [stringField(event, "stdout"), stringField(event, "stderr"), stringField(event, "message")]
        .filter((value): value is string => value !== undefined)
        .join("\n");
      const location = rustPanicLocation(body);
      failures.push({
        name: stringField(event, "name") ?? "(unnamed test)",
        file: location?.file,
        line: location?.line,
        message: nextestFailureMessage(body),
      });
    }
    seconds += numberField(event, "exec_time") ?? 0;
  }

  if (events === 0) return undefined;

  if (summary !== undefined) {
    passed = numberField(summary, "passed") ?? passed;
    failed = numberField(summary, "failed") ?? failed;
    skipped = numberField(summary, "ignored") ?? skipped;
    seconds = numberField(summary, "exec_time") ?? seconds;
  }

  return {
    framework: "cargo",
    passed,
    failed,
    skipped,
    durationMs: seconds > 0 ? Math.round(seconds * 1_000) : undefined,
    failures,
    exitCode: null,
  };
};

/** The panic message proper: what follows `panicked at …:` beats the banner. */
function nextestFailureMessage(body: string): string {
  const match = /panicked at [^\n]*\n([\s\S]*)/.exec(body);
  const tail = match?.[1];
  if (tail !== undefined) {
    const message = firstMeaningfulLine(tail, "");
    if (message.length > 0) return message;
  }
  return firstMeaningfulLine(body, NO_MESSAGE);
}

/**
 * libtest's stable text output, as printed by plain `cargo test`. The per-test
 * lines and the `test result:` summary have been stable for years; both are
 * read, with the summaries winning because they cover every test binary.
 */
export const parseCargoTestText: TestParser = (text) => {
  const perTest = { passed: 0, failed: 0, skipped: 0 };
  const summed = { passed: 0, failed: 0, skipped: 0 };
  let summaries = 0;
  let seconds = 0;

  const testLine = /^test\s+\S+\s+\.\.\.\s+(ok|FAILED|ignored)/;
  const summaryLine = /^test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const test = testLine.exec(line);
    if (test !== null) {
      if (test[1] === "ok") perTest.passed++;
      else if (test[1] === "FAILED") perTest.failed++;
      else perTest.skipped++;
      continue;
    }
    const summary = summaryLine.exec(line);
    if (summary !== null) {
      summaries++;
      summed.passed += Number(summary[1]);
      summed.failed += Number(summary[2]);
      summed.skipped += Number(summary[3]);
      const finished = /finished in ([\d.]+)s/.exec(line);
      if (finished?.[1] !== undefined) seconds += Number(finished[1]);
      continue;
    }
  }

  if (summaries === 0 && perTest.passed + perTest.failed + perTest.skipped === 0) return undefined;
  const counts = summaries > 0 ? summed : perTest;

  const failures: TestFailure[] = [];
  const block = /^---- (.+?) stdout ----$([\s\S]*?)(?=^---- |^failures:$|$(?![\s\S]))/gm;
  for (let match = block.exec(text); match !== null; match = block.exec(text)) {
    const name = match[1];
    const body = match[2] ?? "";
    if (name === undefined) continue;
    const location = rustPanicLocation(body);
    failures.push({
      name,
      file: location?.file,
      line: location?.line,
      message: nextestFailureMessage(body),
    });
  }

  return {
    framework: "cargo",
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    durationMs: seconds > 0 ? Math.round(seconds * 1_000) : undefined,
    failures,
    exitCode: null,
  };
};

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

interface RunOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Characters of output dropped by the retention cap, head-first. */
  droppedChars: number;
  durationMs: number;
  timedOut: boolean;
  spawnError?: string;
  commandLine: string;
}

/** Keeps the tail of a stream inside a fixed budget. */
class TailBuffer {
  #text = "";
  #dropped = 0;

  push(chunk: string): void {
    this.#text += chunk;
    if (this.#text.length > MAX_CAPTURE_CHARS) {
      const excess = this.#text.length - MAX_CAPTURE_CHARS;
      this.#text = this.#text.slice(excess);
      this.#dropped += excess;
    }
  }

  get text(): string {
    return this.#text;
  }

  get dropped(): number {
    return this.#dropped;
  }
}

const POSIX = process.platform !== "win32";

/**
 * Kill the runner *and its children* — test runners fan out into workers and
 * compilers, and killing only the direct child orphans those.
 */
function killTree(pid: number, force: boolean, ctx: IdeToolContext): void {
  if (POSIX) {
    // The child was spawned detached, so it leads its own process group.
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch (error) {
      ctx.output.debug(`[ide] run_tests: group kill failed for pid ${pid}: ${describeError(error)}`);
    }
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // Already gone.
    }
    return;
  }
  // Windows has no signals: `taskkill /t` is the only way to reach the tree,
  // politely without `/f`, forcibly with it.
  const args = force ? ["/pid", String(pid), "/t", "/f"] : ["/pid", String(pid), "/t"];
  try {
    spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).unref();
  } catch (error) {
    ctx.output.warn(`[ide] run_tests: taskkill failed for pid ${pid}: ${describeError(error)}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a command to completion, honouring `timeoutSeconds`.
 *
 * Windows resolution of `npx`/`cargo`/`go`/`dotnet` goes through
 * `resolveSpawnTarget` (src/rpc/spawn-target.ts), which already handles PATHEXT
 * and the `.cmd` shims npm installs — `npx` on Windows *is* a batch shim, so
 * spawning it directly would fail with ENOENT.
 */
async function execute(
  command: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>>,
  cwd: string,
  timeoutSeconds: number,
  ctx: IdeToolContext,
): Promise<RunOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Runners must behave as they do on CI: no colour, no interactive prompts,
    // no watch mode.
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extraEnv,
  };
  const target = resolveSpawnTarget(command, [...args], env);
  const commandLine = `${command} ${args.join(" ")}`.trim();
  const startedAt = Date.now();

  ctx.output.info(`[ide] run_tests spawn: ${commandLine} (cwd ${cwd}, timeout ${timeoutSeconds}s)`);

  return await new Promise<RunOutcome>((resolve) => {
    const stdout = new TailBuffer();
    const stderr = new TailBuffer();
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const child = spawn(target.command, target.args, {
      cwd,
      env,
      // Never inherit stdin: a runner that prompts must fail, not hang.
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: POSIX,
      windowsHide: true,
      ...(target.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });

    const finish = (outcome: Omit<RunOutcome, "stdout" | "stderr" | "droppedChars" | "durationMs" | "commandLine">): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve({
        ...outcome,
        stdout: stdout.text,
        stderr: stderr.text,
        droppedChars: stdout.dropped + stderr.dropped,
        durationMs: Date.now() - startedAt,
        commandLine,
      });
    };

    // An explicit `stdio` array types these as nullable; without them there is
    // nothing to parse, and saying so beats reporting an empty run.
    const out = child.stdout;
    const errors = child.stderr;
    if (out === null || errors === null) {
      finish({ exitCode: null, signal: null, timedOut, spawnError: "the runner's output streams were unavailable" });
      return;
    }
    out.setEncoding("utf8");
    errors.setEncoding("utf8");
    out.on("data", (chunk: string) => stdout.push(chunk));
    errors.on("data", (chunk: string) => stderr.push(chunk));

    timers.push(
      setTimeout(() => {
        timedOut = true;
        const pid = child.pid;
        if (pid === undefined) return;
        killTree(pid, false, ctx);
        timers.push(setTimeout(() => killTree(pid, true, ctx), KILL_GRACE_MS));
      }, timeoutSeconds * 1_000),
    );

    child.on("error", (error) => {
      finish({ exitCode: null, signal: null, timedOut, spawnError: describeError(error) });
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Run plans
// ---------------------------------------------------------------------------

interface RunPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Human name of the reporter, for the unparsed-output report. */
  reporter: string;
  /** Reporter payload file, when the runner writes one instead of stdout. */
  outputFile?: string;
  /** Anything the request asked for that this runner cannot honour. */
  notes: string[];
  parse: TestParser;
}

interface RunRequest {
  paths: string[];
  filter?: string;
  coverage: boolean;
  /** Argv fragment that selects the previously failed tests, if replaying. */
  rerunArgs?: string[];
}

const COVERAGE_FLAG: Readonly<Record<Framework, string | undefined>> = {
  vitest: "--coverage",
  jest: "--coverage",
  mocha: undefined,
  // `--cov` comes from pytest-cov. If it is not installed pytest fails loudly
  // with its own error, which is exactly the honest outcome.
  pytest: "--cov",
  cargo: undefined,
  go: "-cover",
  dotnet: '--collect:"XPlat Code Coverage"',
};

function coverageArgs(framework: Framework, request: RunRequest, notes: string[]): string[] {
  if (!request.coverage) return [];
  const flag = COVERAGE_FLAG[framework];
  if (flag === undefined) {
    notes.push(`Coverage was requested but ${framework} has no built-in coverage flag, so it was not collected.`);
    return [];
  }
  notes.push(`Coverage requested: ran with \`${flag}\`. This tool does not parse coverage; read the runner's own report.`);
  // The dotnet collector name contains a space and is passed as one argv entry;
  // the quotes above are for the note text only.
  return framework === "dotnet" ? ["--collect:XPlat Code Coverage"] : [flag];
}

function filterArgs(framework: Framework, request: RunRequest): string[] {
  if (request.rerunArgs !== undefined) return request.rerunArgs;
  const filter = request.filter;
  if (filter === undefined) return [];
  switch (framework) {
    case "vitest":
    case "jest":
      return ["-t", filter];
    case "mocha":
      return ["--grep", filter];
    case "pytest":
      return ["-k", filter];
    case "go":
      return ["-run", filter];
    case "dotnet":
      return ["--filter", filter];
    case "cargo":
      return [filter];
  }
}

/** `dotnet test` accepts a single project or solution, not a path list. */
function dotnetTarget(request: RunRequest, notes: string[]): string[] {
  const [first, ...rest] = request.paths;
  if (first === undefined) return [];
  if (rest.length > 0) {
    notes.push(`\`dotnet test\` takes one project or solution: used ${first}, ignored ${rest.join(", ")}.`);
  }
  return [first];
}

function buildRunPlan(framework: Framework, request: RunRequest, tempDir: string): RunPlan {
  const notes: string[] = [];
  const filter = filterArgs(framework, request);
  const coverage = coverageArgs(framework, request, notes);

  switch (framework) {
    case "vitest": {
      const outputFile = path.join(tempDir, "vitest.json");
      return {
        command: "npx",
        args: ["vitest", "run", "--reporter=json", `--outputFile=${outputFile}`, ...coverage, ...filter, ...request.paths],
        env: {},
        reporter: "vitest JSON",
        outputFile,
        notes,
        parse: parseVitestJson,
      };
    }
    case "jest": {
      const outputFile = path.join(tempDir, "jest.json");
      return {
        command: "npx",
        args: ["jest", "--json", `--outputFile=${outputFile}`, ...coverage, ...filter, ...request.paths],
        env: {},
        reporter: "jest JSON",
        outputFile,
        notes,
        parse: parseJestJson,
      };
    }
    case "mocha":
      return {
        command: "npx",
        args: ["mocha", "--reporter", "json", ...filter, ...request.paths],
        env: {},
        reporter: "mocha JSON",
        notes,
        parse: parseMochaJson,
      };
    case "pytest": {
      const outputFile = path.join(tempDir, "pytest.xml");
      return {
        command: "python",
        // `--junit-xml` is built into pytest; no plugin is required for it.
        args: ["-m", "pytest", "-q", `--junit-xml=${outputFile}`, ...coverage, ...filter, ...request.paths],
        env: {},
        reporter: "pytest JUnit XML",
        outputFile,
        notes,
        parse: parsePytestJunitXml,
      };
    }
    case "go": {
      const targets = request.paths.length > 0 ? request.paths : ["./..."];
      return {
        command: "go",
        args: ["test", "-json", ...coverage, ...filter, ...targets],
        env: {},
        reporter: "go test -json",
        notes,
        parse: parseGoTestJson,
      };
    }
    case "cargo": {
      if (request.paths.length > 0) {
        notes.push("cargo selects tests by name, not by path, so `paths` was ignored — use `filter` instead.");
      }
      if (findOnPath("cargo-nextest") !== undefined) {
        return {
          command: "cargo",
          args: ["nextest", "run", "--message-format", "libtest-json", ...filter],
          // nextest gates this message format behind an opt-in env var.
          env: { NEXTEST_EXPERIMENTAL_LIBTEST_JSON: "1" },
          reporter: "nextest libtest-json",
          notes,
          parse: parseNextestLibtestJson,
        };
      }
      return {
        command: "cargo",
        args: ["test", ...filter],
        env: {},
        reporter: "libtest text",
        notes,
        parse: parseCargoTestText,
      };
    }
    case "dotnet": {
      const outputFile = path.join(tempDir, "results.trx");
      // `LogFileName` is resolved inside the results directory, so an absolute
      // path there is not portable; point the results directory at the temp dir.
      return {
        command: "dotnet",
        args: [
          "test",
          ...dotnetTarget(request, notes),
          "--logger",
          "trx;LogFileName=results.trx",
          "--results-directory",
          tempDir,
          ...coverage,
          ...filter,
        ],
        env: {},
        reporter: "dotnet TRX",
        outputFile,
        notes,
        parse: parseTrxXml,
      };
    }
  }
}

interface ListPlan {
  command: string;
  args: string[];
  notes: string[];
  /** Test names from the collector's stdout; `undefined` means unreadable. */
  collect(stdout: string): string[] | undefined;
}

/** Keep the collector's own lines that name a test, dropping its chatter. */
function pickLines(stdout: string, select: (line: string) => string | undefined): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const kept = select(line);
    if (kept !== undefined && kept.length > 0) names.push(kept);
  }
  return names;
}

function buildListPlan(framework: Framework, paths: readonly string[]): ListPlan {
  const notes: string[] = [];
  switch (framework) {
    case "vitest":
      return {
        command: "npx",
        args: ["vitest", "list", ...paths],
        notes,
        collect: (stdout) => pickLines(stdout, (line) => line.trim()),
      };
    case "jest":
      return {
        command: "npx",
        args: ["jest", "--listTests", ...paths],
        notes,
        collect: (stdout) => pickLines(stdout, (line) => line.trim()),
      };
    case "mocha":
      // mocha has no collect-only reporter; `--dry-run` (mocha 9+) is the
      // closest honest equivalent, and it still reports through the JSON
      // reporter rather than line by line.
      return {
        command: "npx",
        args: ["mocha", "--dry-run", "--reporter", "json", ...paths],
        notes,
        collect: (stdout) => {
          const root = parseJsonLoose(stdout);
          if (!isRecord(root) || !Array.isArray(root.tests)) return undefined;
          const names: string[] = [];
          for (const test of root.tests) {
            if (!isRecord(test)) continue;
            const name = stringField(test, "fullTitle") ?? stringField(test, "title");
            if (name === undefined) continue;
            const file = stringField(test, "file");
            names.push(file === undefined ? name : `${file} > ${name}`);
          }
          return names;
        },
      };
    case "pytest":
      return {
        command: "python",
        args: ["-m", "pytest", "--collect-only", "-q", ...paths],
        notes,
        // `-q` prints one node id per line, then a `N tests collected` summary.
        collect: (stdout) => pickLines(stdout, (line) => (line.includes("::") ? line.trim() : undefined)),
      };
    case "cargo": {
      if (paths.length > 0) notes.push("cargo lists tests by name, not by path, so `paths` was ignored.");
      return {
        command: "cargo",
        args: ["test", "--", "--list"],
        notes,
        collect: (stdout) =>
          pickLines(stdout, (line) => /^(\S.*?):\s+(?:test|benchmark)$/.exec(line.trim())?.[1]),
      };
    }
    case "go":
      return {
        command: "go",
        args: ["test", "-list", ".*", ...(paths.length > 0 ? paths : ["./..."])],
        notes,
        // The stream mixes test names with per-package `ok  pkg  0.1s` lines.
        collect: (stdout) =>
          pickLines(stdout, (line) => (/^(?:Test|Example|Benchmark|Fuzz)\w*$/.test(line.trim()) ? line.trim() : undefined)),
      };
    case "dotnet":
      return {
        command: "dotnet",
        args: ["test", ...paths.slice(0, 1), "--list-tests"],
        notes,
        // vstest prints a banner, then one indented name per test.
        collect: (stdout) =>
          pickLines(stdout, (line) =>
            /^\s{2,}\S/.test(line) && !line.includes("following Tests are available") ? line.trim() : undefined,
          ),
      };
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function displayPath(file: string, cwd: string): string {
  if (!path.isAbsolute(file)) return file.replace(/\\/g, "/");
  const relative = path.relative(cwd, file);
  const inside = relative.length > 0 && !relative.startsWith("..");
  return (inside ? relative : relPath(file)).replace(/\\/g, "/");
}

function capLine(text: string, max = MAX_FAILURE_LINE_CHARS): string {
  const flat = text.replace(/\s+$/, "");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function failureLines(result: TestRunResult, cwd: string): string[] {
  const lines: string[] = [];
  for (const failure of result.failures.slice(0, MAX_LISTED_FAILURES)) {
    const location =
      failure.file === undefined
        ? undefined
        : `${displayPath(failure.file, cwd)}${failure.line === undefined ? "" : `:${failure.line}`}`;
    lines.push(location === undefined ? `FAIL ${failure.name}` : `FAIL ${location}  ${failure.name}`);
    const detail = failure.message
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(0, MAX_FAILURE_MESSAGE_LINES);
    for (const line of detail) lines.push(`  ${capLine(line.trim())}`);
  }
  const hidden = result.failures.length - Math.min(result.failures.length, MAX_LISTED_FAILURES);
  if (hidden > 0) lines.push(`… ${hidden} further ${hidden === 1 ? "failure" : "failures"} not detailed`);
  return lines;
}

interface ReportContext {
  notes: readonly string[];
  droppedChars: number;
  wallMs: number;
  rerun: boolean;
  timedOut: boolean;
  timeoutSeconds: number;
}

function formatDuration(ms: number): string {
  return `${(ms / 1_000).toFixed(1)}s`;
}

function formatParsedRun(result: TestRunResult, cwd: string, report: ReportContext): string {
  const segments = [`${result.passed} passed`];
  if (result.failed > 0) segments.push(`${result.failed} failed`);
  if (result.skipped > 0) segments.push(`${result.skipped} skipped`);
  const duration = formatDuration(result.durationMs ?? report.wallMs);

  const head: string[] = [];
  if (report.timedOut) {
    head.push(
      `${result.framework}: timed out after ${report.timeoutSeconds}s and the process tree was killed — the counts below are partial.`,
    );
  }
  let verdict = `${result.framework}: ${segments.join(", ")} in ${duration}`;
  if (result.failed === 0 && !report.timedOut) verdict += result.passed === 0 ? " — no tests ran." : " — all green.";
  head.push(verdict);
  if (report.rerun) head.push("(re-ran only the previous run's failures)");

  const tail: string[] = [];
  if (result.failed > 0) {
    tail.push("", `${plural(result.failed, "failure")}. Re-run just these with rerun:"failed".`);
  }
  if (report.droppedChars > 0) {
    tail.push(
      "",
      `Note: ${report.droppedChars} characters of runner output exceeded the 1 MiB retention cap and were dropped, so these counts may be incomplete.`,
    );
  }
  for (const note of report.notes) tail.push("", note);

  const body = failureLines(result, cwd);
  if (body.length === 0) return truncate([...head, ...tail]);

  const framing = head.join("\n").length + tail.join("\n").length + FRAMING_RESERVE_CHARS;
  return [...head, "", truncate(body, { limit: Math.max(200, MAX_RESULT_CHARS - framing) }), ...tail].join("\n");
}

function formatUnparsedRun(
  framework: Framework,
  reporter: string,
  outcome: RunOutcome,
  payload: string | undefined,
  report: ReportContext,
): string {
  const head: string[] = [];
  if (outcome.spawnError !== undefined) {
    head.push(`${framework}: the runner could not be started — ${outcome.spawnError}`);
    head.push(`Command: ${outcome.commandLine}`);
    head.push("No tests ran, so there are no results. Check that the runner is installed and on PATH.");
    return truncate(head);
  }
  if (report.timedOut) {
    head.push(`${framework}: timed out after ${report.timeoutSeconds}s; the process tree was killed.`);
    head.push("The run never finished, so it neither passed nor failed. Partial output follows.");
  } else {
    head.push(
      `${framework}: ran to completion (exit code ${outcome.exitCode ?? "none"}${outcome.signal === null ? "" : `, signal ${outcome.signal}`}) in ${formatDuration(outcome.durationMs)}, but its ${reporter} output could not be parsed.`,
    );
    head.push(
      payload === undefined
        ? "The reporter wrote no output file, so there are no counts — this is an unparsed result, not a passing one."
        : "Counts and failures are therefore unavailable: what follows is raw output, not a parsed result.",
    );
  }
  head.push(`Command: ${outcome.commandLine}`);

  const tail: string[] = [];
  for (const note of report.notes) tail.push("", note);

  const framing = head.join("\n").length + tail.join("\n").length + FRAMING_RESERVE_CHARS;
  const budget = Math.max(400, MAX_RESULT_CHARS - framing);
  const raw = [payload ?? "", outcome.stdout, outcome.stderr].find((text) => text.trim().length > 0);
  const body =
    raw === undefined
      ? ["The runner produced no output at all."]
      : ["--- output (tail) ---", clip(raw.slice(Math.max(0, raw.length - budget)), budget)];

  return [...head, "", ...body, ...tail].join("\n");
}

// ---------------------------------------------------------------------------
// Argument coercion
// ---------------------------------------------------------------------------

function optStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`\`${key}\` must be an array of strings.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`\`${key}[${index}]\` must be a non-empty string.`);
    }
    return entry;
  });
}

function optFramework(args: Record<string, unknown>): Framework | undefined {
  const value = optString(args, "framework");
  if (value === undefined) return undefined;
  const match = FRAMEWORKS.find((framework) => framework === value.toLowerCase());
  if (match === undefined) {
    throw new Error(`\`framework\` must be one of ${FRAMEWORKS.join(", ")} (got "${value}").`);
  }
  return match;
}

function optRerun(args: Record<string, unknown>): "failed" | undefined {
  const value = args.rerun;
  if (value === undefined || value === null) return undefined;
  if (value !== "failed") throw new Error('`rerun` only accepts "failed".');
  return "failed";
}

/** Resolve the framework to drive, or explain why we cannot pick one. */
async function chooseFramework(
  args: Record<string, unknown>,
  cwd: string,
): Promise<{ framework: Framework } | { unavailable: string }> {
  const override = optFramework(args);
  if (override !== undefined) return { framework: override };

  const detected = await detectFrameworks(cwd);
  const first = detected[0];
  if (first === undefined) {
    return {
      unavailable: truncate([
        `No test framework detected in ${cwd}.`,
        "Looked for: package.json declaring vitest/jest/mocha; pytest.ini, tox.ini, [tool.pytest] in pyproject.toml or [tool:pytest] in setup.cfg; Cargo.toml; go.mod; a .csproj/.fsproj/.sln.",
        'Pass `framework` explicitly if the project uses one of those anyway, or fall back to run_task for a project-defined test task.',
      ]),
    };
  }
  return { framework: first };
}

/**
 * Argv that replays exactly the previously failed tests, in each runner's own
 * selection language.
 */
function rerunSelection(framework: Framework, failures: readonly TestFailure[]): string[] {
  const names = [...new Set(failures.map((failure) => failure.name))];
  switch (framework) {
    case "vitest":
    case "jest":
      return ["-t", names.map(escapeRegExp).join("|")];
    case "mocha":
      return ["--grep", names.map(escapeRegExp).join("|")];
    case "pytest":
      // pytest node ids are `file.py::Class::test_name`; `-k` matches on the
      // trailing name only.
      return ["-k", names.map((name) => name.split("::").pop() ?? name).join(" or ")];
    case "cargo":
      return names;
    case "go": {
      // `-run` matches each `/`-separated element separately, so anchoring the
      // top-level test is the closest honest replay of a failed subtest.
      const tops = [...new Set(names.map((name) => (name.split(".").pop() ?? name).split("/")[0] ?? name))];
      return ["-run", `^(${tops.map(escapeRegExp).join("|")})$`];
    }
    case "dotnet":
      return ["--filter", names.map((name) => `FullyQualifiedName~${name}`).join("|")];
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const testTools: IdeTool[] = [
  {
    name: "list_tests",
    description:
      "List the tests this project defines, using the detected framework's own collect-only mode " +
      "(vitest/jest/mocha/pytest/cargo/go/dotnet). Nothing is executed. Use it to find exact test names to pass to run_tests.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files or directories to restrict collection to. Defaults to the whole project.",
        },
        framework: {
          type: "string",
          enum: [...FRAMEWORKS],
          description: "Override framework detection.",
        },
        limit: {
          type: "number",
          description: `Maximum test names to return. Default ${DEFAULT_LIST_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    async invoke(args, ctx): Promise<string> {
      const paths = optStringArray(args, "paths");
      const limit = optInt(args, "limit", DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
      const chosen = await chooseFramework(args, ctx.cwd);
      if ("unavailable" in chosen) return chosen.unavailable;
      const { framework } = chosen;

      const plan = buildListPlan(framework, paths);
      const outcome = await execute(plan.command, plan.args, {}, ctx.cwd, LIST_TIMEOUT_SECONDS, ctx);

      if (outcome.spawnError !== undefined) {
        return truncate([
          `${framework}: the collector could not be started — ${outcome.spawnError}`,
          `Command: ${outcome.commandLine}`,
          "No test list is available. Check that the runner is installed and on PATH.",
        ]);
      }

      const names = plan.collect(outcome.stdout);

      if (names === undefined || names.length === 0) {
        const head = [
          `${framework}: no tests were collected (exit code ${outcome.exitCode ?? "none"}).`,
          outcome.exitCode === 0
            ? "The collector succeeded and reported nothing, so this project appears to define no tests for that selection."
            : "The collector failed, so this is not evidence that the project has no tests.",
          `Command: ${outcome.commandLine}`,
        ];
        const raw = [outcome.stderr, outcome.stdout].find((text) => text.trim().length > 0);
        if (raw === undefined) return truncate(head);
        const framing = head.join("\n").length + FRAMING_RESERVE_CHARS;
        const budget = Math.max(400, MAX_RESULT_CHARS - framing);
        return [...head, "", "--- output (tail) ---", clip(raw.slice(Math.max(0, raw.length - budget)), budget)].join("\n");
      }

      const shown = names.slice(0, limit);
      const head = `${framework}: ${plural(names.length, "test")}${names.length > shown.length ? ` (showing ${shown.length})` : ""}`;
      ctx.output.debug(`[ide] list_tests: ${names.length} ${framework} test(s) for ${ctx.cwd}`);
      const lines = shown.map((name) => (path.isAbsolute(name) ? displayPath(name, ctx.cwd) : name));
      const notes = plan.notes.flatMap((note) => ["", note]);
      return truncate([head, "", ...lines, ...notes], { omitted: names.length - shown.length });
    },
  },
  {
    name: "run_tests",
    description:
      "Run this project's tests through the detected framework's machine-readable reporter and return structured results: " +
      "pass/fail/skip counts plus each failure's test name, file, line and message. " +
      "Prefer this over run_task for tests — run_task returns terminal text, this returns structure. " +
      'After a failing run, rerun:"failed" replays exactly the tests that failed.',
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Test files or directories to run. Defaults to the whole suite. Ignored by cargo, which selects by name.",
        },
        filter: {
          type: "string",
          description:
            "Test-name pattern, mapped to the runner's own flag (vitest/jest -t, mocha --grep, pytest -k, cargo positional, go -run, dotnet --filter).",
        },
        framework: {
          type: "string",
          enum: [...FRAMEWORKS],
          description: "Override framework detection.",
        },
        rerun: {
          type: "string",
          enum: ["failed"],
          description: 'Re-run only the tests that failed in this workspace\'s previous run_tests call.',
        },
        timeout: {
          type: "number",
          description: `Seconds before the run is terminated. Default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}.`,
        },
        coverage: {
          type: "boolean",
          description: "Collect coverage where the runner supports it natively (vitest, jest, pytest, go, dotnet).",
        },
      },
      additionalProperties: false,
    },
    async invoke(args, ctx): Promise<string> {
      const paths = optStringArray(args, "paths");
      const filter = optString(args, "filter");
      const rerun = optRerun(args);
      const timeoutSeconds = optInt(args, "timeout", DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS);
      const coverage = optBool(args, "coverage", false);

      const chosen = await chooseFramework(args, ctx.cwd);
      if ("unavailable" in chosen) return chosen.unavailable;
      const { framework } = chosen;

      const request: RunRequest = { paths, filter, coverage };
      if (rerun === "failed") {
        const previous = lastRuns.get(ctx.cwd);
        if (previous === undefined) {
          return truncate([
            'rerun:"failed" needs a previous parsed run for this workspace, and there is none.',
            "Nothing was run. Call run_tests without `rerun` first.",
          ]);
        }
        if (previous.framework !== framework) {
          return truncate([
            `The previous run for this workspace used ${previous.framework}, but this call resolves to ${framework}, so its failure names cannot be replayed.`,
            "Nothing was run. Re-run the suite for this framework first, or pass the matching `framework`.",
          ]);
        }
        if (previous.failures.length === 0) {
          return truncate([
            previous.failed === 0
              ? `The previous ${previous.framework} run had no failures, so there is nothing to re-run.`
              : `The previous ${previous.framework} run reported ${plural(previous.failed, "failure")} but named none of them, so there is nothing to select on.`,
            "Nothing was run. Call run_tests without `rerun` to run the suite again.",
          ]);
        }
        request.rerunArgs = rerunSelection(framework, previous.failures);
        if (filter !== undefined) {
          // Two selections cannot both be honoured; the replay is the explicit ask.
          request.filter = undefined;
        }
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-tests-"));
      try {
        const plan = buildRunPlan(framework, request, tempDir);
        if (rerun === "failed" && filter !== undefined) {
          plan.notes.push('`filter` was ignored because rerun:"failed" already selects the tests to run.');
        }

        const outcome = await execute(plan.command, plan.args, plan.env, ctx.cwd, timeoutSeconds, ctx);
        const payload =
          plan.outputFile === undefined ? outcome.stdout : await readTextIfPresent(plan.outputFile);
        const parsed = payload === undefined ? undefined : plan.parse(payload);
        const report: ReportContext = {
          notes: plan.notes,
          droppedChars: outcome.droppedChars,
          wallMs: outcome.durationMs,
          rerun: rerun === "failed",
          timedOut: outcome.timedOut,
          timeoutSeconds,
        };

        if (parsed === undefined) {
          ctx.output.warn(
            `[ide] run_tests: ${framework} ${plan.reporter} output unparsed (exit ${outcome.exitCode ?? "none"})`,
          );
          return formatUnparsedRun(framework, plan.reporter, outcome, payload, report);
        }

        const result: TestRunResult = {
          ...parsed,
          exitCode: outcome.exitCode,
          stderrTail: outcome.stderr.length > 0 ? clip(outcome.stderr.slice(-4_000), 4_000) : undefined,
        };
        // Only a parsed run can be replayed; a guess would be worse than none.
        lastRuns.set(ctx.cwd, result);
        ctx.output.info(
          `[ide] run_tests: ${framework} ${result.passed}/${result.failed}/${result.skipped} (pass/fail/skip) in ${formatDuration(result.durationMs ?? outcome.durationMs)}`,
        );
        return formatParsedRun(result, ctx.cwd, report);
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch((error: unknown) => {
          ctx.output.debug(`[ide] run_tests: could not remove ${tempDir}: ${describeError(error)}`);
        });
      }
    },
  },
];
