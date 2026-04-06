/**
 * Bundles packages/client/src/main.ts → packages/client/dist/game.js.
 *
 * Uses esbuild with the Deno loader plugin so that:
 *   - @voxim/* workspace packages resolve via Deno's module graph
 *   - "three" resolves via the client's import map (esm.sh CDN)
 *   - TypeScript is transpiled inline
 *
 * Run:
 *   deno run -A scripts/build_client.ts
 *   deno task bundle
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
  entryPoints: [new URL("packages/client/src/main.ts", root).pathname],
  outfile: new URL("packages/client/dist/game.js", root).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  jsx: "automatic",
  jsxImportSource: "preact",
});

await esbuild.stop();
console.log("[build] packages/client/dist/game.js written");
