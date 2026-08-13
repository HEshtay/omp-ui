import type * as vscode from "vscode";

export interface IdeToolContext {
  /** Working directory of the session that owns the calling agent process. */
  cwd: string;
  output: vscode.LogOutputChannel;
}

export interface IdeTool {
  /** Bare name; the agent sees `mcp__vscode-ide_<name>`. */
  name: string;
  description: string;
  /** Plain JSON Schema object literal, `{ type: "object", properties: {...} }`. */
  inputSchema: Record<string, unknown>;
  invoke(args: Record<string, unknown>, ctx: IdeToolContext): Promise<string>;
}
