import { diagnosticsTools } from "./diagnostics";
import { editorTools } from "./editor";
import { navigateTools } from "./navigate";
import { scmTools } from "./scm";
import { symbolTools } from "./symbols";
import { taskTools } from "./tasks";
import { terminalTools } from "./terminal";
import { testTools } from "./tests";
import type { IdeTool } from "./types";

/**
 * The single aggregation point for the tools the IDE bridge exposes over MCP.
 * A new tool module exports its own `IdeTool[]`; add one import and one spread.
 */
export const ideTools: IdeTool[] = [
  ...diagnosticsTools,
  ...navigateTools,
  ...symbolTools,
  ...scmTools,
  ...taskTools,
  ...testTools,
  ...editorTools,
  ...terminalTools,
];
