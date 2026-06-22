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

// Copy the HTML entry point + theme.css + devtools.css into dist/ alongside
// the bundle. theme.css is the canonical design-token source (lives in the
// client package, consumed by every surface); devtools-specific composition
// classes live next to it in packages/devtools/src/devtools.css.
const htmlSrc  = new URL("packages/devtools/src/studio/index.html", root).pathname;
const themeSrc = new URL("packages/client/src/ui/theme.css", root).pathname;
const dtCssSrc = new URL("packages/devtools/src/devtools.css", root).pathname;
const htmlDst  = new URL("packages/devtools/dist/studio.html", root).pathname;
const themeDst = new URL("packages/devtools/dist/theme.css", root).pathname;
const dtCssDst = new URL("packages/devtools/dist/devtools.css", root).pathname;
await Deno.copyFile(htmlSrc,  htmlDst);
await Deno.copyFile(themeSrc, themeDst);
await Deno.copyFile(dtCssSrc, dtCssDst);

await esbuild.stop();
console.log("[build] packages/devtools/dist/studio.js written");
console.log("[build] packages/devtools/dist/{studio.html,theme.css,devtools.css} copied");
