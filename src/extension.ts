import * as vscode from "vscode";
import type { ChatController } from "./chat/controller";
import { IdeBridgeServer } from "./ide/bridge-server";
import {
  IDE_BRIDGE_CWD_ENV,
  IDE_BRIDGE_PIPE_ENV,
  IDE_BRIDGE_SERVER_NAME,
} from "./ide/protocol";
import { registerIdeBridge } from "./ide/registration";
import { startTerminalRecorder } from "./ide/terminal-recorder";
import { ideTools } from "./ide/tools/registry";
import { SessionManager } from "./session/session-manager";
import { ChatPanel, ChatViewProvider } from "./view/chat-view";
import { DiffContentProvider, OMP_DIFF_SCHEME } from "./view/diff-provider";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("OMP", { log: true });
  const diffs = new DiffContentProvider();
  // Recording starts at activation, not on first tool call: the point is to
  // have the command the user already ran when the agent asks about it.
  const terminalRecorder = startTerminalRecorder(output);

  // The shim omp launches on our behalf ships in this build's bundle, so the
  // path moves whenever the extension is upgraded.
  const shimPath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "mcp-shim.js",
  ).fsPath;
  const bridgePipe = await startIdeBridge(context, output, shimPath);

  const manager = new SessionManager({
    output,
    diffs,
    // Every agent child learns where to find this window's bridge and which
    // session's working directory it is serving. `{}` when the bridge is off or
    // failed to start: the shim then advertises no tools and the agent behaves
    // exactly as it does in a plain terminal.
    agentEnv: (cwd): Record<string, string> =>
      bridgePipe
        ? { [IDE_BRIDGE_PIPE_ENV]: bridgePipe, [IDE_BRIDGE_CWD_ENV]: cwd }
        : {},
  });
  // Per-session editor panels, wired here to avoid a circular import.
  manager.panels = {
    open: (id) => ChatPanel.show(context.extensionUri, manager, id),
    close: (id) => ChatPanel.close(id),
  };

  // Every workspace folder is a project with one session ready to go; agents
  // spawn on first focus, so idle projects cost nothing.
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 0) {
    for (const folder of folders) {
      manager.registerProject({
        id: folder.uri.fsPath,
        cwd: folder.uri.fsPath,
        label: folder.name,
      });
      manager.createSession(folder.uri.fsPath);
    }
  } else {
    // Folderless workspace: keep the original process.cwd() fallback so the
    // extension still works with a single implicit project.
    const cwd = process.cwd();
    manager.registerProject({ id: cwd, cwd, label: "workspace" });
    manager.createSession(cwd);
  }

  const provider = new ChatViewProvider(context.extensionUri, manager);

  context.subscriptions.push(
    output,
    diffs,
    manager,
    terminalRecorder,
    vscode.workspace.registerTextDocumentContentProvider(
      OMP_DIFF_SCHEME,
      diffs,
    ),
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("omp")) return;
      manager.notifyAllConfigChanged();
      // Toggling the bridge changes what we do during activation — the socket
      // is created and registered there — so an agent restart is not enough.
      if (event.affectsConfiguration("omp.ideBridge.enabled")) {
        void vscode.window
          .showInformationMessage(
            "OMP IDE bridge setting changed. Reload the window to apply it?",
            "Reload Window",
          )
          .then((choice) => {
            if (choice === "Reload Window")
              void vscode.commands.executeCommand("workbench.action.reloadWindow");
          });
        return;
      }
      // Launch-time flags only take effect on a fresh process.
      const needsRestart = [
        "omp.executablePath",
        "omp.extraArgs",
        "omp.model",
        "omp.thinkingLevel",
        "omp.approvalMode",
      ].some((key) => event.affectsConfiguration(key));
      if (!needsRestart) return;
      void vscode.window
        .showInformationMessage(
          "OMP launch settings changed. Restart the agent to apply them?",
          "Restart",
        )
        .then((choice) => {
          if (choice === "Restart") void manager.active().restart();
        });
    }),

    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.added) {
        manager.registerProject({
          id: folder.uri.fsPath,
          cwd: folder.uri.fsPath,
          label: folder.name,
        });
        manager.createSession(folder.uri.fsPath);
      }
      // A folder that left the workspace is no longer a project of this window.
      for (const folder of event.removed) {
        manager.removeProject(folder.uri.fsPath);
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      if (!vscode.workspace.getConfiguration("omp").get<boolean>("followActiveEditor", false)) return;
      const projectId = manager.findProjectForUri(editor.document.uri);
      if (projectId) manager.focusProject(projectId);
    }),

    vscode.commands.registerCommand("omp.focusChat", () => provider.reveal()),
    vscode.commands.registerCommand("omp.openChat", () =>
      ChatPanel.show(
        context.extensionUri,
        manager,
        manager.activeSessionId ?? "",
      ),
    ),
    vscode.commands.registerCommand("omp.addProjectFolder", () =>
      manager.addFolder(),
    ),
    vscode.commands.registerCommand("omp.removeProjectFolder", () =>
      manager.removeFolder(),
    ),
    vscode.commands.registerCommand("omp.newSession", () =>
      manager.newSession(),
    ),
    vscode.commands.registerCommand("omp.closeSession", () => {
      const id = manager.activeSessionId;
      if (id) manager.closeSession(id);
    }),
    vscode.commands.registerCommand("omp.resetSession", () =>
      manager.active().resetSession(),
    ),
    vscode.commands.registerCommand("omp.revertCheckpoint", () =>
      manager.active().pickAndRevertCheckpoint(),
    ),
    vscode.commands.registerCommand("omp.resumeSession", () =>
      manager.active().pickAndSwitchSession(),
    ),
    vscode.commands.registerCommand("omp.abort", () =>
      manager.active().abort(),
    ),
    vscode.commands.registerCommand("omp.selectModel", () =>
      manager.active().pickModel(),
    ),
    vscode.commands.registerCommand("omp.loginProvider", () =>
      manager.active().loginProvider(),
    ),
    vscode.commands.registerCommand("omp.compact", () =>
      manager.active().compact(),
    ),
    vscode.commands.registerCommand("omp.exportHtml", () =>
      manager.active().exportHtml(),
    ),
    vscode.commands.registerCommand("omp.restartAgent", () =>
      manager.active().restart(),
    ),
    vscode.commands.registerCommand("omp.showLog", () => output.show(true)),
    vscode.commands.registerCommand("omp.addSelectionToChat", () =>
      addSelectionToChat(manager.active(), provider),
    ),
    vscode.commands.registerCommand("omp.registerIdeBridge", async () => {
      try {
        await registerIdeBridge(shimPath, (message) => output.info(message));
        const choice = await vscode.window.showInformationMessage(
          `OMP: re-ran the \`${IDE_BRIDGE_SERVER_NAME}\` MCP registration for ~/.omp/agent/mcp.json. Restart the agent to pick it up.`,
          "Show Log",
        );
        if (choice === "Show Log") output.show(true);
      } catch (error) {
        output.error(`ide bridge registration failed: ${describeError(error)}`);
        void vscode.window.showWarningMessage(
          `OMP: could not register the IDE bridge — ${describeError(error)}`,
        );
      }
    }),
  );
}

/**
 * Bring the IDE bridge up and return the address agents should dial, or
 * `undefined` to carry on without it.
 *
 * Best-effort by design: a pipe we cannot bind or an `mcp.json` we cannot write
 * costs the agent some tools, and must never cost the user their chat UI.
 */
async function startIdeBridge(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
  shimPath: string,
): Promise<string | undefined> {
  const enabled = vscode.workspace
    .getConfiguration("omp")
    .get<boolean>("ideBridge.enabled", true);
  if (!enabled) {
    output.info("ide bridge disabled by omp.ideBridge.enabled");
    return undefined;
  }

  const server = new IdeBridgeServer({ output, tools: ideTools });
  try {
    const pipePath = await server.start();
    output.info(`ide bridge listening on ${pipePath} (${ideTools.length} tools)`);
    await registerIdeBridge(shimPath, (message) => output.info(message));
    context.subscriptions.push(server);
    return pipePath;
  } catch (error) {
    server.dispose();
    output.warn(`ide bridge unavailable: ${describeError(error)}`);
    return undefined;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addSelectionToChat(
  controller: ChatController,
  provider: ChatViewProvider,
): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const selection = editor.selection;
  const text = editor.document.getText(
    selection.isEmpty ? undefined : selection,
  );
  if (!text.trim()) return;

  const relative = vscode.workspace.asRelativePath(editor.document.uri);
  const range = selection.isEmpty
    ? ""
    : `:${selection.start.line + 1}-${selection.end.line + 1}`;
  const language = editor.document.languageId;
  controller.appendToComposer(
    `\`${relative}${range}\`\n\n\`\`\`${language}\n${text}\n\`\`\``,
  );
  provider.reveal();
}

export function deactivate(): void {
  ChatPanel.disposeAll();
}
