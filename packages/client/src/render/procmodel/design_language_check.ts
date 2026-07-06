/**
 * Design-language boot coherence check (T-301) — the client twin of
 * `crossCheckProcModels`/`crossCheckTextureStyles`/`crossCheckCliffVoxelisers`,
 * enforcing `DESIGN_LANGUAGE.md`'s decided vocabulary at boot instead of
 * leaving it as authoring discipline. Fails loudly (throws) before the first
 * frame renders, same fail-fast doctrine as every other content cross-check.
 *
 * Four checks (DESIGN_LANGUAGE.md §6):
 *   1. Every ProcModelDef.generator resolves (delegates to the procmodel
 *      registry — restates the invariant this file's other checks assume).
 *   2. Every material NAME reachable from a ProcModelDef's BASE `params`
 *      tree, and every ScatterDef.material, resolves to a registered
 *      MaterialDef.
 *   3. No signal hue (palette.signal) on a STRUCTURAL-MASS material — a
 *      material is exempt only if it is tagged `decal` (ephemeral, never
 *      structural) or is itself a designated signal material (its name
 *      appears in `palette.materials` mapped to a signal swatch — e.g.
 *      torch_mat→ember, corrupted→rot). Checked against BASE `params` only:
 *      a ProcModelDef's `morphTiers` material references are exempt from
 *      this rule entirely — the G3 state-ladder morph is the sanctioned way
 *      for otherwise-structural mass to shift TOWARD a signal hue when
 *      corrupted; only the base tier (what most of the world renders) must
 *      stay structural.
 *   4. A `class: "character"` ProcModelDef's generator output roots at
 *      model-space z≈0 (the ground-plane invariant) — runs the real
 *      generator (seed 1, its own default params) and checks the lowest
 *      voxel face.
 *   5. A `ModelDefinition.procModelId` (T-302 — marks a "generated: true"
 *      body) must resolve to a `class: "character"` ProcModelDef whose
 *      `params.skeletonId` matches the model's OWN `skeletonId` — the two
 *      sides of the generated-body wiring must agree on which skeleton
 *      they describe. loader.ts already cross-checks the id resolves at
 *      all (shared server+client concern); this is the client-only half
 *      (class + skeleton agreement) that needs the design-language rules.
 */
import type { ContentService, MaterialDef } from "@voxim/content";
import { getGenerator, generatorIds } from "./registry.ts";

/** Tolerance (world units) for the ground-plane check — organic surface
 *  noise / vertexDisp jitters the exact face position by a small amount. */
const GROUND_PLANE_TOLERANCE = 0.5;

/**
 * Recursively collect every string value in an opaque params/morphTiers tree
 * that names a REGISTERED material. Generic on purpose (per the "params is
 * opaque to the loader" doctrine — a generator's shape isn't fixed, so this
 * can't key on a field name like "material"); a string that happens to match
 * a registered material name is treated as a material reference, which is
 * safe because no generator today uses a non-material string param that
 * collides with a material name (e.g. "clumps", "capsule").
 */
function collectMaterialRefs(node: unknown, materials: ContentService["materials"], out: Set<string>): void {
  if (typeof node === "string") {
    if (materials.get(node)) out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectMaterialRefs(v, materials, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectMaterialRefs(v, materials, out);
  }
}

/** True if `mat` is exempt from the "no signal hue on structural mass" rule. */
function isSignalExempt(mat: MaterialDef, signalSwatchNames: ReadonlySet<string>, materialOverrides: Readonly<Record<string, string>>): boolean {
  if ((mat.tags ?? []).includes("decal")) return true;
  const designatedSwatch = materialOverrides[mat.name];
  if (designatedSwatch && signalSwatchNames.has(designatedSwatch)) return true;
  return false;
}

/**
 * Boot cross-check (T-301): resolves generators, resolves every material
 * name reachable from ProcModel/Scatter content, rejects a signal hue on
 * structural mass, and verifies character-class generators emit at the
 * ground plane. Throws on the first violation.
 */
export function crossCheckDesignLanguage(content: ContentService): void {
  const palette = content.getPalette();
  const signalNames = new Set(palette.signal ?? []);
  const materialOverrides = palette.materials ?? {};
  // Swatch NAME -> resolved numeric color, so a material's post-snap `color`
  // can be tested against the reserved signal swatches.
  const swatchColorByName = new Map<string, number>();
  for (const [name, hex] of Object.entries(palette.ramp)) {
    swatchColorByName.set(name, parseInt(hex.replace("#", ""), 16));
  }
  const signalColors = new Set(
    [...signalNames].map((n) => swatchColorByName.get(n)).filter((c): c is number => c !== undefined),
  );

  // --- 1. generator resolution ---
  for (const pm of content.procModels.values()) {
    if (!getGenerator(pm.generator)) {
      throw new Error(
        `[design_language] procModel "${pm.id}" names unknown generator "${pm.generator}" ` +
        `(registered: ${generatorIds().join(", ") || "none"})`,
      );
    }
  }

  // --- 2. material resolution + 3. signal-hue-on-structural-mass (BASE params only) ---
  // Note: `morphTiers` material references are intentionally NOT walked here.
  // `collectMaterialRefs` only ever adds strings that already resolve to a
  // registered MaterialDef (an unresolvable string is silently skipped, which
  // is correct — morphTiers are opaque partial-override objects and
  // legitimately contain non-material fields like `droop`/`height`/`blades`),
  // so there is no separate "unknown material in morphTiers" failure mode to
  // check; and per §3 item 3, a morphTiers material is EXEMPT from the
  // signal-hue rule by design (the state-ladder morph is the sanctioned way
  // for otherwise-structural mass to shift toward a signal hue), so walking
  // it would only produce a check this file must immediately special-case
  // away. The base `params` tier — what most of the world actually renders —
  // is the one this invariant protects.
  for (const pm of content.procModels.values()) {
    const baseRefs = new Set<string>();
    collectMaterialRefs(pm.params, content.materials, baseRefs);
    for (const name of baseRefs) {
      const mat = content.materials.get(name)!; // collectMaterialRefs only adds resolved names
      if (signalColors.has(mat.color) && !isSignalExempt(mat, signalNames, materialOverrides)) {
        throw new Error(
          `[design_language] procModel "${pm.id}" uses material "${name}" (a signal-hue color) ` +
          `as STRUCTURAL mass in its base params — signal hues (ember/rot/blood/bile/frost) are ` +
          `reserved for meaning (DESIGN_LANGUAGE.md §3) and must not land on structural mass. ` +
          `Tag the material "decal" if it's genuinely ephemeral, or use it only in a morphTiers ` +
          `override (the sanctioned state-ladder exception) instead of the base tier.`,
        );
      }
    }
  }
  for (const s of content.scatter.values()) {
    if (s.material) {
      const names = Array.isArray(s.material) ? s.material : [s.material];
      for (const name of names) {
        if (!content.materials.get(name)) {
          throw new Error(`[design_language] scatter "${s.id}" references unknown material "${name}"`);
        }
      }
    }
  }

  // --- 4. character-class generators emit at the ground plane ---
  for (const pm of content.procModels.values()) {
    if (pm.class !== "character") continue;
    const gen = getGenerator(pm.generator);
    if (!gen) continue; // already thrown above; keeps this loop defensive-only
    const ctx = {
      resolveMaterial: (name: string) => content.materials.getOrThrow(name).id,
      getSkeleton: (skeletonId: string) => content.skeletons.get(skeletonId),
    };
    const atoms = gen(1, pm.params, ctx);
    if (atoms.length === 0) {
      throw new Error(`[design_language] character-class procModel "${pm.id}" produced no atoms — cannot verify ground-plane anchoring`);
    }
    let minZ = Infinity;
    for (const a of atoms) minZ = Math.min(minZ, a.cz - a.sz / 2);
    if (Math.abs(minZ) > GROUND_PLANE_TOLERANCE) {
      throw new Error(
        `[design_language] character-class procModel "${pm.id}" does not emit at the ground plane: ` +
        `lowest voxel face is at z=${minZ.toFixed(3)}, expected ≈0 (±${GROUND_PLANE_TOLERANCE}). ` +
        `A generated body must root at its placement point (DESIGN_LANGUAGE.md §6 item 4).`,
      );
    }
  }

  // --- 5. generated-body model ↔ procModel agreement ---
  // `content.models` is defensive-only here (not `?? []`'d away): every real
  // ContentService always has it, but several fixtures above are deliberately
  // partial doubles exercising only checks 1-4.
  for (const model of content.models?.values() ?? []) {
    if (!model.procModelId) continue;
    const pm = content.procModels.get(model.procModelId); // membership already cross-checked by loader.ts
    if (!pm) continue;
    if (pm.class !== "character") {
      throw new Error(
        `[design_language] model "${model.id}" names procModel "${pm.id}" as its generated body, ` +
        `but "${pm.id}" is not class:"character" — a generated-body procModel must opt into the ` +
        `ground-plane invariant (DESIGN_LANGUAGE.md §6 item 4).`,
      );
    }
    const paramsSkeletonId = (pm.params as { skeletonId?: string } | undefined)?.skeletonId;
    if (paramsSkeletonId !== model.skeletonId) {
      throw new Error(
        `[design_language] model "${model.id}" (skeletonId "${model.skeletonId}") names procModel ` +
        `"${pm.id}" whose params.skeletonId is "${paramsSkeletonId}" — the generated-body model and ` +
        `its generator must describe the SAME skeleton.`,
      );
    }
  }
}
