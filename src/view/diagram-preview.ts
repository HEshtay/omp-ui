import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

/** Diagram files are throwaway, so they live in temp rather than the workspace. */
const DIRECTORY = path.join(os.tmpdir(), "omp-diagrams");

/** Built-in media-preview editor: the one that can actually zoom an image. */
const IMAGE_PREVIEW = "imagePreview.previewEditor";

/** Two diagrams opened in the same millisecond must not collide. */
let sequence = 0;

export interface DiagramRequest {
	/** Mermaid source, used when there is no render to show. */
	source: string;
	/** The webview's own render; empty when mermaid rejected the source. */
	svg: string;
	/** Computed backdrop colour of the in-chat diagram. */
	background: string;
}

/**
 * Open a mermaid diagram in an editor tab, where it gets the full editor width
 * and VS Code's image zoom instead of a sidebar column's worth of pixels.
 *
 * The webview has already rendered the diagram, so its SVG is reused verbatim
 * rather than dragging mermaid into the extension host. With nothing to reuse —
 * a diagram mermaid refused — the source opens as text, which is then the only
 * thing worth looking at.
 */
export async function openDiagram(diagram: DiagramRequest): Promise<void> {
	if (diagram.svg.trim() === "") {
		const document = await vscode.workspace.openTextDocument({
			content: diagram.source,
			language: "mermaid",
		});
		await vscode.window.showTextDocument(document, { preview: true });
		return;
	}

	const file = path.join(DIRECTORY, `diagram-${Date.now().toString(36)}-${++sequence}.svg`);
	await mkdir(DIRECTORY, { recursive: true });
	await writeFile(file, standalone(diagram.svg, diagram.background), "utf8");
	const uri = vscode.Uri.file(file);
	try {
		// Pin the preview: a user who has remapped `.svg` to the text editor would
		// otherwise get markup instead of a diagram.
		await vscode.commands.executeCommand("vscode.openWith", uri, IMAGE_PREVIEW);
	} catch {
		await vscode.commands.executeCommand("vscode.open", uri);
	}
}

/**
 * Vector art has no true pixel size, and a diagram laid out at 400px is exactly
 * the complaint that sends people to an editor tab in the first place. Small
 * diagrams are scaled up to roughly this width; the file stays vector, so zoom
 * costs nothing either way.
 */
const MIN_WIDTH = 1200;
const MAX_SCALE = 3;

/**
 * Turn mermaid's inline SVG into a file that stands on its own.
 *
 * The webview render is sized to fit its container (`width="100%"` plus a
 * `max-width` style), which as a standalone image collapses to whatever the
 * viewer feels like. Pinning scaled viewBox dimensions gives the image preview
 * a size worth looking at, and an opaque backdrop keeps a dark-theme diagram
 * off the preview's transparency checkerboard.
 */
export function standalone(svg: string, background: string): string {
	const end = svg.indexOf(">");
	if (!svg.startsWith("<svg") || end === -1) return svg;

	const tag = svg.slice(0, end + 1);
	const body = svg.slice(end + 1);
	const box = /viewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)/.exec(tag);
	let head = tag
		.replace(/\s(?:width|height)="[^"]*"/g, "")
		.replace(/max-width:[^;"]*;?/g, "");
	// mermaid emits the namespace, but a file without one renders as nothing.
	if (!head.includes("xmlns=")) head = `<svg xmlns="http://www.w3.org/2000/svg"${head.slice(4)}`;
	if (!box) return `${head}${body}`;

	const [, x = "0", y = "0", width = "0", height = "0"] = box;
	const scale = Math.min(MAX_SCALE, Math.max(1, MIN_WIDTH / (Number(width) || MIN_WIDTH)));
	const pixels = (value: string): string => (Number(value) * scale).toFixed(0);
	const sized = `${head.slice(0, -1)} width="${pixels(width)}" height="${pixels(height)}">`;
	const backdrop = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill(background)}"/>`;
	return `${sized}${backdrop}${body}`;
}

/** The backdrop is a computed style, but it lands in an attribute regardless. */
function fill(background: string): string {
	return /^[\w#(),.%/ -]+$/.test(background) ? background : "#ffffff";
}
