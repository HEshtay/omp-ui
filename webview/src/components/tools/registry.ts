import { taskRenderer, todoRenderer } from "./agentic";
import { editRenderer, readRenderer, writeRenderer } from "./fs";
import { genericRenderer } from "./generic";
import { globRenderer, grepRenderer } from "./search";
import { bashRenderer } from "./shell";
import type { ToolRenderer } from "./types";
import { browserRenderer, lspRenderer, webSearchRenderer } from "./web";

/**
 * Tool name → card renderer, mirroring omp's own `toolRenderers` registry.
 * `apply_patch` is `edit` behind a different wire name; `ast_grep` shares
 * grep's result shape.
 */
export const toolRenderers: Record<string, ToolRenderer> = {
	apply_patch: editRenderer,
	ast_grep: grepRenderer,
	bash: bashRenderer,
	browser: browserRenderer,
	edit: editRenderer,
	glob: globRenderer,
	grep: grepRenderer,
	lsp: lspRenderer,
	read: readRenderer,
	task: taskRenderer,
	todo: todoRenderer,
	web_search: webSearchRenderer,
	write: writeRenderer,
};

export function rendererFor(name: string): ToolRenderer {
	return toolRenderers[name] ?? genericRenderer;
}

export { genericRenderer };
