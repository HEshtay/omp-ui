import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The webview is loaded from disk through `Webview.asWebviewUri`, never from a
// dev server, so emit plain relative assets with predictable names.
export default defineConfig({
	plugins: [react()],
	root: "webview",
	base: "./",
	build: {
		outDir: "../dist/webview",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: false,
		chunkSizeWarningLimit: 3000,
		rollupOptions: {
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
});
