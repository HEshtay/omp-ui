import * as vscode from "vscode";

export const OMP_DIFF_SCHEME = "omp-diff";

/**
 * Backs the read-only left/right sides of an edit-tool diff view.
 *
 * Contents are held in memory and keyed by an opaque id so a diff can be opened
 * straight from a tool card without touching the filesystem.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	readonly #contents = new Map<string, string>();
	readonly #onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.#onDidChange.event;
	#next = 0;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.#contents.get(uri.path) ?? "";
	}

	/** Register one side of a diff and return the URI that renders it. */
	store(label: string, content: string): vscode.Uri {
		const key = `/${++this.#next}/${label}`;
		this.#contents.set(key, content);
		return vscode.Uri.from({ scheme: OMP_DIFF_SCHEME, path: key });
	}

	dispose(): void {
		this.#contents.clear();
		this.#onDidChange.dispose();
	}
}
