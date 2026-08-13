import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { HostMessage } from "../../src/shared/bridge";
import { App } from "./App";
import { store } from "./store";
import { post } from "./vscode";
import "./theme.css";

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
	store.apply(event.data);
});

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// Tells the host to send the initial snapshot and start the agent if needed.
post({ type: "ready" });
