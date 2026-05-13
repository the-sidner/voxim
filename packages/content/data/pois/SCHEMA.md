# POI Schema — Design Document

This document defines the **POI (Point of Interest)** content type. A POI is
the unit of *interactive activity* on a tile: a bossfight, a wave-survival
arena, a puzzle, an encounter, an action prompt, an exploration moment. POIs
are how a tile becomes more than its terrain; they are also how questlines
emerge — not as authored narrative bullets, but as the **topology of a
dependency-DAG over a tile's POIs**.

The schema is deliberately *fungible*: a POI definition does not bake in
which other POI it links to, what trinket it drops in detail, or how the
narrative reads. Those are decided by the **tile generator** when it weaves
the selected POIs into a DAG. The POI definition only declares: what kind
of activity, what spatial footprint, what kind of gate it can sit behind,
what thematic flavor its reward carries.

This document is the contract between **designers** (who author POI
definitions) and the **generator** (which selects, places, links, and
instantiates them).

---

## 1. Why this shape

The earlier design conversation converged on three observations:

1. **POIs are the building block of in-tile gameplay.** Everything the player
   *does* inside a tile happens at one POI or in transit between them.
2. **Quests are the dependency-DAG over POIs.** "Quest X" is not an authored
   narrative; it's the path the player takes through the DAG. The "fetch
   item" is a trinket the source POI drops, and the "deliver" is using that
   trinket on the destination POI's gate. No NPC dialog, no quest log
   padding — discovery itself is the loop.
3. **Trinket identity is fungible.** What matters is the DAG edge: "source
   POI drops a key for destination POI's gate". The trinket's name and
   appearance are flavor, derived from the source+destination tag overlap.

Consequence: the schema separates **what a POI is** (this document) from
**how POIs connect in a particular tile** (the generator's DAG-builder
output). Designers author POIs in isolation; the generator wires them.

---

## 2. POI Definition — top-level shape

One JSON file per POI definition in `packages/content/data/pois/{id}.json`.
Fields:

```jsonc
{
  "id":          "wolf_den",        // string, unique, snake_case
  "schema":      1,                  // schema version for forward compat
  "displayName": "Wolf Den",        // human-readable label

  // ── activity ──
  "type":     "encounter",          // see § 3
  "activity": { /* type-specific */ }, // see § 3

  // ── spatial fit ──
  "fit": {                          // see § 4
    "preferredTopology": ["pocket", "deadend"],
    "minArea":  200,
    "maxArea":  600,
    "enclosure": { "min": 0.4, "max": 1.0 },
    "requiredBiome": ["forest", "hills"]
  },

  // ── gate (how the player enters) ──
  "gate": { "kind": "open" },        // see § 5 — may be replaced by generator

  // ── reward (what drops on completion) ──
  "reward": {                        // see § 6
    "trinketTheme": {
      "themes":     ["bone", "predator", "wolf"],
      "flavorTags": ["primal", "savage"],
      "visualHint": "ivory"
    },
    "extras": [
      { "kind": "lore",  "id": "lore_wolf_pack_drift", "chance": 0.3 },
      { "kind": "stack", "id": "wolf_pelt",            "qty": 2 }
    ]
  },

  // ── tagging (used for trinket-theme matching + macro quotas) ──
  "tags": ["bone", "predator", "wolf", "primal", "wilderness"],

  // ── generator hints ──
  "difficulty":   2,                 // 1..5; informs DAG-layer placement
  "quotaWeight":  1.0,               // macro: how often this POI may appear world-wide
  "roles": ["entry", "midchain"]     // legal positions in the DAG (see § 7)
}
```

**Schema versioning.** `schema: 1` is the current version. Breaking field
changes bump it; the loader rejects unknown future versions to fail loud
rather than silently drop fields.

---

## 3. POI Types and Activity Definitions

Each POI has a `type` and a `type`-specific `activity` blob. The runtime
selects the right *POI runner* based on type. New types are added by
defining a new runner in the engine; this is a **closed set** (designers
cannot invent types without code support).

### `encounter` — fight-on-arrival

```jsonc
"activity": {
  "spawnTable": "wolf_pack_medium",   // ref into packages/content/data/spawn_tables/
  "spawnTriggerRadius": 8,            // world units; player enters → wave fires
  "minClearKills": "all",             // "all" | number
  "regenAfterTicks": null             // null = persistent until tile lifecycle reset
}
```

### `bossfight` — single high-stakes encounter

```jsonc
"activity": {
  "bossNpcId":  "stone_construct",    // packages/content/data/npcs/
  "arenaRules": {
    "lockEntry": true,                 // entry collapses on engage
    "phaseTriggers": [0.66, 0.33],    // HP fractions
    "addsTable":  "construct_motes"
  }
}
```

### `wave` — survive N waves

```jsonc
"activity": {
  "waves": [
    { "spawn": "wolf_lone",     "count": 2, "interval": 0 },
    { "spawn": "wolf_pack_min", "count": 4, "interval": 30 },
    { "spawn": "alpha_wolf",    "count": 1, "interval": 60 }
  ],
  "interWaveSeconds": 12,
  "playerSafeZoneRadius": 0   // 0 = no safe zone, full arena
}
```

### `puzzle` — interactive logic gate

```jsonc
"activity": {
  "puzzleId": "lever_sequence",        // ref into packages/content/data/puzzles/
  "params":   { "length": 5, "showHints": true },
  "failurePenalty": "reset"            // "reset" | "damage" | "none"
}
```

`puzzleId` references a puzzle template in a separate content category
(not part of this schema). Each puzzle template defines its own internal
rules — same pattern as `weapon_actions`.

### `action` — single interaction prompt

```jsonc
"activity": {
  "interactionPrefab": "ancient_chalice",  // packages/content/data/prefabs/
  "verb":              "drink",
  "consumable":        true,                // POI completes on use, no respawn
  "preconditionTags":  []                   // optional state-based gates
}
```

### `exploration` — passive trigger (lore, sight-finding)

```jsonc
"activity": {
  "triggerKind": "proximity",  // "proximity" | "look-at" | "destroy-prop"
  "triggerRadius": 3,
  "loreId":      "lore_old_well_marker"
}
```

---

## 4. `fit` — Spatial Constraints

The generator matches POIs to zones from the **AnnotatedZoneGraph**
(Tier 3 in the pipeline). `fit` declares what makes a zone *eligible* for
this POI.

| field               | type        | meaning                                                            |
|---------------------|-------------|--------------------------------------------------------------------|
| `preferredTopology` | role[]      | zone topology tags this POI wants (see § 4.1)                      |
| `minArea`           | number      | minimum zone area in tile pixels                                   |
| `maxArea`           | number      | maximum                                                            |
| `enclosure`         | {min,max}?  | 0 = fully open plaza, 1 = sealed cave                              |
| `requiredKind`      | KindTag[]?  | restrict to zones whose boundary kind matches (forest, stone, …)   |
| `requiredBiome`     | BiomeTag[]? | restrict to specific biome cells                                   |
| `traversal`         | string?     | `"path"` (default) \| `"wilderness"` \| `"either"` — which zone-class this POI lives in. Wilderness POIs require a stair-gated ascent (T-210). |

### 4.1 Zone Topology Roles

These are produced by the topology-annotation transformer (T-208) +
the wilderness-class split (T-210). A zone carries exactly one role.

**Path-class roles** (default-walkable corridor / chamber network):

| role           | when assigned                                            |
|----------------|----------------------------------------------------------|
| `plaza`        | large area, round shape, high-degree junction            |
| `pocket`       | small enclosed area, degree-1 junction                   |
| `deadend`      | path terminus, narrow                                    |
| `corridor`     | elongated traversal-only area, degree 2                  |
| `crossroads`   | degree 3+ junction without significant area              |
| `lobby`        | medium chamber adjacent to a path with multiple exits    |
| `arena`        | very large flat area                                     |

**Wilderness-class roles** (elevated plateaus, stair-gated, T-210). The
dominant boundary kind of the closed-pixel blob picks the specific role:

| role        | when assigned                                                  |
|-------------|----------------------------------------------------------------|
| `crag`      | dominant kind = stone — rocky outcrop                          |
| `grove`     | dominant kind = forest, area > 500 — large dense woodland      |
| `thicket`   | dominant kind = forest, area ≤ 500 — small overgrown patch     |
| `hollow`    | dominant kind = grass mound, area > 300 — broad grassy plateau |
| `outcrop`   | dominant kind = grass mound, area ≤ 300 — small grassy mound   |
| `morass`    | dominant kind = water — *reserved for v2; water blobs are not  yet wilderness zones (bridge mechanic doesn't exist).* |

The generator scores `fit` as a soft constraint: closer-to-preferred is
better; mismatches drop the score but don't outright reject (unless
`minArea` / `requiredBiome` / `traversal` says otherwise — those are hard).

---

## 5. Gates — How a POI is Locked

A `gate` field declares what kind of lock the POI **can sit behind**. The
DAG-builder assigns the actual key when wiring the tile.

```jsonc
// Open from start. An entry POI must have at least one open instance per tile.
"gate": { "kind": "open" }

// Needs one trinket. Generator fills `trinketRef` with whatever upstream
// POI's drop matches the dest's flavor (see § 6).
"gate": { "kind": "item", "trinketRef": null, "flavorAccept": ["bone","primal"] }

// Needs every listed trinket. Forces multiple parallel paths to converge.
"gate": { "kind": "multi", "count": 2, "flavorAccept": ["bone","stone","arcane"] }

// Any one of listed trinkets. Creates legitimate alternative paths.
"gate": { "kind": "choice", "count": 1, "flavorAccept": ["arcane","ritual","glyph"] }
```

For the v1 schema, these four gate kinds are supported. Future gate kinds
(`state` for time-of-day, `stat` for character level, `env` for world-state
preconditions) are intentionally **out of scope for v1** — they require
more runtime hooks. Adding them later only widens the union; existing POIs
keep working.

**`flavorAccept`** is the matching layer: a gate accepts any trinket whose
themes intersect this set. So a `wolf_den`-dropped trinket (themes: bone,
predator, wolf) opens a gate with `flavorAccept: ["bone"]`. This is how
the generator picks meaningful pairings: source.tags ∩ dest.gate.flavorAccept
must be non-empty for a wiring to be eligible.

A POI declaration can also say "I refuse to be a gated POI" by setting
`gate: { kind: "open" }` and declaring `roles: ["entry"]` only.

---

## 6. Rewards and Trinket Themes

Every POI drops exactly one **trinket** on completion (plus optional
`extras` like lore or material stacks). The trinket is the DAG edge.

```jsonc
"reward": {
  "trinketTheme": {
    "themes":     ["bone", "predator", "wolf"],   // theme pool
    "flavorTags": ["primal", "savage"],           // adjectives for naming
    "visualHint": "ivory"                          // material/colour hint for prefab gen
  },
  "extras": [
    { "kind": "lore",  "id": "lore_wolf_pack_drift", "chance": 0.3 },
    { "kind": "stack", "id": "wolf_pelt",            "qty":    2  },
    { "kind": "stack", "id": "raw_meat",             "qty":    1, "chance": 0.6 }
  ]
}
```

When the generator wires the DAG, for each gated POI it picks the trinket
theme by intersecting `source.reward.trinketTheme.themes` with
`dest.gate.flavorAccept`. The resulting trinket's procedural display name
comes from:

```
{themeNoun}{ joiner }{ flavorAdj }{ joiner }{ sourcePoi.displayName }
   "Bone"   "of the"   "Savage"      —          "Wolf Den"
   →  "Bone of the Savage Wolf Den"
```

The actual naming function lives in the generator; designers tune the
inputs by listing themes/flavors here.

### Extras

`extras` are additional drops on top of the gating trinket. Used for
flavor (lore fragments) and economy (materials). They are **not** keys —
they cannot satisfy gates. Optional `chance` field (default 1.0).

---

## 7. `roles` — Legal DAG Positions

Each POI declares which positions it can occupy in the dependency DAG:

| role         | meaning                                                       |
|--------------|---------------------------------------------------------------|
| `entry`      | may be an entry POI (open gate, generator picks at least one) |
| `midchain`   | may be in the middle of a dependency chain                    |
| `terminal`   | may be the final boss / final POI of the tile                 |
| `optional`   | may be a side-POI not on the critical path                    |

A POI usually declares 2-3 roles. `["entry"]` only = always an opener.
`["terminal"]` only = always the apex, never a stepping stone. `[]` =
generator skips this POI for this tile (used to disable a POI without
deleting its file).

---

## 8. Generation Contract

What the **POI-network generator** (Tier 6 in the pipeline) does with this
schema, given as input:

- **Pool** of POI definitions (this folder's contents, filtered by
  matching biome / world-region quotas)
- **AnnotatedZoneGraph** of the target tile (Tier 3 output)
- **Tile metadata**: lifecycle phase, difficulty tier, target DAG shape
  (linear / branching / diamond / lattice — chosen by Tile macro)

Output (one TileNarrative artifact):

```typescript
interface PoiInstance {
  poiDefId:  string;          // ref into this content category
  zoneId:    ZoneId;          // which AnnotatedZone hosts it
  gate:      ResolvedGate;    // gate.trinketRef now filled in
  trinketId: TrinketId;       // the trinket this POI drops
}
interface TrinketInstance {
  id:          TrinketId;
  sourcePoi:   PoiInstanceId;
  destPoi:     PoiInstanceId | null;  // null for terminal trinkets
  themes:      string[];
  displayName: string;
}
interface TileNarrative {
  pois:     PoiInstance[];
  trinkets: TrinketInstance[];
  dagShape: "linear" | "branching" | "diamond" | "lattice";
  entryPoiIds:    PoiInstanceId[];
  terminalPoiIds: PoiInstanceId[];
}
```

The generator guarantees:

- Every non-entry POI's gate has a valid `trinketRef` (no dead locks).
- Every POI is reachable from at least one entry.
- DAG is acyclic (no key behind its own lock).
- Trinket themes meaningfully overlap on every edge (no random pairings).
- Output is **deterministic** under the tile's split-seed.

If the matching fails (no POIs fit the zones, or the constraint solver
can't build a valid DAG), the generator **retries with a bumped sub-seed**
up to a bounded number of attempts. The retry count is baked into the
tile save so reload is reproducible.

---

## 9. Designer Workflow

Adding a new POI:

1. Drop a new `{id}.json` file in this folder.
2. Fill out the schema. Run validation via `deno task content-check`
   (validates structure but not gameplay balance).
3. Restart atlas. Generator picks the new POI up on next tile bake.
4. Inspect a baked tile in atlas; trace the DAG.

Removing or disabling:

- Set `roles: []` to keep the file as documentation but exclude it
  from generation.
- Delete the file to permanently remove (save files won't break — POI
  instances reference IDs; missing IDs become "ruined POI" placeholders).

---

## 10. What this Schema Doesn't Do

Out of scope for v1, intentional:

- **Authored questlines** — no field for "this POI is part of the
  Goldcrown Storyline". Questline emerges from DAG shape, not authoring.
- **Cross-tile dependencies** — every trinket is tile-local. World-level
  arcs (claim N tiles, defeat N corruption sources) are a separate
  macro-layer above this.
- **Dynamic content (LLM-generated names)** — naming is procedural from
  fixed inputs. An LLM-flavor pass can layer on top later without
  schema changes.
- **State / stat / env gates** — only item-based gates in v1.
- **POI sub-stages** — a POI is one activity. Multi-step content lives
  as multiple chained POIs.
- **Author-pinned DAG shapes per tile** — tile macro picks the shape
  globally; no per-tile overrides in v1.

Each of these is a deliberate not-yet — the schema is shaped so they can
slot in later without rewriting authored POI files.
