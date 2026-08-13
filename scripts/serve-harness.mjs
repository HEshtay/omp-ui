/**
 * Serve the built webview with a stubbed VS Code bridge.
 *
 * Loads the real `dist/webview` bundle in a browser and exposes
 * `window.__deliver(hostMessage)` plus `window.__posted` so a recorded session
 * can be replayed through the actual renderer.
 *
 *   node scripts/serve-harness.mjs [port]
 */

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const ROOT = join(process.cwd(), "dist", "webview");
const PORT = Number(process.argv[2] ?? 5199);

const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const scriptSrc = /src="([^"]*assets\/index\.js)"/.exec(indexHtml)?.[1] ?? "./assets/index.js";
const styleSrc = /href="([^"]*assets\/index\.css)"/.exec(indexHtml)?.[1] ?? "./assets/index.css";

// Mirror the CSP `renderHtml` emits in src/view/chat-view.ts so the harness
// exercises the same nonce + strict-dynamic constraints a real webview imposes;
// a violation here is a violation in VS Code.
const NONCE = "harnessNonce0123456789abcdef";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CSP = [
	"default-src 'none'",
	`img-src ${ORIGIN} data: https:`,
	`font-src ${ORIGIN} data:`,
	`style-src ${ORIGIN} 'unsafe-inline'`,
	`script-src 'nonce-${NONCE}' 'strict-dynamic'`,
	"connect-src 'none'",
].join("; ");

const harnessHtml = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<link rel="stylesheet" href="${styleSrc}" />
		<title>OMP harness</title>
	</head>
	<body class="vscode-dark">
		<div id="root"></div>
		<script nonce="${NONCE}">
			window.__posted = [];
			window.acquireVsCodeApi = () => ({
				postMessage: message => window.__posted.push(message),
				getState: () => undefined,
				setState: () => {},
			});
			window.__deliver = message => window.dispatchEvent(new MessageEvent("message", { data: message }));
			window.__errors = [];
			window.addEventListener("error", event => window.__errors.push(String(event.message)));
			window.addEventListener("unhandledrejection", event => window.__errors.push(String(event.reason)));
			window.__csp = [];
			document.addEventListener("securitypolicyviolation", event => {
				window.__csp.push(event.violatedDirective + " blocked " + event.blockedURI);
			});
		</script>
		<script type="module" nonce="${NONCE}" src="${scriptSrc}"></script>
	</body>
</html>`;

writeFileSync(join(ROOT, "harness.html"), harnessHtml);

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".svg": "image/svg+xml",
};

createServer((request, response) => {
	const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
	const target = join(ROOT, normalize(path === "/" ? "/harness.html" : path));
	if (!target.startsWith(ROOT) || !existsSync(target)) {
		response.writeHead(404).end("not found");
		return;
	}
	response.writeHead(200, {
		"content-type": MIME[extname(target)] ?? "application/octet-stream",
		"cache-control": "no-store",
		...(target.endsWith("harness.html") ? { "content-security-policy": CSP } : {}),
	});
	createReadStream(target).pipe(response);
}).listen(PORT, "127.0.0.1", () => {
	console.log(`harness ready on http://127.0.0.1:${PORT}/`);
});
