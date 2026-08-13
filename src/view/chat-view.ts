import * as vscode from "vscode";
import type { ChatController } from "../chat/controller";
import type { ChatSurface, SessionManager } from "../session/session-manager";
import type { WebviewMessage } from "../shared/bridge";

const WEBVIEW_DIR = ["dist", "webview"];

function nonce(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let value = "";
	for (let index = 0; index < 32; index++) value += alphabet[Math.floor(Math.random() * alphabet.length)];
	return value;
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const asset = (...segments: string[]) =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIR, ...segments));
	const script = asset("assets", "index.js");
	const style = asset("assets", "index.css");
	const token = nonce();

	// `strict-dynamic` is required because the entry chunk pulls lazily-loaded
	// chunks (mermaid, highlight grammars) in through dynamic import.
	const csp = [
		"default-src 'none'",
		`img-src ${webview.cspSource} data: https:`,
		`font-src ${webview.cspSource} data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${token}' 'strict-dynamic'`,
		"connect-src 'none'",
	].join("; ");

	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<link rel="stylesheet" href="${style}" />
		<title>OMP</title>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" nonce="${token}" src="${script}"></script>
	</body>
</html>`;
}

/** Wire a webview to a chat surface: snapshot on attach, events after. */
function bind(webview: vscode.Webview, surface: ChatSurface, extensionUri: vscode.Uri): vscode.Disposable {
	webview.options = {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIR)],
	};
	webview.html = renderHtml(webview, extensionUri);

	const disposables = [
		surface.subscribe(message => {
			void webview.postMessage(message);
		}),
		webview.onDidReceiveMessage((message: WebviewMessage) => {
			void surface.handleWebviewMessage(message);
		}),
	];
	return new vscode.Disposable(() => {
		for (const disposable of disposables) disposable.dispose();
	});
}

/** The sidebar chat view: always bound to whichever session is active. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "omp.chatView";

	#view: vscode.WebviewView | undefined;
	#binding: vscode.Disposable | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly manager: SessionManager,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.#view = view;
		this.#binding?.dispose();
		this.#binding = bind(view.webview, this.manager.sidebar(), this.extensionUri);
		view.onDidDispose(() => {
			this.#binding?.dispose();
			this.#binding = undefined;
			this.#view = undefined;
		});
	}

	reveal(): void {
		if (this.#view) {
			this.#view.show(true);
			return;
		}
		void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
	}
}

/**
 * The wider editor-tab chat surface. One panel per *session*, each pinned to
 * its own controller, so two sessions — including two in the same project — can
 * be watched side by side. The sidebar shares those controllers through the
 * {@link SessionManager}.
 */
export class ChatPanel {
	static #panels = new Map<string, ChatPanel>();

	static show(extensionUri: vscode.Uri, manager: SessionManager, sessionId: string): void {
		const existing = ChatPanel.#panels.get(sessionId);
		if (existing) {
			existing.#panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		if (!manager.sessionEntry(sessionId)) return;
		const panel = vscode.window.createWebviewPanel("omp.chatPanel", titleFor(manager, sessionId), vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIR)],
		});
		ChatPanel.#panels.set(sessionId, new ChatPanel(panel, extensionUri, manager, sessionId));
	}

	/** Close a session's panel, if it has one open. */
	static close(sessionId: string): void {
		const existing = ChatPanel.#panels.get(sessionId);
		if (existing) existing.#panel.dispose();
	}

	static disposeAll(): void {
		for (const panel of ChatPanel.#panels.values()) panel.#panel.dispose();
		ChatPanel.#panels.clear();
	}

	readonly #disposables: vscode.Disposable[];
	readonly #panel: vscode.WebviewPanel;
	readonly #sessionId: string;

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		manager: SessionManager,
		sessionId: string,
	) {
		this.#panel = panel;
		this.#sessionId = sessionId;
		this.#disposables = [
			bind(panel.webview, manager.surface(sessionId), extensionUri),
			// The agent names sessions as they go; keep the tab in step.
			manager.onDidChangeSessions(() => {
				panel.title = titleFor(manager, sessionId);
			}),
		];
		// Focusing a panel makes its session active in the sidebar too.
		panel.onDidChangeViewState(() => {
			if (panel.visible) manager.setActive(sessionId);
		});
		panel.onDidDispose(() => {
			for (const disposable of this.#disposables) disposable.dispose();
			ChatPanel.#panels.delete(this.#sessionId);
		});
	}
}

/** `project · name` when the agent has named the session, else `project · #n`. */
function titleFor(manager: SessionManager, sessionId: string): string {
	const entry = manager.sessionEntry(sessionId);
	if (!entry) return "OMP";
	return `${entry.projectLabel} · ${entry.name ?? `#${entry.ordinal}`}`;
}
