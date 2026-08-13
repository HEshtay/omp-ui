import { Composer } from "./components/Composer";
import { DialogHost } from "./components/DialogHost";
import { SessionBar } from "./components/SessionBar";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { StatusBar } from "./components/StatusBar";
import { SubagentPanel } from "./components/SubagentPanel";
import { Toasts } from "./components/Toasts";
import { TodoPanel } from "./components/TodoPanel";
import { Transcript } from "./components/Transcript";
import { useUi } from "./store";

export function App() {
	const hydrated = useUi(state => state.hydrated);

	return (
		<div className="app">
			<SessionSwitcher />
			<SessionBar />
			<div className="app-body">
				<main className="app-main">
					{hydrated ? <Transcript /> : <div className="app-loading muted">Connecting to omp…</div>}
					<SubagentPanel />
					<TodoPanel />
					<Composer />
					<StatusBar />
				</main>
			</div>
			<DialogHost />
			<Toasts />
		</div>
	);
}
