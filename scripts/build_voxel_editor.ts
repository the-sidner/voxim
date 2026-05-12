/**
 * Bundles packages/devtools/src/voxel-editor/main.tsx → packages/devtools/dist/voxel_editor.js
 *
 * Run:
 *   deno run -A scripts/build_voxel_editor.ts
 *   deno task build-voxel-editor
 */
import * as esbuild from "npm:esbuild@0.25";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11";

const root = new URL("..", import.meta.url);

await esbuild.build({
  plugins: [
    ...denoPlugins({
      configPath: new URL("deno.json", root).pathname,
    }),
  ],
  entryPoints: [new URL("packages/devtools/src/voxel-editor/main.tsx", root).pathname],
  outfile: new URL("packages/devtools/dist/voxel_editor.js", root).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  jsx: "automatic",
  jsxImportSource: "preact",
});

// Copy the HTML entry point + Dreamborn design tokens + primitives into dist.
// theme.css is the canonical source-of-truth for tokens, lives in the client
// package, and is consumed by every surface (game UI, voxel-editor, studio,
// atlas inspector). Devtools-specific composition classes live next to it in
// `packages/devtools/src/devtools.css`.
const htmlSrc  = new URL("packages/devtools/src/voxel-editor/index.html", root).pathname;
const themeSrc = new URL("packages/client/src/ui/theme.css", root).pathname;
const dtCssSrc = new URL("packages/devtools/src/devtools.css", root).pathname;
const htmlDst  = new URL("packages/devtools/dist/voxel_editor.html", root).pathname;
const themeDst = new URL("packages/devtools/dist/theme.css", root).pathname;
const dtCssDst = new URL("packages/devtools/dist/devtools.css", root).pathname;
await Deno.copyFile(htmlSrc,  htmlDst);
await Deno.copyFile(themeSrc, themeDst);
await Deno.copyFile(dtCssSrc, dtCssDst);

await esbuild.stop();
console.log("[build] packages/devtools/dist/voxel_editor.js written");
console.log("[build] packages/devtools/dist/{voxel_editor.html,theme.css,devtools.css} copied");
