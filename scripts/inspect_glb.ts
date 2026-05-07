/**
 * Dump a GLB's skeleton + animation channel structure so you can author a
 * bone map for a new source library without guessing names.
 *
 * Usage:
 *   deno run -A scripts/inspect_glb.ts <input.glb>
 */

import { NodeIO } from "npm:@gltf-transform/core@4.2";

if (Deno.args.length < 1) {
  console.error("usage: inspect_glb.ts <input.glb>");
  Deno.exit(1);
}
const glbPath = Deno.args[0];

const io = new NodeIO();
const doc = await io.read(glbPath);
const root = doc.getRoot();

console.log(`# ${glbPath}`);
console.log("");
console.log("## Nodes (skeleton bones)");
for (const node of root.listNodes()) {
  const name = node.getName() || "(unnamed)";
  const children = node.listChildren().map((c) => c.getName() || "?").join(", ");
  console.log(`  ${name.padEnd(40)} children: [${children}]`);
}

console.log("");
console.log("## Animations");
for (const anim of root.listAnimations()) {
  const animName = anim.getName() || "(unnamed)";
  const channels = anim.listChannels();
  let dur = 0;
  for (const ch of channels) {
    const arr = ch.getSampler()?.getInput()?.getArray();
    if (arr && arr.length > 0 && arr[arr.length - 1] > dur) dur = arr[arr.length - 1];
  }
  console.log(`  ${animName.padEnd(30)} channels: ${channels.length}, duration: ${dur.toFixed(2)}s`);

  // Group channels by node + path so we can spot bones with rotation tracks.
  const byNode = new Map<string, Set<string>>();
  for (const ch of channels) {
    const nodeName = ch.getTargetNode()?.getName() || "(unknown)";
    const path = ch.getTargetPath();
    if (!path) continue;
    if (!byNode.has(nodeName)) byNode.set(nodeName, new Set());
    byNode.get(nodeName)!.add(path);
  }
  for (const [nodeName, paths] of byNode) {
    console.log(`      ${nodeName.padEnd(36)} [${[...paths].join(", ")}]`);
  }
}
