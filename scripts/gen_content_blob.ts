/**
 * Generate the static content bootstrap blob the swing inspector loads.
 * Mirrors what the tile-server sends a joining client, but written to a file the
 * inspector (a pure static page) can fetch — no WebTransport / join needed.
 *
 *   deno run --allow-read --allow-write scripts/gen_content_blob.ts
 */
import { JsonSource, encodeBootstrap } from "@voxim/content";

const root = new URL("..", import.meta.url).pathname;
const service = await JsonSource.load(root + "packages/content/data");
const blob = await encodeBootstrap(service);
await Deno.writeFile(root + "packages/client/dist/content.bin", blob);
console.log(`[gen-content-blob] wrote packages/client/dist/content.bin (${blob.length} bytes)`);
