# Prefab System Plan — Engine / Simulation Separation

## Goal

Make `@voxim/engine` a true runtime. The engine provides a set of **component
types** and **systems** that operate over them. Everything that has a name in
the world — anvils, wolves, torches, hearths, workstations, signposts — is
declared as **data** (a prefab) referencing components by name. The spawner
walks the data and attaches components.

Two invariants this commits us to:

1. **Adding a new kind of thing is a data change, not a code change.** Drop a
   JSON file in `data/prefabs/`; it spawns, participates in systems, is hit,
   is saved, is replicated — with no TypeScript edits.
2. **Adding a new mechanic is a code change, not a data change.** Define a new
   component, write a system that reads/writes it, wire the system into the
   tick loop. Existing prefabs acquire the capability when they declare the
   component; they don't need awareness of the new system's existence.

The interface between the two is the **component registry** — a map from
component name to `ComponentDef`. Everything flows through it.

---

## Principles

1. **One prefab primitive, open-set.** `Prefab.components` is a
   `Record<string, unknown>` — keyed by component name, value is the
   component's data. No closed-set TypeScript type enumerates which components
   a prefab may have. New components do not require prefab-type edits.

2. **Schemas are the shape contract.** Every `ComponentDef` carries a
   `valibot` schema describing its data shape. The schema is the single source
   of truth for structure; TypeScript types are inferred from it; content
   validation runs the schema; editors derive their UI from it; codecs agree
   with it via round-trip tests.

3. **Wire codec stays hand-written (for now).** The codec describes *bytes*,
   the schema describes *structure*. They describe the same data but serve
   different consumers. Codec derivation from schema is a future optimization
   — not on the critical path for this plan. The invariant enforced here is:
   **codec and schema round-trip agree** (property-tested).

4. **Spawn-time derivation lives in component data.** Components whose data
   can be auto-populated from other entity state (e.g. Hitbox from ModelRef +
   skeleton) carry a `derive: boolean` field in their own data. The relevant
   system reads the flag to decide whether to update each tick. No separate
   "derive hook" machinery on ComponentDef.

5. **Fail loud at content-load, not at spawn.** Missing required components,
   unknown component names in prefabs, circular inheritance, schema
   violations — all errors raised at `loadContentStore()`. A server that
   boots cannot encounter these at runtime.

6. **Clean replacement, no deprecation.** Each phase deletes the replaced
   code, fields, JSON shapes in the same commit. No:
   - Legacy accepts in loaders
   - Deprecation flags
   - "Classic" vs "prefab" modes
   - Orphaned types, dead imports

7. **No backwards compatibility constraint.** Data breaking is acceptable at
   this stage — saves, heritage files, wire protocol can all break between
   phases. Users relog; worlds regenerate from seed. This decision simplifies
   codec / schema co-evolution considerably.

---

## Universal acceptance criteria (every phase)

After each phase commit:
- `deno check packages/tile-server/mod.ts packages/client/src/game.ts
  packages/codecs/mod.ts packages/content/mod.ts packages/gateway/mod.ts`
  passes.
- `grep -rn "<deleted-identifier>" packages/` returns zero hits for every
  symbol the phase removes.
- Observable gameplay is identical to pre-phase (except where the phase
  explicitly unlocks new content — e.g. Phase 3's workbench variants).
- Phase-specific deletion list (below) is fully executed.

---

## Phase 0 — Schema substrate + component registry

**Ships:** `valibot` dependency, schemas on a handful of core components, a
`Map<name, ComponentDef>` registry, round-trip property tests that validate
schema / codec agreement.

Nothing user-visible changes. This phase establishes the machinery that every
subsequent phase consumes.

### Changes

- Add `valibot` (jsr:`@valibot/valibot`) to the root `deno.json` imports.
- `ComponentDef` gains an optional `schema?: v.BaseSchema<unknown, unknown>`
  field. Existing components that don't declare one keep working; new and
  touched components declare one.
- Pick five pilot components and add schemas with inferred types:
  - `Health`, `Stamina`, `Hunger`, `Thirst` — simple primitive structs,
    prove the shape.
  - `Workbench` (currently `WorkstationTag`) — will be central to Phase 3.
- Extend the existing `NETWORKED_DEFS` array and `DEF_BY_TYPE_ID` map to
  also produce `DEF_BY_NAME: Map<string, ComponentDef>`. Every engine
  code path that currently looks up a component by `wireId` can also look
  up by string name — needed by the prefab loader in Phase 1.
- Add a round-trip property test for each schemaed component: generate N
  arbitrary valid instances → encode via codec → decode → `v.parse` the
  result against the schema → assert deep-equal with the generated value.
  Uses `fast-check` + valibot's arbitrary generation.

### Deletion list

Nothing. This phase is purely additive.

### Acceptance

- `deno test packages/tile-server/ --filter prefab` runs and the round-trip
  tests pass for the five pilot components.
- `DEF_BY_NAME.get("health")` returns the `Health` def.
- No runtime behavior change.

---

## Phase 1 — Universal prefab format + `spawnPrefab`

**Ships:** A single `spawnPrefab(world, prefabId, overrides?)` function that
is the only entry point for entity creation. Existing template JSON files
migrated to open-set prefab format. The per-type spawn functions
(`spawnPlayer`, `spawnNpc`, `spawnEntity`, etc.) and the `INSTALLERS` map
are deleted.

### Changes

- New content layout: `data/prefabs/*.json`. Existing `data/templates/*.json`
  are migrated (mechanical rewrite) and the `templates/` folder is deleted.
  Migration script at `scripts/migrate_templates_to_prefabs.ts` one-shot,
  deleted after use.

  Old format:
  ```json
  {
    "id": "wolf",
    "modelId": "wolf",
    "modelScale": 1,
    "components": {
      "npc": { "npcType": "wolf" }
    }
  }
  ```

  New format:
  ```json
  {
    "id": "wolf",
    "components": {
      "ModelRef": { "modelId": "wolf", "scale": 0.35 },
      "Npc":      { "npcType": "wolf" },
      "Health":   { "current": 80, "max": 80 }
    }
  }
  ```

  Component names are PascalCase matching the `ComponentDef.name` field
  (which is currently camelCase — one grep-sweep rename in this phase).

- `Prefab` content type in `@voxim/content`:
  ```ts
  interface Prefab {
    id: string;
    components: Record<string, unknown>;  // validated at load
    extends?: string;                     // Phase 2, not yet
  }
  ```
  The `unknown` is TypeScript's acknowledgment that this is open-set. At
  load time each entry is validated against its component's schema; after
  validation the runtime knows the data is correct shape.

- Loader: for each prefab file, for each `(componentName, rawData)` entry:
  1. Look up `ComponentDef` in `DEF_BY_NAME`. Unknown name → fail loud.
  2. Deep-merge `rawData` over `componentDef.default()` to fill omitted
     fields.
  3. If `componentDef.schema` exists, `v.parse(schema, merged)`. Fail loud
     on schema violation.
  4. Store the normalized data in-memory.

- New engine function in `@voxim/tile-server` (or promoted to `@voxim/content`
  since it's pure data→components):
  ```ts
  function spawnPrefab(
    world: World,
    content: ContentStore,
    prefabId: string,
    overrides?: { position?: PositionData; id?: EntityId; /* etc. */ },
  ): EntityId
  ```
  Implementation:
  ```ts
  const prefab = content.getPrefab(prefabId);
  const id = overrides?.id ?? newEntityId();
  world.create(id);
  for (const [name, data] of Object.entries(prefab.components)) {
    const def = DEF_BY_NAME.get(name)!;  // validated at load
    world.write(id, def, data);
  }
  // apply overrides (position, dynasty-specific fields, etc.)
  return id;
  ```

- Callers migrated: `TileServer.handleSession` calls `spawnPrefab("player",
  { id: userId, position: {...} })` instead of `spawnPlayer(...)`.
  `ProceduralSpawner` calls `spawnPrefab(templateId, { position: {...} })`
  instead of `spawnEntity(template)`. Building system calls
  `spawnPrefab(blueprintId, ...)`.

### Deletion list

- `spawnPlayer`, `spawnNpc`, `spawnEntity`, `spawnWorkstation`,
  `spawnBlueprint`, `spawnProp` — all deleted.
- `SpawnPlayerOpts`, `SpawnNpcOpts`, `SpawnEntityOpts`, etc. — deleted.
- `EntityTemplateComponents` closed-set TypeScript interface — deleted.
- `INSTALLERS` map in `spawner.ts` — deleted.
- `EntityTemplate` type — renamed to `Prefab` (one grep sweep).
- `data/templates/` folder — renamed to `data/prefabs/` and contents
  rewritten.
- The various per-entity-type dispatch branches in what's left of
  `spawner.ts` — deleted.

After this phase, `packages/tile-server/src/spawner.ts` is either gone or
shrunk to a single ~50-line `spawnPrefab` function with the common
housekeeping (ID generation, overrides application).

### Acceptance

- `grep -rn "spawnPlayer\|spawnNpc\|spawnEntity\|INSTALLERS\|EntityTemplate"
  packages/` returns no hits in code (historical comments allowed).
- All existing spawns work identically from the player's perspective.
- Adding a new prefab by dropping one JSON file in `data/prefabs/` and
  referencing it in `tile_layout.json` causes the entity to spawn — with
  zero TypeScript edits required.

---

## Phase 2 — Prefab inheritance + component `requires`

**Ships:** `extends: "parent-id"` for prefab inheritance with deep-merge
semantics. `requires: string[]` on `ComponentDef` enforcing inter-component
constraints at content-load. Enables the workbench family (`base_workbench`
→ `anvil`, `furnace`, `hearth`, `job_board`) with minimal per-variant data.

### Changes

- `Prefab.extends?: string` field. At load:
  1. Resolve parent recursively, detecting cycles → fail loud.
  2. Start with `effective = { components: {} }`.
  3. Walk ancestry root-to-leaf, at each level deep-merging
     `components`. Arrays are *replaced* by default (not concatenated);
     nested objects are recursively merged.
  4. Validate the resulting effective prefab as in Phase 1.

- `ComponentDef.requires?: readonly string[]`. Loader checks: for every
  component present in the effective prefab, every name in its `requires`
  list must also be present. Fail loud with a clear message ("prefab X
  declares Workbench, which requires WorkbenchBuffer, which is missing").

- Example workbench family (illustrative content):
  ```json
  // data/prefabs/_workbench_base.json
  { "id": "_workbench_base",
    "components": {
      "Workbench":        { "workbenchType": "",  "capacity": 4 },
      "WorkbenchBuffer":  { "slots": [] },
      "Hitbox":           { "derive": true, "parts": [] }
    }
  }

  // data/prefabs/anvil.json
  { "id": "anvil",
    "extends": "_workbench_base",
    "components": {
      "Workbench":    { "workbenchType": "anvil" },
      "ModelRef":     { "modelId": "anvil", "scale": 0.35 },
      "LightEmitter": { "color": 16755268, "intensity": 0.4, "radius": 3 }
    }
  }

  // data/prefabs/hearth.json
  { "id": "hearth",
    "extends": "_workbench_base",
    "components": {
      "Workbench":    { "workbenchType": "hearth" },
      "ModelRef":     { "modelId": "hearth" },
      "Hearth":       { "claimRadius": 20 },
      "LightEmitter": { "color": 16755268, "intensity": 1.2, "radius": 10,
                        "flicker": 0.3 }
    }
  }
  ```

- Prefab IDs starting with `_` are "abstract" — they fail a check that
  prevents them being passed to `spawnPrefab` directly. They're inheritance
  anchors only.

### Deletion list

- Any duplicated component declarations across the anvil / furnace / hearth
  prefab files that can be hoisted to `_workbench_base`.
- The old hand-written ordering of components in spawn functions (already
  gone after Phase 1, but now formally enforced by `requires`).

### Acceptance

- `grep -rn "_workbench_base\|extends" packages/content/` shows the
  inheritance hierarchy in effect.
- Creating a new workbench variant requires adding only the delta (model,
  workbenchType, optional lights) — not the full component list.
- A prefab declaring `Workbench` without `WorkbenchBuffer` fails at server
  startup with a clear `requires` error.

---

## Phase 3 — Derive flags in component data

**Ships:** Spawn-time auto-population of components is a pure-data pattern.
`Hitbox` gains `derive: boolean` + `parts: HitboxPart[]`; `HitboxSystem`
reads the flag to decide whether to update. Any other component that can be
derived (future: some IK target, some AI default) follows the same pattern.

### Changes

- `Hitbox` schema and component shape:
  ```ts
  interface HitboxData {
    /** If true, HitboxSystem repopulates `parts` from ModelRef + skeleton each tick. */
    derive: boolean;
    /** Live hit geometry — either derived or hand-authored. Always present. */
    parts: HitboxPart[];
  }
  ```
  Default: `{ derive: true, parts: [] }`. Prefabs that want a static
  hand-authored hitbox declare `{ derive: false, parts: [...] }`.

- `HitboxSystem.run()` filters to entities where `hitbox.derive === true`
  before running the skeleton → parts derivation. Static hitboxes are
  written once at spawn (from the prefab's literal `parts` array) and
  never touched again.

- Spawner's special-case for static entities (the "if no model, use
  static hitbox" branch that currently exists in spawnEntity / installers)
  is deleted — the prefab declares its shape directly.

- The underlying derivation code (`applyHitboxTemplate`, skeleton solve)
  is untouched; only its trigger moves.

### Deletion list

- Any branch in spawner/INSTALLERS that computes hitbox conditionally —
  gone after Phase 1 anyway; this phase makes sure no residual
  `if (hitbox-should-be-derived)` logic exists in spawn code.
- Any hand-coded static hitbox assignment for trees / resource nodes /
  props — moved into the relevant prefab JSON files.

### Acceptance

- `grep -rn "derive.*hitbox\|hitbox.*derive" packages/` shows the flag
  read only by `HitboxSystem`. Nothing else inspects it.
- Trees / resource nodes use `{ derive: false, parts: [{...}] }` in
  their prefabs; hit detection on them is identical to pre-phase.
- Animated entities use `{ derive: true }` (or omit, picking up the
  default); hit detection on them is identical to pre-phase.

---

## Phase 4 — Content type convergence

**Ships:** `ItemTemplate` and `StructureDef` either merge into prefabs or
reduce to thin pointers. The "five overlapping types describing the same
anvil" situation collapses. After this phase, the only content types
describing world objects are `Prefab` and `ItemTemplate` (the latter
describing purely inventory-side data).

This phase has the widest blast radius and should be taken last.

### Changes

- `ItemTemplate` keeps: `id`, `name`, `baseStats` (damage, weight, tool
  type, etc.), `materialSlots` (for voxel composition), `displayName`.
  Loses nothing — these are inventory-level concerns.

- `ItemTemplate` gains: `deploysTo?: string` — prefab id to spawn when
  the item is placed in the world. When a player "deploys" an anvil
  item, the code reads `deploysTo: "anvil"` and calls `spawnPrefab("anvil",
  { position: ... })`.

- `StructureDef`: deleted as a top-level content type. Its parameters
  (totalTicks, materialCost, heightDelta, materialId) become a `Blueprint`
  component inside the relevant deployment prefab. Example:

  ```json
  // data/prefabs/wall_blueprint.json
  { "id": "wall_blueprint",
    "components": {
      "Blueprint": { "structureType": "wall", "totalTicks": 600,
                     "materialCost": [{ "itemType": "stone", "quantity": 10 }],
                     "heightDelta": 3, "materialId": 2 },
      "Hitbox":    { "derive": false, "parts": [ /* wall-shaped capsule */ ] }
    }
  }
  ```

  When the blueprint completes, the building system spawns the
  corresponding built structure by prefab id (configured on the blueprint
  component, or conventionally by id suffix).

- `tile_layout.json` entries reference prefabs by id (already do,
  post-Phase 1).

- Content folder cleanup:
  - `data/structures/` → deleted; contents moved to `data/prefabs/` as
    blueprint variants.
  - `data/templates/` → already renamed to `data/prefabs/` in Phase 1.

### Deletion list

- `StructureDef` type in `@voxim/content/src/types.ts`.
- `getStructureDef()` method on `ContentStore`.
- The special-case dispatch in `spawner.ts` / building system that
  read `StructureDef`.
- `data/structures/*.json` (replaced).
- The `TileEntityConfig` distinction between "entities", "npcs",
  "structures" in `tile_layout.json` — they all become prefab
  references with an optional position.

### Acceptance

- `grep -rn "StructureDef\|getStructureDef" packages/` returns zero hits.
- Building, deploying, and spawning a workbench all go through
  `spawnPrefab`.
- Tile layout still describes the same world; the JSON is smaller and
  more uniform.

---

## Deferred — not in this plan

- **Codec derivation from schema.** A future optimization once the schema
  layer is pervasive. Pre-requisites: wire-format annotations on schema
  fields (`f32` vs `f64`, string encoding, etc.), codegen or interpretive
  derivation. Captured in principle (3) above; tracked separately.

- **Hot reload.** A natural win once the content store is fully pure,
  but an independent concern from the prefab system's shape.

- **Editor tooling.** Once schemas exist everywhere, an external editor
  can read them and generate inspector UI. Separate project.

- **Macro layer / NPC cities / LLM-driven AI.** These are Phase 3-level
  SPEC work that sit on top of the engine; they aren't affected by this
  plan except that their future content will benefit from the prefab
  system.

---

## Commit structure

One commit per phase. Each commit:

1. Lands all schema / code / data changes for that phase atomically.
2. Passes all four `deno check` entry points.
3. Passes the round-trip property tests (Phase 0 onward).
4. Executes its deletion list fully (see per-phase sections).
5. Commit message follows the project's pattern: affected packages
   prefixed, concise rationale in the body.

Example commit title shapes:
- `content+engine: P0 — valibot schemas + component registry by name`
- `content+tile-server: P1 — universal spawnPrefab, open-set prefab format`
- `content: P2 — prefab inheritance + component requires`
- `content+tile-server: P3 — derive flags in component data`
- `content+tile-server: P4 — ItemTemplate.deploysTo + StructureDef collapse`

---

## Why this plan, not another

Two architectural values this plan is explicitly *not* trading against:

- **Performance.** Schema validation runs at content-load, not at runtime.
  Wire codecs stay dense and hand-tuned until the schema layer is proven.
  The hot path (tick loop, delta encoding, hit detection) is untouched.

- **Type safety where it matters.** The engine still has typed reads and
  writes against individual `ComponentDef`s. What becomes untyped is the
  `Prefab.components: Record<string, unknown>` — but that's only at the
  boundary between data and engine. Once the prefab loader has validated
  against schemas, everything downstream is typed through the component's
  inferred data type.

The trade being made is clear: loss of compile-time type safety on the
prefab-shape declaration in exchange for the ability to add new kinds of
world objects without engine code edits. Mature ECS engines all make this
trade for the same reason: it's the only way to separate engine from
simulation.

---

## When this plan lands

After this plan's phases are complete, the tile-server codebase satisfies
the engine/simulation split described at the top of this document. Every
subsequent expansion of the game's content surface — new workbenches, new
mobs, new props, new structures, new crafting stations — is a data-file
drop. Every subsequent expansion of engine capability — new components,
new systems, new mechanics — is a TypeScript-only change that existing
content transparently benefits from.

This is the architectural foundation the rest of the SPEC's vision
(living world, NPC cities, macro sim, dynasty library) will be built on.
Doing it now, before those systems exist, is considerably cheaper than
retrofitting later.
