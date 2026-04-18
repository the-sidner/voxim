# Pre-Industrial Artisan Crafting — Research Framing

Tracks T-116. This directory is a **research catalog** of real-world pre-industrial
(pre-1500) artisanal production chains, curated for Voxim's gamified simulation. It
is intentionally not a history project: the goal is to identify chains worth authoring
as in-game content and to surface gaps in the current Recipe/Workstation system that
those chains would expose.

The work is phased:

1. **Phase 1 — Framing.** This doc. Canonical schema, scope filter, verb vocabulary seed,
   engine-gap taxonomy.
2. **Phase 2 — Category catalogs.** One markdown file per category, each documenting
   ~6–12 chains in the canonical schema. Parallelised across categories.
3. **Phase 3 — Synthesis.** Cross-category summary: the merged verb vocabulary, the
   full workstation inventory, the engine-gap list with frequency of occurrence.
4. **Phase 4 (separate ticket).** Decide which chains become content, which engine gaps
   close, which remain out-of-scope.

---

## Context: what Voxim's crafting system already supports

Authors of category files should assume these features exist and project chains onto
them. Do not reinvent. The references below are the current source of truth.

**Recipe schema** — [packages/content/src/types.ts:329](../../packages/content/src/types.ts#L329):

- `stationType` — which workstation family the recipe runs on (absent = handcraft).
- `stepType: "time" | "attack" | "assembly"`:
  - **time** — inputs placed, timer runs, output materialises. Passive. Used for
    smelting, fermenting, drying, cooking.
  - **attack** — player/NPC swings a tool at the station; output is instant on the
    swing that matches. Used for hammering, chopping, grinding.
  - **assembly** — player selects a specific recipe from multiple possible matches,
    then resolves with a tool swing. Used where the same inputs can produce different
    outputs (e.g. one ingot + one wood → sword OR knife OR arrowhead).
- `requiredTools` — array of tool types; empty = any (or unarmed).
- `requiredFragmentId` — lore gate: recipe invisible unless the crafter has learned
  this lore fragment. Use for rare/secret chains.
- `inputs[].alternates` — "any wood", "any plant fiber", "any ore". First-class
  substitution, not N-recipe explosion.
- `inputs[].outputSlot` — input's material identity binds into the named slot on the
  output item. One `forge_sword` recipe, blade material comes from whatever ingot was
  fed in.
- `outputs` is an **array** — byproducts are first-class. Slag, whey, ash, bark,
  tailings all just get listed as additional output entries.
- `chainNextRecipeId` — on completion, the station's `activeRecipeId` is set to this
  next recipe instead of clearing. Lets one workstation run a multi-step sequence with
  zero UI friction. Critical feature for long chains.
- `ticks` — free-form timer length at 20 Hz. No engine limit; author-driven pacing.

**Workstation model** — [packages/tile-server/src/components/building.ts:63-101](../../packages/tile-server/src/components/building.ts#L63-L101).
Every workstation is an entity with a `WorkstationTag` (stationType string) and a
`WorkstationBuffer` (slots + capacity + activeRecipeId + progressTicks). Deploying a
new workstation type is a prefab file drop, no code.

**NPCs already craft** at workstations via [craftAtWorkbench](../../packages/tile-server/src/ai/jobs/craft_at_workbench.ts):
approach → place inputs → swing. Player and NPC code paths are unified. Means any
chain authored here is automatically runnable by NPC labour — boring intermediate
steps do not require player presence.

**Recipe graph index** — [recipe_graph.ts](../../packages/content/src/recipe_graph.ts)
builds `producers(itemType)`, `byStation(stationType)`, and `primitives` (gathered-only
items) at content-load. Phase 3 synthesis can leverage this index directly once content
is authored.

---

## Context: known engine gaps

Flag these consistently when a chain exposes one. Use the named tags below in the
"Engine gaps exposed" section of each chain so Phase 3 synthesis can count occurrences.

- **GAP-ENV** — no environmental prerequisites. Can't express "only works near water",
  "only during day", "requires sheltered from rain", "requires ambient cold", "requires
  direct sun". Expressible only as a flavourful recipe name today.
- **GAP-STATE** — no station state beyond the buffer. A furnace has no "is lit?", "fuel
  remaining?", "temperature?". Fuel is just an input item, which is fine for most chains
  but loses "stoke the fire" interactivity.
- **GAP-CHECKPOINT** — no intra-recipe checkpoints. A recipe is atomic (inputs → timer →
  output); you cannot say "at 50% progress the metal is hot, strike now to quench".
  Workaround: decompose into a chain of shorter recipes via `chainNextRecipeId`. The
  workaround is usually fine and often better — flag GAP-CHECKPOINT only when the
  workaround itself is awkward (e.g. requires too many micro-recipes).
- **GAP-QUALITY** — no per-craft quality scalar. Materials carry mechanical properties
  into output stats, so "iron sword > copper sword" works. But "skilled crafter's iron
  sword > novice's iron sword" does not. Lore fragments gate recipes binarily; they do
  not scale output quality.
- **GAP-DURABILITY** — crafting does not wear tools. A hammer swung 10 000 times is
  unchanged.
- **GAP-PROCESS-PARAM** — no continuous parameters on a recipe (temperature, pressure,
  stir rate, humidity). Recipe either runs or doesn't; no "hot enough?" dial.
- **GAP-CONSUMED-STATION** — workstations cannot self-destruct on use. A disposable mould
  (sand cast, lost-wax shell) cannot be modelled as "station that breaks after one use"
  today. Workaround: make the mould an input item rather than a station.
- **GAP-BATCH** — no concept of batch size. A furnace runs one charge at a time; real
  kilns fire dozens of pots at once. Workaround: increase recipe output quantities, but
  then input quantities must also scale linearly.
- **GAP-SKILLED-YIELD** — no "better crafter extracts more from the same input". Overlaps
  with GAP-QUALITY but about quantity rather than stat scaling.

If a chain exposes a gap **not** on this list, name it with a new `GAP-*` tag and
describe it inline; synthesis will merge the vocabulary.

---

## Scope filter

**IN:**
- Pre-1500 tech (broadly: what Europe, the Near East, North Africa, India, or China had
  before gunpowder and oceangoing sail).
- Observable, physical transformations (melting, fermenting, striking, cutting,
  weaving — the player can see the thing change).
- Chains whose end product has a gameplay role: equipment, consumable, ammunition,
  building material, trade good, knowledge unlock, ritual component.
- Techniques that a medieval peasant, specialist, or monastic craftsperson would
  plausibly practise.
- Chains that produce useful byproducts which feed other chains (the interesting
  economic glue).

**OUT:**
- Post-industrial (Bessemer, Haber-Bosch, electrolysis, anything needing precise
  thermometric control that wasn't available).
- Pure subsistence with no craft dimension (foraging a berry is not a chain).
- Chains we've already got: iron smelting, copper smelting, wood-to-plank, campfire
  assembly. Mention them as anchors but don't re-document.
- Ritual/symbolic practices with no material output, unless they're the
  "unlock knowledge" step for a real chain.
- Things requiring more than ~10 distinct steps where each step adds nothing new
  gameplay-wise. Compress or prune.

**TIMING GUIDANCE:** Real-world durations compress aggressively. A month-long drying step
becomes ~30–120 seconds in-game (600–2400 ticks at 20 Hz). A one-hour smelt becomes
~15–60 seconds. Preserve relative ordering (drying > smelting > forging in duration) but
not absolute realism. Author intended tick counts in the chain schema so Phase 4 can
calibrate them consistently.

---

## Canonical chain schema

Each chain in a category file follows this structure. Keep it tight — one paragraph of
historical context, a terse step table, explicit gap flags.

```markdown
### Chain: <Name>

**Real-world context.** 2–4 sentences on where/when this was practised and why it
mattered. What makes it distinctive vs alternatives.

**Gameplay role.** What final good does this chain produce? Why does the game need it
— equipment slot, consumable effect, trade staple, progression gate? If there's
already a similar item in Voxim (see [content/data/items/](../../packages/content/data/items/)),
say so.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | raw_x ×N | pickaxe | — | Resource node, not a recipe |
| 2 | apply-heat | bloomery | raw_x ×3, charcoal ×2 | bloom ×1, slag ×1 | — | 200 | `stepType: time` |
| 3 | hammer | anvil | bloom ×1 | billet ×1, scale ×1 | hammer | 0 | `stepType: attack`; chain from step 2 via `chainNextRecipeId`? (no — different station) |

**Primitive verbs exercised:** apply-heat, hammer, quench, …

**Workstations introduced:** bloomery (pit/shaft furnace for ore reduction), anvil
(hammering surface). If a workstation already exists in the game, reference its id.

**Byproducts and their fate:** slag → road fill / flux for later smelts; scale →
discarded in vanilla, could feed a paint-pigment chain.

**Knowledge gating:** suggested `requiredFragmentId` (create new or reuse existing
lore fragment). Absent = freely known.

**Engine gaps exposed:** `GAP-ENV` (requires rain-sheltered bloomery stack), `GAP-BATCH`
(historical blooms are ~5–10 kg, batched; current model is one-charge).

**Variants worth noting:** brief mention of alternative methods or regional variants
that would be redundant to document in full.
```

### What makes a "good" chain entry

- **Minimum 2 steps.** One-step gathering or one-step combining is not a chain. If a
  craft is a one-shot recipe, mention it in the category intro or as a "Trivial recipes"
  bullet, don't give it the full schema.
- **Identify the interesting step.** Every chain has one or two steps that are genuinely
  different from anything else (retting flax in pond water; bog-iron roasting; wax-lost
  casting). The rest (fetch, chop, dry, apply) are boilerplate. Call out the interesting
  step in the notes.
- **Name byproducts always.** Even if you have to mark them as "discarded in Voxim (no
  gameplay use)", list them. Synthesis needs the byproduct graph to spot cross-chain
  economic links.

---

## Category file structure

Each `<category>.md` follows:

```markdown
# <Category>

**Scope & gameplay role.** What this category contributes overall. What economic role
its outputs play. Which player archetypes (combatant, homesteader, trader, specialist)
it serves.

**Chains documented.** Bulleted index with one-line hooks.

## Chain: <name 1>
...

## Chain: <name 2>
...

## Variants and minor chains

Brief mentions of chains that didn't warrant full documentation and why.

## Category summary

- Verbs used: ...
- Workstations introduced: ...
- Primitives consumed: raw materials this category needs from resource nodes.
- Byproducts: what this category exports to other chains.
- Top engine gaps: most frequent gap tags in this category, with a sentence each.
```

---

## Primitive verb vocabulary (seed)

Starting list; Phase 3 will merge and canonicalise. Category authors should use these
when they fit, and propose new verbs when needed.

**Thermal.** `apply-heat` (low, drying/curing), `apply-high-heat` (smelting, kiln firing,
glass melt), `combust` (reduce fuel, drive a process), `quench` (rapid cool in water/oil),
`temper` (controlled low-heat after hardening), `sinter` (fuse powders below melting).

**Mechanical.** `strike` / `hammer` / `forge`, `grind` (quern, muller), `pound` /
`crush`, `cut` / `cleave`, `shear`, `split` / `rive`, `saw`, `plane`, `chisel`,
`drill`, `turn` (lathe), `knead`, `press` (oil, cheese, juice), `draw` (wire),
`roll` (sheet, dough).

**Chemical/biological.** `ferment` (alcohol, vinegar, lactic), `ret` (bacterial/fungal
decomposition for fibre release), `cure` (salt, brine, smoke), `tan` (vegetable, alum,
brain, smoke), `leach` (ash → lye, ore → concentrate), `mordant` (fix dye to fibre),
`dye`, `saponify` (fat + lye → soap), `distil`.

**Assembly.** `assemble` (hafting a head onto a shaft, fitting a hilt), `weave` (warp/
weft), `spin` (twist fibres into yarn), `knit`, `braid`, `sew`, `join` (joinery,
dovetails, mortise), `solder`, `rivet`.

**Preparation & gathering.** `sort` / `grade`, `wash`, `soak`, `dry`, `age` / `season`,
`mature` (cheese, wine), `scrape`, `peel`, `pick` (berries, hops), `thresh`, `winnow`,
`sieve`.

---

## Contributing a category file

1. Read this doc end to end.
2. Pick ~6–12 chains for your category. Depth over breadth — better to document eight
   chains well than twenty poorly. Prune obvious redundancies (iron vs mild-iron vs
   wrought-iron aren't three chains; they're variants of one).
3. For each chain, apply the scope filter. If it fails, skip it.
4. Use the canonical schema. Be terse. Names, verbs, and tick counts carry the weight;
   avoid historical exposition beyond 2–4 sentences.
5. Flag engine gaps consistently with the tags above.
6. Close the file with the category summary section.
7. Filename: `research/crafting/<category>.md` (lowercase, underscore-separated).

Do **not** edit existing content data files, existing TypeScript, or the ticket. This is
research only — decisions on what to author and what to change in the engine come in a
separate ticket after Phase 3.
