# Design Language — the voxel grammar (T-301)

**Status: decided.** This document codifies a vocabulary the user has already settled — it is a
spec for generators (`ProcModelDef`/`ScatterDef` authors, T-302/T-303/T-306) to read, not a design
proposal. See `ART_DIRECTION.md` (the target look) and `VISUAL_DATAMODEL_PLAN.md` (the route) for
the surrounding data-model context; this doc is the one-page grammar reference those two assume.

---

## 1 · The 4-word vocabulary

Every procedural voxel form — terrain feature, plant, creature, weapon, piece of armor — is built
from four primitive shape-roles. A generator emits `VoxelAtom[]` by composing these; a designer
adding a new generator picks which words the new form needs, never invents a fifth.

| Word | Role | Reads as | Examples |
|---|---|---|---|
| **SOLID** | Load-bearing bulk mass | The thing's core volume — what makes it read as *one object* | Torso, head, boulder core, tree trunk cross-section, pommel |
| **LIMB** | A tapered, elongated volume that fills a length | Reach, extension, articulation | Arms, legs, tree branches, blade spine, spear haft |
| **SHELL** | A thin covering layer over a SOLID/LIMB | Armor, bark, rind — surface that reads as separate from what it covers | Armor plates, tree bark rings, turtle/beetle carapace, weapon guard |
| **SCATTER-FLECK** | Small, high-count, loosely-placed detail | Texture at the "many small things" scale — never load-bearing | Foliage blades, moss clumps, gravel/litter, fur tufts, rivets |

**Composition rule:** a generator's output is legible as a *stack* of these words, not a single
blob. `humanoid_grammar` (T-302) = SOLID torso/head + LIMB arms/legs. `blade_grammar` (T-306) =
LIMB spine + SOLID pommel + SHELL guard. `tree_grammar` (already shipped, retrofit-compatible with
this vocabulary) = SOLID trunk cross-section (tapered, so arguably LIMB-shaped) + LIMB branches +
SCATTER-FLECK foliage canopy.

A generator never needs to *tag* its atoms with the word — the vocabulary is a design/authoring
lens (which shape function did you reach for?), not a runtime field on `VoxelAtom`.

---

## 2 · The human-anchored scale hierarchy

**Organic everywhere, BUT silhouette proportions stay human/ground-anchored.** Surface treatment
(vertex displacement, irregular edges, per-voxel jitter) applies across every class — including
characters and equipment — but the *proportions* of the silhouette are locked to the following
ladder so figures read and animate correctly at ARPG telephoto distance. Organic surface ≠
unreadable form.

| Reference | Size | Note |
|---|---|---|
| **1 unit (1u)** | the atomic voxel-world unit | everything below is expressed in this unit |
| **Standing human** | **1.2u** tall | the scale anchor every other class is checked against |
| **Head** | **≈12.5%** of standing height | the classic figure-drawing "7.5–8 heads tall" convention, inverted as a %, so a generated head doesn't balloon or shrink and break silhouette readability |
| **Trees** | **5–12u** | 4–10× human height — reads as canopy-scale, not a shrub |
| **Boulders** | **0.5–3u** | sub-human to ~2.5× human — reads as terrain-scale debris, not a mountain |

A generator that emits a character-class body (T-302) or humanoid-proportioned equipment must stay
within the human-anchor ratios above; a generator emitting environment-scale content (trees,
boulders, terrain features) is checked against its own scale band instead. **Organic surface noise
(vertexDisp, per-voxel warp) is orthogonal to this table** — it may vary freely per material
(§4) without moving the silhouette outside its band.

---

## 3 · Signal-hue reservation

The palette (`packages/content/data/palette.json`) already names a **closed set of signal
swatches**, reserved by the single color authority (T-280) for meaning, never decoration:

```
signal: ["ember", "ember-hi", "rot", "blood", "bile", "frost"]
```

- **ember / ember-hi** — fire, warmth, agency (torches, forges, active light sources)
- **rot** — corruption (the *only* vivid hue on otherwise-desaturated corrupted mass)
- **blood** — damage, decals, death
- **bile** — poison/disease signaling
- **frost** — cold/ice signaling

**Rule: signal hues never land on structural mass.** A material that forms the load-bearing
SOLID/LIMB/SHELL body of terrain, a building, a creature's base flesh, or a weapon's core must not
resolve (after palette-snap) to a signal swatch. Signal hues are reserved for:

1. **Purpose-built signal materials** — `torch_mat` (ember), `corrupted` (rot), `blood` (blood, and
   only as a `tags: ["decal"]` material — never structural).
2. **`MaterialVariant` state-ladder entries** (G3) — a stone's `corrupted` variant is *allowed* to
   shift toward `rot` precisely because the ladder's whole point is signaling a state change on
   otherwise-structural mass; the *base* material stays off signal hues so the ladder has
   somewhere to shift *to*.
3. **`ProcModelDef.morphTiers`** — a fern's corruption-morph tier may swap to the `corrupted`
   material; this is the same state-ladder exception (item 2) applied to procedural generators,
   not a violation — the *base* tier (tier 0, what most of the world renders) must stay structural.

A material with `tags: ["decal"]` (ephemeral, non-structural by construction — see
`VISUAL_DATAMODEL_PLAN.md`'s decal-persistence decision) is exempt from the structural check
entirely: `blood` is allowed to sit on the `blood` signal swatch precisely because it never forms
load-bearing mass.

---

## 4 · Semantic density bands per material tag

`ScatterDef`/generator authors pick placement density from the material's **tag**, not by feel per
scene. These are starting bands (§`generatorPreferences.density_range`, see below); a specific
`ScatterDef` may narrow but should not invert the ordering:

| Tag | Density band | Reads as |
|---|---|---|
| `vegetation` (grass, ferns, moss, mushrooms, leaf litter) | **high** (0.5–1.0 keep-probability, or dense clusters) | ground cover — the "wall of dark overgrown detail" the art bible calls for |
| `organic` non-vegetation (fur, flesh, bone, hair) | **medium–high**, but SCATTER-FLECK scale only (fur tufts, not fur boulders) | surface texture on a character, never a placed prop |
| `wood` | **low–medium** as scatter (trees are sparse/large per §2), **high** as SCATTER-FLECK (bark texture, twig litter) | canopy is sparse; bark detail is dense |
| `stone` / `mineral` | **low** as scatter (boulders, per §2 band), **medium** as SHELL/SOLID surface relief | terrain-scale placement is sparse; the material itself can still be richly detailed at the voxel/relief level |
| `metal` | **very low** (crafted, never naturally scattered) | metal never appears as ambient ground clutter — it is always an authored prop/equipment piece |
| `ground` (dirt, sand, path, snow) | n/a — base layer, not scattered onto | the substrate other layers scatter *onto* |
| `decal` | **event-driven**, not density-banded | ephemeral, spawned by the closed GameEvent catalog, not placed by a `ScatterDef` |

---

## 5 · `MaterialDef.generatorPreferences` — schema

An additive, fully-optional hint block (`packages/content/src/types.ts`) a generator MAY consult
when it needs a material-appropriate default instead of a hardcoded literal. Absence is valid —
this block documents *authored intent*, it is not required for a material to be usable.

```typescript
interface MaterialGeneratorPreferences {
  /** Suggested per-cell/per-instance placement density [min,max], §4 bands. */
  density_range?: [number, number];
  /** Suggested SHELL/SCATTER-FLECK thickness in world units (bark rind, armor
   *  plate, fur tuft length) — NOT a SOLID/LIMB bulk dimension. */
  thickness_range?: [number, number];
  /** Whether this material is suited to G3 MaterialStateLadder layering
   *  (fresh→weathered→decayed, healthy→corrupted) — i.e. can be blended/
   *  stacked as a SHELL over another material (moss over stone, rot over
   *  flesh). */
  layerable?: boolean;
  /** Suggested emissive intensity [0,1] for generator-driven glow (embers,
   *  runes, eyes) — independent of the material's own base `emissive` field,
   *  which is the material's OWN authored glow; this is a generator HINT for
   *  "if you're adding a glowing accent voxel, here's a reasonable value". */
  emission?: number;
}
```

See `packages/content/src/types.ts` `MaterialDef.generatorPreferences` for the authoritative
shape and field-level docs.

---

## 6 · Boot coherence check

Mirroring the existing client fail-fast checks (`crossCheckProcModels`, `crossCheckTextureStyles`,
`crossCheckCliffVoxelisers`), `crossCheckDesignLanguage` (`packages/client/src/render/procmodel/
design_language_check.ts`) verifies at client boot:

1. Every `ProcModelDef.generator` resolves to a registered generator (delegates to the existing
   procmodel registry — restates the invariant this doc's vocabulary depends on).
2. Every material NAME referenced anywhere in a `ProcModelDef`'s BASE `params` tree, and every
   `ScatterDef.material`, resolves to a registered `MaterialDef`.
3. **No signal hue on structural mass** (§3), checked against BASE `params` only: for every
   material that is NOT tagged `decal` and is NOT itself a designated signal material (its name
   maps to a signal swatch in `palette.materials` — `torch_mat`→ember, `corrupted`→rot), its
   resolved (palette-snapped) color must not equal a `palette.signal` swatch. A `ProcModelDef`'s
   `morphTiers` material references are exempt from this rule by design (§3 item 3) — the
   state-ladder morph IS the sanctioned way for structural mass to shift toward a signal hue.
4. **Character-class generators emit at the ground plane**: a `ProcModelDef` opted into
   `class: "character"` must produce atoms whose lowest voxel face sits at model-space `z ≈ 0`
   (within tolerance), so a generated body always roots at its placement point instead of floating
   or burrowing. (No generator declares `class: "character"` yet — T-302's `humanoid_grammar` is
   the first consumer; the check is a no-op today and becomes load-bearing the moment that lands.)

Failing any of the above throws at boot, before the first frame renders — the same fail-fast
discipline every other content primitive in this codebase uses.
