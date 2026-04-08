# Refactor: Entity Templates (Prefabs)

## Goal

Introduce `EntityTemplate` as a prefab-style concept that owns model identity,
hitbox, and optional component data. Replace the current pattern where
`ResourceNodeTemplate` owns `modelTemplateId` — the model should belong to the
entity, not to its harvest behaviour.

**Before:**
```
ResourceNodeTemplate { id, modelTemplateId, hitPoints, yields, ... }
```

**After:**
```
EntityTemplate {
  id: "tree_oak_harvestable",
  modelId: "tree_oak",
  components: {
    resourceNode: { hitPoints, yields, requiredToolType, respawnTicks }
  }
}
```

Tile layout and biome spawn profiles reference `entityTemplateId` instead of
`nodeTypeId`. `ResourceNodeTemplate` is eliminated entirely.

---

## Rules for Claude

1. **No cutting corners.** Every step must be fully implemented — no stubs, no
   `// TODO` left in the code.
2. **Do not deprecate — delete.** If old code is replaced, remove it completely.
   No dead fields, no unused imports, no commented-out entries.
3. **No shared responsibility.** When `EntityTemplate` takes over, nothing about
   models or hitboxes remains on any other template type.
4. **Stop and ask** if anything is ambiguous before guessing. Do not invent
   field names or behaviours not described here.
5. **Type-check after every commit:**
   `deno check packages/tile-server/mod.ts packages/client/src/game.ts packages/codecs/mod.ts packages/content/mod.ts`
6. **Commit after each logical step.** Commits are listed below; do not
   combine them unless noted.

---

## Decisions

**Q: Does `ResourceNodeTemplate` survive?**
No. Eliminated entirely. All harvest fields move into
`EntityTemplate.components.resourceNode`. The type is deleted from `types.ts`
and from `mod.ts`.

**Q: How does `ResourceNodeHitHandler` look up yields/respawn after the refactor?**
`rn.nodeTypeId` stays on the `ResourceNode` component (it is the entity
template id). Handlers call `content.getEntityTemplate(rn.nodeTypeId)` and read
`.components.resourceNode`. Field names are unchanged so handler body is
minimally affected.

**Q: What happens to `ZoneSpawnProfile.nodeWeights`?**
Renamed to `entityWeights`. Key strings stay identical to current `nodeTypeId`
values because `EntityTemplate.id` values are set to match the old
`ResourceNodeTemplate.id` values exactly.

**Q: Is `spawnNode` renamed to `spawnEntity`? Is it generic?**
Yes. Renamed `spawnEntity`. It always writes `ModelRef` and derives `Hitbox`
from `template.modelId`. It writes `ResourceNode` only when
`template.components.resourceNode` is present. Future component types can be
added without changing the function signature.

---

## New Types

### `packages/content/src/types.ts`

Add these interfaces. Delete `ResourceNodeTemplate`.

```typescript
/** Harvest/resource-node behaviour data. Lives inside EntityTemplate.components. */
export interface EntityTemplateResourceNodeData {
  /**
   * Stored on the ResourceNode component as nodeTypeId so handlers can look up
   * this template again via content.getEntityTemplate(nodeTypeId).
   * Must equal the parent EntityTemplate.id.
   */
  hitPoints: number;
  yields: ResourceNodeYield[];
  requiredToolType: string | null;
  respawnTicks: number | null;
}

/** Component data declared by an entity template. Extend as new component types are added. */
export interface EntityTemplateComponents {
  resourceNode?: EntityTemplateResourceNodeData;
}

/**
 * EntityTemplate — prefab-style definition of a spawnable world entity.
 *
 * Owns: which model to render (and derive hitbox from) and which optional
 * behavioural components are attached at spawn.
 *
 * The ECS entity created from a template will always have:
 *   Position, ModelRef, Hitbox (derived from modelId sub-objects)
 * And conditionally:
 *   ResourceNode   when components.resourceNode is present
 *   (future: NpcTag, Blueprint, etc.)
 */
export interface EntityTemplate {
  id: string;
  modelId: string;
  components: EntityTemplateComponents;
}
```

Remove from `types.ts`:
- `ResourceNodeTemplate` interface
- The `BodyPartVolume[]` import from the `hitbox?` field that was removed in the
  previous refactor (check that no orphaned imports remain).

Update `TileNodeConfig`:
```typescript
export interface TileNodeConfig {
  entityTemplateId: string;  // was: nodeTypeId
  x: number;
  y: number;
}
```

### `packages/content/mod.ts`

- Export `EntityTemplate`, `EntityTemplateComponents`, `EntityTemplateResourceNodeData`
- Remove export of `ResourceNodeTemplate`

---

## New Data File

### `packages/content/data/entity_templates.json`

Create this file. Delete `packages/content/data/resource_nodes.json`.

```json
[
  {
    "id": "tree",
    "modelId": "tree_oak",
    "components": {
      "resourceNode": {
        "hitPoints": 5,
        "requiredToolType": "axe",
        "yields": [{ "itemType": "wood", "quantity": 3, "quantityPerHarvestPower": 1 }],
        "respawnTicks": 12000
      }
    }
  },
  {
    "id": "stone_deposit",
    "modelId": "model_rock_small",
    "components": {
      "resourceNode": {
        "hitPoints": 8,
        "requiredToolType": "pickaxe",
        "yields": [{ "itemType": "stone", "quantity": 4, "quantityPerHarvestPower": 1 }],
        "respawnTicks": 18000
      }
    }
  },
  {
    "id": "iron_ore_vein",
    "modelId": "model_rock_large",
    "components": {
      "resourceNode": {
        "hitPoints": 12,
        "requiredToolType": "pickaxe",
        "yields": [
          { "itemType": "iron_ore", "quantity": 2, "quantityPerHarvestPower": 1 },
          { "itemType": "stone", "quantity": 1 }
        ],
        "respawnTicks": 36000
      }
    }
  },
  {
    "id": "bush",
    "modelId": "model_bush",
    "components": {
      "resourceNode": {
        "hitPoints": 2,
        "requiredToolType": null,
        "yields": [{ "itemType": "raw_meat", "quantity": 1 }],
        "respawnTicks": 6000
      }
    }
  },
  {
    "id": "pine_tree",
    "modelId": "model_pine_tree",
    "components": {
      "resourceNode": {
        "hitPoints": 4,
        "requiredToolType": "axe",
        "yields": [{ "itemType": "wood", "quantity": 2, "quantityPerHarvestPower": 1 }],
        "respawnTicks": 14400
      }
    }
  },
  {
    "id": "rock_small",
    "modelId": "model_rock_small",
    "components": {
      "resourceNode": {
        "hitPoints": 3,
        "requiredToolType": "pickaxe",
        "yields": [{ "itemType": "stone", "quantity": 2, "quantityPerHarvestPower": 1 }],
        "respawnTicks": 12000
      }
    }
  },
  {
    "id": "rock_large",
    "modelId": "model_rock_large",
    "components": {
      "resourceNode": {
        "hitPoints": 10,
        "requiredToolType": "pickaxe",
        "yields": [
          { "itemType": "stone", "quantity": 5, "quantityPerHarvestPower": 1 },
          { "itemType": "iron_ore", "quantity": 1 }
        ],
        "respawnTicks": 28800
      }
    }
  },
  {
    "id": "flower_patch",
    "modelId": "model_flower_patch",
    "components": {
      "resourceNode": {
        "hitPoints": 1,
        "requiredToolType": null,
        "yields": [],
        "respawnTicks": 3600
      }
    }
  }
]
```

---

## ContentStore Changes

### `packages/content/src/store.ts`

Replace `nodeTemplates` map and all associated methods:

**Remove:**
```typescript
private nodeTemplates = new Map<string, ResourceNodeTemplate>();
registerNodeTemplate(template: ResourceNodeTemplate): void
getNodeTemplate(id: string): ResourceNodeTemplate | null
getAllNodeTemplates(): readonly ResourceNodeTemplate[]
```

**Add:**
```typescript
private entityTemplates = new Map<string, EntityTemplate>();
registerEntityTemplate(template: EntityTemplate): void
getEntityTemplate(id: string): EntityTemplate | null
getAllEntityTemplates(): readonly EntityTemplate[]
```

Update `ContentStore` interface to match.

### `packages/content/src/loader.ts`

- Replace `readJson(dataDir, "resource_nodes.json")` with
  `readJson(dataDir, "entity_templates.json")`
- Replace destructured `nodeTemplatesRaw` with `entityTemplatesRaw`
- Replace `store.registerNodeTemplate(raw)` loop with
  `store.registerEntityTemplate(raw)`
- Remove `ResourceNodeTemplate` import

---

## World Package Changes

### `packages/world/src/zones.ts`

Rename `nodeWeights` to `entityWeights` in `ZoneSpawnProfile` interface and in
all `ZONE_PROFILES` entries. Key strings are unchanged (they already match the
`EntityTemplate.id` values set in `entity_templates.json`).

---

## Tile Layout Changes

### `packages/content/data/tile_layout.json`

Rename `nodeTypeId` → `entityTemplateId` in every entry of the `nodes` array.

---

## Spawner Changes

### `packages/tile-server/src/spawner.ts`

Rename `SpawnNodeOpts` to `SpawnEntityOpts`. Replace `ResourceNodeTemplate`
with `EntityTemplate`. Rename `spawnNode` to `spawnEntity`.

**`SpawnEntityOpts`:**
```typescript
export interface SpawnEntityOpts {
  x?: number;
  y?: number;
  z?: number;
  template: EntityTemplate;
  seed?: number;
}
```

**`spawnEntity` body:**
```typescript
export function spawnEntity(
  world: World,
  content: ContentStore,
  opts: SpawnEntityOpts,
): EntityId {
  const id = newEntityId();
  const x = opts.x ?? 256;
  const y = opts.y ?? 256;
  const seed = opts.seed ?? 0;

  world.create(id);
  world.write(id, Position, { x, y, z: opts.z ?? 4.0 });

  // ModelRef + Hitbox always present
  world.write(id, ModelRef, {
    modelId: opts.template.modelId,
    scaleX: ENTITY_SCALE, scaleY: ENTITY_SCALE, scaleZ: ENTITY_SCALE,
    seed,
  });
  const parts = deriveHitboxParts(opts.template.modelId, seed, content, ENTITY_SCALE);
  if (parts.length > 0) world.write(id, Hitbox, { parts });

  // Conditional components
  const rn = opts.template.components.resourceNode;
  if (rn) {
    world.write(id, ResourceNode, {
      nodeTypeId: opts.template.id,  // used by handlers to look up this template
      hitPoints: rn.hitPoints,
      depleted: false,
      respawnTicksRemaining: null,
    });
  }

  return id;
}
```

Rename `NODE_SCALE` to `ENTITY_SCALE` (same value: 0.35).

Update imports: remove `ResourceNodeTemplate`, add `EntityTemplate`.

---

## Handler + System Changes

### `packages/tile-server/src/handlers/resource_node_hit_handler.ts`

Change the template lookup:
```typescript
// Before:
const template = this.content.getNodeTemplate(rn.nodeTypeId);
const hitDamage = toolMatches ? harvestPower : 1;

// After:
const entityTemplate = this.content.getEntityTemplate(rn.nodeTypeId);
const rnData = entityTemplate?.components.resourceNode;
```

Replace all references to `template?.requiredToolType`, `template?.yields`,
`template?.respawnTicks` with `rnData?.requiredToolType`, `rnData?.yields`,
`rnData?.respawnTicks`.

The `spawnYields` call and `NodeDepleted` event are unchanged.

### `packages/tile-server/src/systems/resource_node_system.ts`

Same lookup change:
```typescript
// Before:
const template = this.content.getNodeTemplate(rn.nodeTypeId);
// After:
const entityTemplate = this.content.getEntityTemplate(rn.nodeTypeId);
const template = entityTemplate?.components.resourceNode;
```

The rest of the respawn logic is unchanged.

### `packages/tile-server/src/components/resource_node.ts`

Update the comment on `nodeTypeId`:
```typescript
/** References EntityTemplate.id — used to look up harvest data at runtime. */
nodeTypeId: string;
```

---

## Server Changes

### `packages/tile-server/src/server.ts`

**Startup log line** — replace:
```typescript
`${content.getAllNodeTemplates().length} node types,`
// with:
`${content.getAllEntityTemplates().length} entity templates,`
```

**Save/load snapshot type** — the inline type used for saved node data:
```typescript
// Before (line ~564):
nodeTypeId: string;
// This field name stays the same — it lives on the ResourceNode component
// which is unchanged. No edit needed here unless the surrounding snapshot
// type references ResourceNodeTemplate by name.
```
Check the save/load code carefully. If it references `ResourceNodeTemplate` by
name anywhere, update to `EntityTemplate`. If it only uses the `ResourceNode`
component data (which has `nodeTypeId` string), no change is needed.

**Tile layout spawn loop** — replace:
```typescript
// Before:
const template = content.getNodeTemplate(node.nodeTypeId);
if (!template) continue;
const nodeSeed = positionSeed(node.x, node.y);
spawnNode(this.world, this.content, { x: node.x, y: node.y, template, seed: nodeSeed });

// After:
const template = content.getEntityTemplate(node.entityTemplateId);
if (!template) continue;
const nodeSeed = positionSeed(node.x, node.y);
spawnEntity(this.world, this.content, { x: node.x, y: node.y, template, seed: nodeSeed });
```

**Procedural generation loop** — replace:
```typescript
// Before:
const totalWeight = Object.values(profile.nodeWeights).reduce((s, w) => s + w, 0);
...
const nodeTypeId = weightedPick(profile.nodeWeights, rng);
if (!nodeTypeId) continue;
const template = content.getNodeTemplate(nodeTypeId);
if (!template) continue;
spawnNode(this.world, this.content, { x: wx, y: wy, z: ..., template, seed: ... });

// After:
const totalWeight = Object.values(profile.entityWeights).reduce((s, w) => s + w, 0);
...
const entityTemplateId = weightedPick(profile.entityWeights, rng);
if (!entityTemplateId) continue;
const template = content.getEntityTemplate(entityTemplateId);
if (!template) continue;
spawnEntity(this.world, this.content, { x: wx, y: wy, z: ..., template, seed: ... });
```

Update imports: remove `spawnNode`, add `spawnEntity`. Remove any
`ResourceNodeTemplate` imports.

---

## Commit Sequence

Each commit must leave all four `deno check` targets passing.

### Commit 1 — `content: replace ResourceNodeTemplate with EntityTemplate`

Files changed:
- `packages/content/src/types.ts` — add `EntityTemplate*` types, delete `ResourceNodeTemplate`, rename `TileNodeConfig.nodeTypeId` → `entityTemplateId`
- `packages/content/src/store.ts` — replace nodeTemplates map + methods with entityTemplates
- `packages/content/src/loader.ts` — load `entity_templates.json`, call `registerEntityTemplate`
- `packages/content/mod.ts` — swap exported type names
- `packages/content/data/entity_templates.json` — create (8 entries)
- `packages/content/data/resource_nodes.json` — delete
- `packages/content/data/tile_layout.json` — rename `nodeTypeId` → `entityTemplateId`

After this commit `deno check packages/content/mod.ts` must pass.
`tile-server` will fail until commit 2 — that is acceptable because the check
command runs all targets at once only at the end of each commit, but if running
incrementally, content alone must be clean.

### Commit 2 — `world: rename nodeWeights to entityWeights in ZoneSpawnProfile`

Files changed:
- `packages/world/src/zones.ts` — rename field in interface and all ZONE_PROFILES entries

### Commit 3 — `tile-server: replace spawnNode with spawnEntity; update all consumers`

Files changed:
- `packages/tile-server/src/spawner.ts` — rename opts/function, use EntityTemplate
- `packages/tile-server/src/handlers/resource_node_hit_handler.ts` — update lookup
- `packages/tile-server/src/systems/resource_node_system.ts` — update lookup
- `packages/tile-server/src/components/resource_node.ts` — update comment
- `packages/tile-server/src/server.ts` — update all call sites, log line, imports

After this commit all four `deno check` targets must pass.

---

## What Does NOT Change

- `ResourceNode` ECS component definition, codec, or wire ID
- `ResourceNodeHitHandler` logic beyond the template lookup line
- `ResourceNodeSystem` logic beyond the template lookup line
- `deriveHitboxParts` function
- Wire protocol / component IDs
- NPC spawning path (`spawnNpc`, `NpcTemplate`, `NpcAiSystem`)
- Client code — no changes needed client-side
