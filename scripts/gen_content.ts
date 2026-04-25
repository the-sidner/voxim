/**
 * Regenerate static TypeScript aggregation files from per-item data directories.
 *
 * Run after adding, removing, or renaming any file under packages/content/data/:
 *   deno task gen-content
 *
 * The generated files are source-controlled so the browser bundle can import
 * content data statically without using Deno APIs (which aren't available in
 * the browser).  They live in packages/content/src/ alongside the hand-written
 * TypeScript and are committed.  The per-item JSON files are the source of truth
 * — never edit the generated files directly.
 *
 * Extend TARGETS below to add new browser-bundled categories.
 */

const DATA_DIR = new URL("../packages/content/data", import.meta.url).pathname;
const OUT_DIR  = new URL("../packages/content/src",  import.meta.url).pathname;

interface Target {
  /** Output file stem, e.g. "weapon_actions" → weapon_actions_static.ts */
  name: string;
  /** TypeScript type name from types.ts */
  typeName: string;
  /** Subdirectory under DATA_DIR */
  subdir: string;
}

const TARGETS: Target[] = [
  { name: "weapon_actions", typeName: "WeaponActionDef", subdir: "weapon_actions" },
  { name: "item_prefabs",   typeName: "Prefab",          subdir: "prefabs/items"  },
  { name: "recipes",        typeName: "Recipe",          subdir: "recipes"        },
];

for (const { name, typeName, subdir } of TARGETS) {
  const dir = `${DATA_DIR}/${subdir}`;
  const ids: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      ids.push(entry.name.slice(0, -5)); // strip .json
    }
  }
  ids.sort();

  const lines = [
    "// Generated — do not edit directly.",
    "// Re-run `deno task gen-content` after adding or renaming data files.",
    `import type { ${typeName} } from "./types.ts";`,
    "",
    ...ids.map((id) => `import ${id} from "../data/${subdir}/${id}.json" with { type: "json" };`),
    "",
    `export const ${name}: readonly ${typeName}[] = [`,
    ...ids.map((id) => `  ${id} as unknown as ${typeName},`),
    "];",
    "",
  ];

  const outPath = `${OUT_DIR}/${name}_static.ts`;
  await Deno.writeTextFile(outPath, lines.join("\n"));
  console.log(`  ${name}_static.ts — ${ids.length} entries`);
}

console.log("gen-content done");
