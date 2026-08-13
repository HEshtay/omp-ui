/**
 * Minimal stand-in for the `vscode` module.
 *
 * Lets the real `ChatController` run outside the extension host so a recorded
 * session can be produced from live agent traffic. Only the surface the
 * controller touches on the record path is implemented; anything else throws
 * loudly rather than silently returning a plausible value.
 */

const CONFIG: Record<string, unknown> = {
	executablePath: process.env.OMP_PATH ?? "omp",
	extraArgs: ["--no-session"],
	model: "",
	thinkingLevel: "",
	approvalMode: "",
	subagentSubscription: "progress",
	showThinking: true,
	autoScroll: true,
	sendKeybinding: "enter",
};

export class Disposable {
	constructor(private readonly callOnDispose: () => void) {}
	dispose(): void {
		this.callOnDispose();
	}
	static from(...items: Array<{ dispose(): unknown }>): Disposable {
		return new Disposable(() => {
			for (const item of items) item.dispose();
		});
	}
}

export class EventEmitter<T> {
	#listeners = new Set<(value: T) => void>();
	readonly event = (listener: (value: T) => void): Disposable => {
		this.#listeners.add(listener);
		return new Disposable(() => this.#listeners.delete(listener));
	};
	fire(value: T): void {
		for (const listener of this.#listeners) listener(value);
	}
	dispose(): void {
		this.#listeners.clear();
	}
}

export const Uri = {
	file: (path: string) => ({ scheme: "file", fsPath: path, path, toString: () => `file://${path}` }),
	parse: (value: string) => ({ scheme: value.split(":")[0] ?? "", fsPath: value, path: value, toString: () => value }),
	joinPath: (base: { path: string }, ...segments: string[]) => ({
		scheme: "file",
		fsPath: [base.path, ...segments].join("/"),
		path: [base.path, ...segments].join("/"),
		toString: () => [base.path, ...segments].join("/"),
	}),
	from: (parts: { scheme: string; path: string }) => ({ ...parts, fsPath: parts.path, toString: () => parts.path }),
};

export const workspace = {
	workspaceFolders: undefined as unknown,
	getConfiguration: (_section: string) => ({
		get: <T>(key: string, fallback?: T): T | undefined => (CONFIG[key] as T | undefined) ?? fallback,
	}),
	asRelativePath: (value: unknown) => String(value),
	openTextDocument: () => {
		throw new Error("openTextDocument is not available in the harness");
	},
	registerTextDocumentContentProvider: () => new Disposable(() => {}),
	onDidChangeConfiguration: () => new Disposable(() => {}),
	fs: {
		readFile: () => {
			throw new Error("fs.readFile is not available in the harness");
		},
	},
};

export const window = {
	createOutputChannel: () => createLogChannel(),
	showInformationMessage: async () => undefined,
	showWarningMessage: async () => undefined,
	showErrorMessage: async () => undefined,
	showOpenDialog: async () => undefined,
	showQuickPick: async () => undefined,
	showTextDocument: async () => {
		throw new Error("showTextDocument is not available in the harness");
	},
	registerWebviewViewProvider: () => new Disposable(() => {}),
	createWebviewPanel: () => {
		throw new Error("createWebviewPanel is not available in the harness");
	},
	activeTextEditor: undefined,
};

export const env = {
	openExternal: async () => true,
	clipboard: { writeText: async () => undefined },
};

export const commands = {
	registerCommand: () => new Disposable(() => {}),
	executeCommand: async () => undefined,
};

export class Position {
	constructor(
		readonly line: number,
		readonly character: number,
	) {}
}

export class Range {
	constructor(
		readonly start: Position,
		readonly end: Position,
	) {}
}

export class Selection extends Range {}

export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 };

function createLogChannel() {
	const write = (level: string, message: string) => {
		if (process.env.HARNESS_VERBOSE) console.log(`[${level}] ${message}`);
	};
	return {
		info: (message: string) => write("info", message),
		warn: (message: string) => write("warn", message),
		error: (message: string) => write("error", message),
		debug: (message: string) => write("debug", message),
		trace: (message: string) => write("trace", message),
		appendLine: (message: string) => write("info", message),
		show: () => {},
		dispose: () => {},
	};
}

export const harness = { createLogChannel, CONFIG };
