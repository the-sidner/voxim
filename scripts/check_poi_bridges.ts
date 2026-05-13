/**
 * POI bridge-coverage validator (T-207).
 *
 * For every authored POI under `packages/content/data/pois/`, this
 * script asserts that any gate's `flavorAccept` set is non-empty
 * intersect-reachable from at least one POI's `themes` set. Failure
 * means the Tier-6 matcher (T-209) would never be able to wire that
 * gate via theme matching → forced retry-saturation → degraded
 * fallback on every tile that selects that POI.
 *
 * Run manually:
 *   deno run --allow-read scripts/check_poi_bridges.ts
 *
 * Exit code 0 = all gates bridge-reachable; non-zero = orphan(s).
 * The non-zero exit is so this slot into CI / pre-commit.
 */

import { JsonSource } from "../packages/content/src/loader.ts";

const content = await JsonSource.load();
const allPois = [...content.pois.values()];
const totalGates = allPois.filter(p => p.gate.kind !== "open").length;

interface OrphanReport {
  poiId: string;
  gateKind: string;
  flavorAccept: string[];
}

const orphans: OrphanReport[] = [];

for (const poi of allPois) {
  if (poi.gate.kind === "open") continue;
  const accept = poi.gate.flavorAccept;
  let reachable = false;
  for (const other of allPois) {
    if (other.id === poi.id) continue;
    const themes = other.reward.trinketTheme.themes;
    if (themes.some(t => accept.includes(t))) {
      reachable = true;
      break;
    }
  }
  if (!reachable) {
    orphans.push({ poiId: poi.id, gateKind: poi.gate.kind, flavorAccept: accept });
  }
}

// Theme-coverage report (informational): every theme that some gate
// accepts SHOULD be dropped by ≥1 POI; orphan themes mean the matcher
// can never wire that flavor.
const acceptedThemes = new Set<string>();
for (const p of allPois) {
  if (p.gate.kind !== "open") {
    for (const t of p.gate.flavorAccept) acceptedThemes.add(t);
  }
}
const droppedThemes = new Set<string>();
for (const p of allPois) {
  for (const t of p.reward.trinketTheme.themes) droppedThemes.add(t);
}
const orphanThemes = [...acceptedThemes].filter(t => !droppedThemes.has(t)).sort();

console.log(`[poi_bridges] inspected ${allPois.length} POIs, ${totalGates} gated.`);
console.log(`[poi_bridges] theme vocabulary: dropped=${droppedThemes.size}, accepted=${acceptedThemes.size}`);

if (orphanThemes.length > 0) {
  console.log(`[poi_bridges] ⚠ themes accepted by gates but dropped by no POI:`);
  for (const t of orphanThemes) console.log(`    - ${t}`);
}

if (orphans.length > 0) {
  console.error(`[poi_bridges] FAIL — ${orphans.length} gate(s) are not bridge-reachable:`);
  for (const o of orphans) {
    console.error(`  ${o.poiId}: gate.kind=${o.gateKind} flavorAccept=[${o.flavorAccept.join(", ")}]`);
    console.error(`    no other POI has any of these in reward.trinketTheme.themes`);
  }
  Deno.exit(1);
}

console.log(`[poi_bridges] ✓ all ${totalGates} gates are bridge-reachable.`);
