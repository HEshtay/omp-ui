/**
 * Parser-level smoke test for the structured test-running tools.
 *
 * Feeds inline fixture payloads — one per reporter format the `run_tests` tool
 * knows how to read — into the parsers from `src/ide/tools/tests.ts` and asserts
 * the normalized counts and the first failure's identity. Deliberately malformed
 * payloads must come back as `undefined`, never as a plausible all-green result:
 * that distinction is the whole point of the honesty rule in that module.
 *
 * Nothing is spawned and no test runner has to be installed, so this proves the
 * *parsing*, not any particular runner's behaviour. `detectFrameworks` is
 * exercised against a real temporary directory, since it only touches the disk.
 *
 *   npm run smoke:tests
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	detectFrameworks,
	parseCargoTestText,
	parseGoTestJson,
	parseJestJson,
	parseMochaJson,
	parseNextestLibtestJson,
	parsePytestJunitXml,
	parseTrxXml,
	parseVitestJson,
	type TestParser,
} from "../src/ide/tools/tests";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "ok  -" : "FAIL -"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
}

interface Expectation {
	passed: number;
	failed: number;
	skipped: number;
	framework?: string;
	durationMs?: number;
	/** Expected number of parsed failure entries, when it is worth pinning. */
	failureCount?: number;
	first?: { name: string; file?: string; line?: number; message?: string };
}

function checkParse(label: string, parser: TestParser, payload: string, expect: Expectation): void {
	const result = parser(payload);
	if (result === undefined) {
		check(label, false, "parser returned undefined for a well-formed payload");
		return;
	}

	const counts = `${result.passed}/${result.failed}/${result.skipped}`;
	const wanted = `${expect.passed}/${expect.failed}/${expect.skipped}`;
	check(`${label}: counts passed/failed/skipped`, counts === wanted, `got ${counts}, want ${wanted}`);

	if (expect.framework !== undefined) {
		check(`${label}: framework`, result.framework === expect.framework, `got ${result.framework}`);
	}
	if (expect.durationMs !== undefined) {
		check(`${label}: durationMs`, result.durationMs === expect.durationMs, `got ${String(result.durationMs)}`);
	}
	if (expect.failureCount !== undefined) {
		check(
			`${label}: failure entries`,
			result.failures.length === expect.failureCount,
			`got ${result.failures.length}, want ${expect.failureCount}`,
		);
	}

	const expected = expect.first;
	if (expected === undefined) return;
	const actual = result.failures[0];
	if (actual === undefined) {
		check(`${label}: first failure`, false, "no failures were parsed");
		return;
	}
	check(`${label}: first failure name`, actual.name === expected.name, `got ${JSON.stringify(actual.name)}`);
	if (expected.file !== undefined) {
		check(`${label}: first failure file`, actual.file === expected.file, `got ${JSON.stringify(actual.file)}`);
	}
	if (expected.line !== undefined) {
		check(`${label}: first failure line`, actual.line === expected.line, `got ${String(actual.line)}`);
	}
	if (expected.message !== undefined) {
		check(
			`${label}: first failure message`,
			actual.message.includes(expected.message),
			`got ${JSON.stringify(actual.message.slice(0, 120))}`,
		);
	}
}

/** A payload the parser must refuse outright rather than reinterpret. */
function checkUnparsed(label: string, parser: TestParser, payload: string): void {
	const result = parser(payload);
	if (result === undefined) {
		check(label, true);
		return;
	}
	check(label, false, `parsed as ${result.passed}/${result.failed}/${result.skipped} instead of returning undefined`);
}

// --- fixtures -------------------------------------------------------------

const VITEST_JSON = JSON.stringify({
	numTotalTests: 6,
	numPassedTests: 3,
	numFailedTests: 2,
	numPendingTests: 1,
	numTodoTests: 0,
	startTime: 1_000,
	success: false,
	testResults: [
		{
			name: "/repo/src/add.test.ts",
			status: "failed",
			startTime: 1_000,
			endTime: 13_400,
			assertionResults: [
				{ fullName: "add() adds", title: "adds", status: "passed" },
				{
					fullName: "add() handles negatives",
					title: "handles negatives",
					status: "failed",
					location: { line: 42, column: 3 },
					failureMessages: ["AssertionError: expected 3 to be -1\n    at /repo/src/add.test.ts:42:18"],
				},
				{ fullName: "add() rounds", title: "rounds", status: "pending" },
			],
		},
		{
			name: "/repo/src/parse.test.ts",
			status: "failed",
			startTime: 1_000,
			endTime: 12_000,
			assertionResults: [
				{ fullName: "parse() accepts input", status: "passed" },
				{ fullName: "parse() trims input", status: "passed" },
				{
					fullName: "parse() rejects empty input",
					status: "failed",
					failureMessages: ["AssertionError: expected [Function] to throw\n    at parse.test.ts:9:5"],
				},
			],
		},
	],
});

const JEST_JSON = JSON.stringify({
	numTotalTests: 4,
	numPassedTests: 1,
	numFailedTests: 1,
	numPendingTests: 1,
	numTodoTests: 1,
	startTime: 0,
	testResults: [
		{
			name: "/repo/tests/util.test.js",
			status: "failed",
			assertionResults: [
				{ fullName: "util slugifies", status: "passed" },
				{ fullName: "util skips blanks", status: "pending" },
				{ fullName: "util marks todo", status: "todo" },
				{
					fullName: "util rejects nulls",
					status: "failed",
					failureMessages: ["TypeError: Cannot read properties of null\n    at Object.<anonymous> (/repo/tests/util.test.js:17:11)"],
				},
			],
		},
	],
});

/** A suite that never ran reports only a file-level message. */
const JEST_SUITE_ERROR_JSON = JSON.stringify({
	numTotalTests: 1,
	numPassedTests: 0,
	numFailedTests: 1,
	numPendingTests: 0,
	startTime: 0,
	testResults: [
		{
			name: "/repo/src/broken.test.ts",
			status: "failed",
			failureMessage: "Cannot find module './missing'\n    at /repo/src/broken.test.ts:3:1",
			assertionResults: [],
		},
	],
});

const MOCHA_JSON = JSON.stringify({
	stats: { suites: 2, tests: 4, passes: 2, pending: 1, failures: 1, duration: 1_234 },
	tests: [],
	passes: [],
	pending: [],
	failures: [
		{
			title: "rejects empty input",
			fullTitle: "parse() rejects empty input",
			file: "/repo/test/parse.spec.js",
			err: {
				message: "expected [Function] to throw",
				stack: "AssertionError: expected [Function] to throw\n    at Context.<anonymous> (test/parse.spec.js:9:23)",
			},
		},
	],
});

// The raw `>` inside the `message` attribute is legal XML and pytest does emit
// it, so the scanner must not treat it as the end of the tag.
const PYTEST_JUNIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="pytest" errors="0" failures="1" skipped="1" tests="4" time="2.501">
		<testcase classname="tests.test_math" name="test_add" file="tests/test_math.py" line="3" time="0.001" />
		<testcase classname="tests.test_math" name="test_sub" file="tests/test_math.py" line="7" time="0.500" />
		<testcase classname="tests.test_math" name="test_neg" file="tests/test_math.py" line="41" time="2.000"><failure message="assert 3 > -1">tests/test_math.py:42: AssertionError</failure></testcase>
		<testcase classname="tests.test_math" name="test_todo" file="tests/test_math.py" line="50" time="0.000"><skipped type="pytest.skip" message="not ready" /></testcase>
	</testsuite>
</testsuites>
`;

const TRX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="e8f1" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
	<Results>
		<UnitTestResult testName="Math.Tests.AddTests.Adds" outcome="Passed" duration="00:00:00.0120000" />
		<UnitTestResult testName="Math.Tests.AddTests.HandlesNegatives" outcome="Failed" duration="00:00:00.0340000">
			<Output>
				<ErrorInfo>
					<Message>Assert.Equal() Failure: Values differ</Message>
					<StackTrace>   at Math.Tests.AddTests.HandlesNegatives() in C:\\repo\\tests\\AddTests.cs:line 42</StackTrace>
				</ErrorInfo>
			</Output>
		</UnitTestResult>
		<UnitTestResult testName="Math.Tests.AddTests.Pending" outcome="NotExecuted" duration="00:00:00.0000000" />
	</Results>
	<ResultSummary outcome="Failed">
		<Counters total="3" executed="2" passed="1" failed="1" error="0" timeout="0" aborted="0" inconclusive="0" notExecuted="1" />
	</ResultSummary>
</TestRun>
`;

const GO_NDJSON = [
	{ Action: "run", Package: "example.com/m", Test: "TestAdd" },
	{ Action: "output", Package: "example.com/m", Test: "TestAdd", Output: "=== RUN   TestAdd\n" },
	{ Action: "pass", Package: "example.com/m", Test: "TestAdd", Elapsed: 0.01 },
	{ Action: "run", Package: "example.com/m", Test: "TestNeg" },
	{ Action: "output", Package: "example.com/m", Test: "TestNeg", Output: "=== RUN   TestNeg\n" },
	{ Action: "output", Package: "example.com/m", Test: "TestNeg", Output: "    add_test.go:42: add(1, -2) = 3, want -1\n" },
	{ Action: "fail", Package: "example.com/m", Test: "TestNeg", Elapsed: 0.02 },
	{ Action: "run", Package: "example.com/m", Test: "TestSkip" },
	{ Action: "skip", Package: "example.com/m", Test: "TestSkip", Elapsed: 0 },
	{ Action: "fail", Package: "example.com/m", Elapsed: 0.3 },
]
	.map(event => JSON.stringify(event))
	.join("\n");

/** A parent test and its subtests: the parent must not be counted twice. */
const GO_SUBTEST_NDJSON = [
	{ Action: "run", Package: "example.com/m", Test: "TestGroup" },
	{ Action: "run", Package: "example.com/m", Test: "TestGroup/first" },
	{ Action: "pass", Package: "example.com/m", Test: "TestGroup/first", Elapsed: 0.01 },
	{ Action: "run", Package: "example.com/m", Test: "TestGroup/second" },
	{ Action: "output", Package: "example.com/m", Test: "TestGroup/second", Output: "    group_test.go:17: want 2, got 3\n" },
	{ Action: "fail", Package: "example.com/m", Test: "TestGroup/second", Elapsed: 0.01 },
	{ Action: "fail", Package: "example.com/m", Test: "TestGroup", Elapsed: 0.02 },
	{ Action: "fail", Package: "example.com/m", Elapsed: 0.1 },
]
	.map(event => JSON.stringify(event))
	.join("\n");

const NEXTEST_LIBTEST_JSON = [
	{ type: "suite", event: "started", test_count: 3 },
	{ type: "test", event: "started", name: "tests::adds" },
	{ type: "test", event: "ok", name: "tests::adds", exec_time: 0.005 },
	{ type: "test", event: "started", name: "tests::negatives" },
	{
		type: "test",
		event: "failed",
		name: "tests::negatives",
		stdout: "thread 'tests::negatives' panicked at src/lib.rs:42:9:\nassertion `left == right` failed\n  left: 3\n right: -1\n",
		exec_time: 0.006,
	},
	{ type: "test", event: "ignored", name: "tests::rounds" },
	{ type: "suite", event: "failed", passed: 1, failed: 1, ignored: 1, measured: 0, filtered_out: 0, exec_time: 0.42 },
]
	.map(event => JSON.stringify(event))
	.join("\n");

const CARGO_TEST_TEXT = `
running 4 tests
test tests::adds ... ok
test tests::subs ... ok
test tests::negatives ... FAILED
test tests::rounds ... ignored, needs fixtures

failures:

---- tests::negatives stdout ----
thread 'tests::negatives' panicked at src/lib.rs:42:9:
assertion \`left == right\` failed
  left: 3
 right: -1
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

failures:
    tests::negatives

test result: FAILED. 2 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;

async function checkDetection(): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-tests-detect-"));
	try {
		await writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ devDependencies: { vitest: "^2.0.0" }, scripts: { test: "vitest run" } }),
			"utf8",
		);
		await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "demo"\n', "utf8");
		const detected = await detectFrameworks(root);
		check(
			"detectFrameworks honours precedence (vitest before cargo)",
			detected.join(",") === "vitest,cargo",
			`got ${detected.join(",") || "(none)"}`,
		);

		await writeFile(path.join(root, "package.json"), "{ this is not json", "utf8");
		const tolerant = await detectFrameworks(root);
		check(
			"detectFrameworks tolerates a malformed package.json",
			tolerant.join(",") === "cargo",
			`got ${tolerant.join(",") || "(none)"}`,
		);

		const bare = await mkdtemp(path.join(tmpdir(), "omp-tests-bare-"));
		try {
			const none = await detectFrameworks(bare);
			check("detectFrameworks finds nothing in an empty directory", none.length === 0, `got ${none.join(",")}`);
		} finally {
			await rm(bare, { recursive: true, force: true });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	checkParse("vitest JSON", parseVitestJson, VITEST_JSON, {
		passed: 3,
		failed: 2,
		skipped: 1,
		framework: "vitest",
		durationMs: 12_400,
		failureCount: 2,
		first: {
			name: "add() handles negatives",
			file: "/repo/src/add.test.ts",
			line: 42,
			message: "expected 3 to be -1",
		},
	});

	checkParse("jest JSON", parseJestJson, JEST_JSON, {
		passed: 1,
		failed: 1,
		skipped: 2,
		framework: "jest",
		first: {
			// No `location` field, so the line has to come out of the stack.
			name: "util rejects nulls",
			file: "/repo/tests/util.test.js",
			line: 17,
			message: "Cannot read properties of null",
		},
	});

	checkParse("jest JSON with a suite that failed to load", parseJestJson, JEST_SUITE_ERROR_JSON, {
		passed: 0,
		failed: 1,
		skipped: 0,
		failureCount: 1,
		first: {
			name: "/repo/src/broken.test.ts (suite failed to run)",
			file: "/repo/src/broken.test.ts",
			line: 3,
			message: "Cannot find module",
		},
	});

	checkParse("mocha JSON", parseMochaJson, MOCHA_JSON, {
		passed: 2,
		failed: 1,
		skipped: 1,
		framework: "mocha",
		durationMs: 1_234,
		first: {
			name: "parse() rejects empty input",
			file: "/repo/test/parse.spec.js",
			line: 9,
			message: "expected [Function] to throw",
		},
	});

	checkParse("pytest JUnit XML", parsePytestJunitXml, PYTEST_JUNIT_XML, {
		passed: 2,
		failed: 1,
		skipped: 1,
		framework: "pytest",
		durationMs: 2_501,
		first: {
			name: "tests.test_math::test_neg",
			file: "tests/test_math.py",
			// pytest's `line` attribute is 0-based; the parser makes it 1-based.
			line: 42,
			message: "assert 3 > -1",
		},
	});

	checkParse("dotnet TRX", parseTrxXml, TRX_XML, {
		passed: 1,
		failed: 1,
		skipped: 1,
		framework: "dotnet",
		first: {
			name: "Math.Tests.AddTests.HandlesNegatives",
			file: "C:\\repo\\tests\\AddTests.cs",
			line: 42,
			message: "Assert.Equal() Failure",
		},
	});

	checkParse("go test -json", parseGoTestJson, GO_NDJSON, {
		passed: 1,
		failed: 1,
		skipped: 1,
		framework: "go",
		durationMs: 300,
		failureCount: 1,
		first: {
			name: "example.com/m.TestNeg",
			file: "add_test.go",
			line: 42,
			message: "add(1, -2) = 3, want -1",
		},
	});

	checkParse("go test -json with subtests", parseGoTestJson, GO_SUBTEST_NDJSON, {
		passed: 1,
		failed: 1,
		skipped: 0,
		failureCount: 1,
		first: {
			name: "example.com/m.TestGroup/second",
			file: "group_test.go",
			line: 17,
			message: "want 2, got 3",
		},
	});

	checkParse("nextest libtest-json", parseNextestLibtestJson, NEXTEST_LIBTEST_JSON, {
		passed: 1,
		failed: 1,
		skipped: 1,
		framework: "cargo",
		durationMs: 420,
		first: {
			name: "tests::negatives",
			file: "src/lib.rs",
			line: 42,
			message: "assertion `left == right` failed",
		},
	});

	checkParse("cargo test libtest text", parseCargoTestText, CARGO_TEST_TEXT, {
		passed: 2,
		failed: 1,
		skipped: 1,
		framework: "cargo",
		durationMs: 10,
		failureCount: 1,
		first: {
			name: "tests::negatives",
			file: "src/lib.rs",
			line: 42,
			message: "assertion `left == right` failed",
		},
	});

	// Malformed payloads must be refused. A zero-failure result here would tell
	// the agent its suite is green when nothing of the sort was established.
	checkUnparsed("truncated jest JSON is refused", parseJestJson, '{"numPassedTests": 3, "numFailedTests":');
	checkUnparsed("vitest JSON without counts is refused", parseVitestJson, '{"testResults": []}');
	checkUnparsed("mocha JSON without stats is refused", parseMochaJson, '{"failures": []}');
	checkUnparsed(
		"pytest output that is not XML is refused",
		parsePytestJunitXml,
		"ERROR: file or directory not found: tests/\n",
	);
	checkUnparsed("an empty TRX is refused", parseTrxXml, "<?xml version='1.0'?><TestRun></TestRun>");
	checkUnparsed(
		"a go build failure is refused",
		parseGoTestJson,
		"# example.com/m\n./add.go:7:2: undefined: helper\nFAIL\texample.com/m [build failed]\n",
	);
	checkUnparsed("empty nextest output is refused", parseNextestLibtestJson, "");
	checkUnparsed(
		"a cargo compile failure is refused",
		parseCargoTestText,
		"error[E0433]: failed to resolve: use of undeclared crate or module `helper`\nerror: could not compile `demo`\n",
	);

	await checkDetection();
}

main().then(
	() => {
		console.log(
			failures.length === 0
				? "\nPASS — all test-tool parser checks passed"
				: `\nFAIL — ${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`,
		);
		process.exit(failures.length === 0 ? 0 : 1);
	},
	error => {
		console.error(`\nFAIL — smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
		process.exit(1);
	},
);
