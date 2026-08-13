import * as vscode from "vscode";
import type { ChatController } from "./chat/controller";
import { SessionManager } from "./session/session-manager";
import { ChatPanel, ChatViewProvider } from "./view/chat-view";
import { DiffContentProvider, OMP_DIFF_SCHEME } from "./view/diff-provider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OMP", { log: true });
  const diffs = new DiffContentProvider();

  const manager = new SessionManager({ output, diffs });
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
  );
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
