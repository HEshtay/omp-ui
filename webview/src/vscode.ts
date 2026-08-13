import type { WebviewMessage } from "../../src/shared/bridge";

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// `acquireVsCodeApi` may only be called once per webview instance.
export const vscodeApi: VsCodeApi = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
	vscodeApi.postMessage(message);
}
