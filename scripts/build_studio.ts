/**
 * Bundles packages/devtools/src/studio/main.tsx → packages/devtools/dist/studio.js
 *
 * Run:
 *   deno run -A scripts/build_studio.ts
 *   deno task build-studio
 */
import * as esbuild from "npm:esbuild@0.25";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11";

const root = new URL("..", import.meta.url);

await esbuild.build({
  plugins: [
    ...denoPlugins({
      configPath: new URL("packages/devtools/deno.json", root).pathname,
    }),
  ],
  entryPoints: [new URL("packages/devtools/src/studio/main.tsx", root).pathname],
  outfile: new URL("packages/devtools/dist/studio.js", root).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  jsx: "automatic",
  jsxImportSource: "preact",
});

await esbuild.stop();
console.log("[build] packages/devtools/dist/studio.js written");
