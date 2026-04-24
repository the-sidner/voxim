/**
 * One-shot pass to wire `modelId` onto item prefabs whose name matches an
 * existing voxel model. Items with no obvious match are left untouched
 * (Prefab.modelId is optional — absent means "no visual representation").
 *
 * Run:  deno run --allow-read --allow-write scripts/wire_item_models.ts
 *
 * Re-runnable: existing modelId fields are not overwritten.
 */

const ITEMS_DIR = new URL("../packages/content/data/prefabs/items/", import.meta.url).pathname;

interface Rule {
  modelId: string;
  /** Match if id contains any of these substrings. */
  include: string[];
  /** Skip if id contains any of these substrings. */
  exclude?: string[];
}

const RULES: Rule[] = [
  { modelId: "model_sword_basic",    include: ["sword"] },
  { modelId: "pickaxe",              include: ["pickaxe"] },
  { modelId: "model_axe_basic",      include: ["axe"], exclude: ["pickaxe"] },
  { modelId: "model_hammer_basic",   include: ["hammer", "mace", "club", "mallet"], exclude: ["hammerhead", "hammer_scale"] },
  { modelId: "model_shovel_basic",   include: ["shovel", "spade"] },
  { modelId: "model_spear",          include: ["spear", "pike"], exclude: ["spearhead"] },
  { modelId: "model_crossbow_basic", include: ["crossbow"] },
  { modelId: "model_bow_basic",      include: ["bow"], exclude: ["bowl", "bowstring", "bow_stave", "fiddle_bow", "crossbow", "elbow", "bow_drill", "rainbow"] },
  { modelId: "model_arrow",          include: ["arrow"], exclude: ["arrow_tip", "arrowhead", "yarrow"] },
  { modelId: "model_helmet",         include: ["helmet", "helm", "skullcap", "coif"] },
  { modelId: "model_chestplate",     include: ["chestplate", "cuirass", "breastplate", "hauberk", "gambeson"] },
  { modelId: "model_leggings",       include: ["leggings", "greaves", "chausses"] },
  { modelId: "model_boots",          include: ["boots", "sabaton"] },
  { modelId: "model_torch",          include: ["torch"] },
];

function matchModel(id: string): string | null {
  for (const rule of RULES) {
    if (rule.exclude?.some((s) => id.includes(s))) continue;
    if (rule.include.some((s) => id.includes(s))) return rule.modelId;
  }
  return null;
}

let wired = 0;
let skipped = 0;
let alreadySet = 0;

for await (const entry of Deno.readDir(ITEMS_DIR)) {
  if (!entry.isFile || !entry.name.endsWith(".json")) continue;
  const path = ITEMS_DIR + entry.name;
  const raw = await Deno.readTextFile(path);
  const json = JSON.parse(raw) as { id: string; modelId?: string; components: Record<string, unknown> };

  if (json.modelId) { alreadySet++; continue; }

  const modelId = matchModel(json.id);
  if (!modelId) { skipped++; continue; }

  // Insert `modelId` between `id` and `components` for stable diff layout.
  const out = { id: json.id, modelId, ...Object.fromEntries(Object.entries(json).filter(([k]) => k !== "id")) };
  await Deno.writeTextFile(path, JSON.stringify(out, null, 2) + "\n");
  console.log(`  ${json.id.padEnd(28)} → ${modelId}`);
  wired++;
}

console.log(`\nwired ${wired}, already set ${alreadySet}, no match ${skipped}`);
