/**
 * Build only the swing inspector bundle (dist/inspector.js). Separate from
 * build_client.ts so it can run without overwriting the (root-owned in the dev
 * container) game.js.
 *
 *   deno run -A --node-modules-dir=auto scripts/build_inspector.ts
 */
import * as esbuild from "npm:esbuild@0.25";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11";

const root = new URL("..", import.meta.url);
await esbuild.build({
  plugins: [...denoPlugins({ configPath: new URL("deno.json", root).pathname })],
  entryPoints: [new URL("packages/client/src/inspector.ts", root).pathname],
  outfile: new URL("packages/client/dist/inspector.js", root).pathname,
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  minify: false, jsx: "automatic", jsxImportSource: "preact",
});
await esbuild.stop();
console.log("[build] packages/client/dist/inspector.js written");
