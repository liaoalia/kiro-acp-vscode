import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** Extension host bundle: CommonJS, Node platform, `vscode` stays external. */
const extensionCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
});

/** Webview bundle: browser platform, single IIFE file loaded by the chat view. */
const webviewCtx = await esbuild.context({
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  outfile: "dist/webview.js",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  tsconfig: "tsconfig.webview.json",
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log("watching...");
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}
