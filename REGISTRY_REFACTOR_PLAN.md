# Registry Refactor Plan — Engine / Content Separation

## Goal

Move Voxim2 from ~60% data-driven to ~95% data-driven by unbolting hardcoded
string-dispatch from systems into registries. New effects, NPC behaviors, recipe
steps, biomes, zones, and job types become data files plus optional handler
files — never system-file edits.

This plan delivers **scaffolding only**. Minimal JSON is shipped per phase where
a system reads from data (operational defaults, not game-design content).
Content expansion is a separate, post-scaffold effort.

---

## Principles

1. **One universal pattern.** Copy the existing `HitHandler` design in
   `packages/tile-server/src/handlers/` everywhere a system switches on a
   content-defined string. Registry + Handler interface, registered at server
   startup.
2. **Clean replacement, no deprecation.** Every phase deletes the replaced
   code, fields, constants, and files in the same commit. No:
   - Deprecation comments or `@deprecated` markers
   - Feature flags toggling old vs new behavior
   - Loaders accepting "legacy shape OR new shape"
   - In-code default implementations duplicating data
   - Dead imports, orphaned types, empty directories
3. **Fail fast at startup, not at runtime.** Registry references in content
   are validated when ContentStore is built. Unknown handler id = server
   refuses to boot.
4. **Behavior-preserving.** Each phase produces identical observable gameplay.
   New content unlocks new behavior later.
5. **One commit per phase.** Each phase is independently reviewable,
   mergeable, and runnable.

---

## Universal acceptance criteria (every phase)

After the phase commit:
- `deno check packages/tile-server/mod.ts packages/client/src/game.ts
  packages/codecs/mod.ts packages/content/mod.ts` passes.
- `grep -rn "<old-identifier>" packages/` returns zero hits for every
  deleted symbol.
- Observable gameplay is identical to pre-phase.
- Phase-specific deletion list (below) is fully executed.

---

## Phase 0 — Foundation

Two independent sub-phases, can land in any order.

### P0.1 — Move hardcoded tuning constants to `game_config.json`

**Why first:** cheapest win, orthogonal to everything else, unblocks
rebalance-without-recompile forever.

**Changes:**
- Extend `data/game_config.json` with `crafting.*`, `consumption.*`,
  `animation.*`, `building.*` sub-objects, plus missing `npcAiDefaults.*`
  entries.
- Extend `GameConfig` type.
- Replace module-level `const` in system files with
  `content.getGameConfig().X.Y` lookups (cached in system constructor).

**Deletions:**
- `INTERACT_RANGE`, `INTERACT_COOLDOWN_TICKS`, `DEPLOY_OFFSET` in
  `systems/crafting.ts`
- `CONSUME_COOLDOWN_TICKS` in `systems/consumption.ts`
- `WAYPOINT_SPACING`, `WAYPOINT_ARRIVAL_SQ`, `DEFAULT_PLAN_EXPIRY`,
  `ATTACK_PLAN_EXPIRY`, `ATTACK_REPLAN_DIST_SQ`, `REPLAN_BUDGET` in
  `systems/npc_ai.ts`
- `WALK_THRESHOLD_SQ` in `systems/animation.ts`
- `MAX_REACH` in `systems/building.ts`

**Estimate:** 1–2 hrs.

### P0.2 — Generic `Registry<T>` helper

**New file:** `packages/engine/src/registry.ts`

```ts
export class Registry<H extends { id: string }> {
  private map = new Map<string, H>();

  register(handler: H): void {
    if (this.map.has(handler.id)) {
      throw new Error(`Registry: duplicate handler id "${handler.id}"`);
    }
    this.map.set(handler.id, handler);
  }

  get(id: string): H {
    const h = this.map.get(id);
    if (!h) throw new Error(`Registry: unknown handler id "${id}"`);
    return h;
  }

  has(id: string): boolean { return this.map.has(id); }
  ids(): string[] { return [...this.map.keys()]; }
}
```

Exported from `@voxim/engine`. Used by every subsequent phase. No behavior
change in this sub-phase.

**Estimate:** 30 min.

---

## Phase 1 — EffectRegistry

**Goal:** all skill/buff effect dispatch goes through registries. Adding a new
effect = one handler file + one `registry.register(...)` call.

### New files

- `packages/tile-server/src/effects/effect_handler.ts` — interfaces
- `packages/tile-server/src/effects/health_effect.ts` (instant heal + DoT/HoT)
- `packages/tile-server/src/effects/speed_effect.ts`
- `packages/tile-server/src/effects/damage_boost_effect.ts`
- `packages/tile-server/src/effects/flee_effect.ts`

### Interfaces

```ts
export interface EffectApplyHandler {
  readonly id: string; // matches ConceptVerbEntry.effectStat
  apply(ctx: EffectApplyContext): void;
}

export interface EffectTickHandler {
  readonly id: string;
  tick(ctx: EffectTickContext): void;
}

export interface EffectComposeHandler {
  readonly id: string;
  contribute(ctx: EffectComposeContext): EffectContribution;
}
```

Three registries (apply, tick, compose) — not every effect implements all
three; each runs in a different part of the tick.

### System changes

- `SkillSystem.resolve()` calls `effectApplyRegistry.get(entry.effectStat)
  .apply(ctx)`. No string branching.
- `BuffSystem` iterates `ActiveEffects`, calls tick handlers, then composes
  final `SpeedModifier` from contributions. The single-writer guarantee on
  `SpeedModifier` is preserved.
- `server.ts` registers the four handlers into the three registries.

### Content validation at startup

ContentStore validates that every `effectStat` referenced in
`concept_verb_matrix.json` corresponds to a registered handler. Mismatch
= fail fast.

### Deletions

- All `if (entry.effectStat === "...")` / `if (effect.effectStat === "...")`
  branches in `systems/skill.ts` and `systems/buff.ts`
- Imports that become unused (`NpcJobQueue`, `Position` in skill.ts if
  flee moves out; `Health` in buff.ts if health moves out)
- Literal type `effectStat: "health" | "speed" | "flee" | "damage_boost"` →
  becomes `string`, enforced by registry validation
- `CONSUME_ON_USE_SENTINEL` leaves SkillSystem/BuffSystem and lives only
  inside `damage_boost_effect.ts`

**Estimate:** 3–4 hrs.

---

## Phase 2 — DeathSystem

**Goal:** single place entities die. Enables future death hooks (drop tables,
heirs, corpses) as pure additions, no system-file edits.

### New files

- `packages/tile-server/src/systems/death.ts`
- `packages/tile-server/src/events/death.ts` (`RequestDeath` event type)

### Design

Systems publish `RequestDeath { entityId, killerId?, cause: "damage" |
"starvation" | "corruption" | "effect" }` instead of calling `world.destroy()`.

`DeathSystem` runs last in the tick chain (after `AnimationSystem`), consumes
the event queue, and:
1. Confirms entity still alive (dedupes multi-cause deaths in same tick).
2. Publishes `TileEvents.EntityDied` (consumed by AoI / clients).
3. Runs all registered `DeathHook`s (registry is empty today; later populated
   with drop-table, heir-spawn, corpse-spawn hooks).
4. Calls `world.destroy(entityId)`.

### System changes

- `handlers/health_hit_handler.ts` publishes `RequestDeath` instead of destroying.
- `systems/hunger.ts` — same.
- `systems/buff.ts` (DoT death path) — same.
- `systems/corruption.ts` — same.
- `server.ts` appends `DeathSystem` at the end of the system chain.

### Deletions

- Every `world.destroy(entityId)` call in systems/handlers except
  `DeathSystem` and spawner cleanup paths (session disconnect, entity
  lifetime expiry — these aren't deaths and stay direct).
- Every `events.publish(TileEvents.EntityDied, ...)` outside `DeathSystem`.

**Estimate:** 2–3 hrs.

---

## Phase 3 — JobHandler registry

**Goal:** break the `switch (job.type)` in `NpcAiSystem`. Each job type
becomes a handler. Prep for Phase 4's behavior trees, which will emit jobs
through the same registry.

### New files

- `packages/tile-server/src/ai/job_handler.ts` — interface
- `packages/tile-server/src/ai/jobs/idle.ts`
- `packages/tile-server/src/ai/jobs/wander.ts`
- `packages/tile-server/src/ai/jobs/seek_food.ts`
- `packages/tile-server/src/ai/jobs/seek_water.ts`
- `packages/tile-server/src/ai/jobs/flee.ts`
- `packages/tile-server/src/ai/jobs/attack_target.ts`

### Interface

```ts
export interface JobHandler {
  readonly id: string;  // matches Job.type in codec
  plan(ctx: JobPlanContext): JobPlan | null;
  tick(ctx: JobTickContext): JobTickResult; // "continue" | "done" | "abort"
  expiryTicks(cfg: NpcAiConfig): number;
}
```

### System changes

- `NpcAiSystem` holds a `JobHandlerRegistry`.
- Job dispatch becomes `jobHandlerRegistry.get(job.type).tick(ctx)`.
- Emergency priority cascade stays in `NpcAiSystem` for this phase — Phase 4
  moves it into BT form.

### Deletions

- All `switch (job.type)` / `if (job.type === ...)` in `systems/npc_ai.ts`.
- Inline job plan-construction helpers that move into handler files.

**Estimate:** 3–4 hrs.

---

## Phase 4 — BehaviorTree

**Goal:** NPC decision-making moves out of hardcoded priority cascade into a
data-driven BT evaluator.

### New files

- `packages/tile-server/src/ai/behavior_tree.ts` — evaluator + node interface
- `packages/tile-server/src/ai/bt_nodes/sequence.ts`
- `packages/tile-server/src/ai/bt_nodes/selector.ts`
- `packages/tile-server/src/ai/bt_nodes/check.ts`
- `packages/tile-server/src/ai/bt_nodes/scan_target.ts`
- `packages/tile-server/src/ai/bt_nodes/set_job.ts`
- (additional nodes as needed to encode current cascade)
- `packages/tile-server/src/components/npc_behavior_state.ts` — server-only
  component tracking BT execution state
- `packages/content/data/behavior_trees/hostile.json` — encodes current
  hostile cascade (aggro scan → attack / wander / survival overrides)
- `packages/content/data/behavior_trees/passive.json` — encodes current
  passive cascade (wander + flee on damage)
- `packages/content/src/behavior_tree_store.ts` — loader
- Extend `scripts/gen_content.ts` `TARGETS` with `behavior_trees` if client
  needs them (it doesn't today — server-only).

### Interface sketch

```ts
export type NodeResult = "success" | "failure" | "running";

export interface BTNode {
  tick(ctx: BTContext): NodeResult;
}

export interface BTNodeFactory {
  readonly type: string;
  build(spec: unknown): BTNode;
}
```

Content validation at startup: BT JSON files are parsed and every node type
string resolves to a registered factory. Mismatch = fail fast.

### System changes

- `NpcAiSystem` evaluates the BT referenced by the NPC's template, receives
  job emissions from `set_job` leaves, and feeds them into the existing job
  queue + `JobHandler` registry from Phase 3.
- BT execution state stored in the new `NpcBehaviorState` component to
  avoid re-evaluation cost.

### Deletions

- Emergency priority cascade code in `systems/npc_ai.ts` — entirely gone.
- `NpcTemplate.behavior: "hostile" | "passive" | "neutral"` field — deleted.
  Replaced by `NpcTemplate.behaviorTreeId: string` (required).
- Every NPC JSON in `data/npcs/` updated in the same commit to reference
  `behaviorTreeId: "hostile"` or `"passive"`. No NPC file retains a
  `behavior` field.
- Any `npc.behavior ===` reads anywhere in the codebase.

**Estimate:** 6–8 hrs. Largest phase.

---

## Phase 5 — RecipeStepHandler registry

**Goal:** crafting step dispatch through a registry. Three existing step
types (`attack`, `assembly`, `time`) become handlers.

### New files

- `packages/tile-server/src/crafting/step_handler.ts`
- `packages/tile-server/src/crafting/steps/attack_step.ts`
- `packages/tile-server/src/crafting/steps/assembly_step.ts`
- `packages/tile-server/src/crafting/steps/time_step.ts`

### Interface

```ts
export interface RecipeStepHandler {
  readonly id: string; // "attack" | "assembly" | "time" | ...
  onHit?(ctx: RecipeHitContext): StepResult;
  tick?(ctx: RecipeTickContext): StepResult;
  onInteract?(ctx: RecipeInteractContext): StepResult;
}
```

### System changes

- `handlers/workstation_hit_handler.ts` dispatches via the registry.
- `systems/crafting.ts` dispatches tick-based steps via the registry.
- Content validation: every `recipe.stepType` in `data/recipes/` resolves to
  a registered handler. Mismatch = fail fast.

### Deletions

- All `stepType ===` / `stepType !==` branches in workstation_hit_handler.ts
  and crafting.ts.

**Estimate:** 2–3 hrs.

---

## Phase 6 — Biome + Zone as data

**Goal:** finish the worldgen data story. Noise is already data; classification
and zone profiles are the last hardcoded pieces.

### New files

- `packages/content/data/biomes/{id}.json` — climate range, material
  assignment, prop weights. Current biomes extracted verbatim as a starting
  point.
- `packages/content/data/zones/{id}.json` — NPC/entity/prop weights +
  densities. Current `ZONE_PROFILES` extracted verbatim.
- `packages/content/src/biome_store.ts` + `zone_store.ts` — loaders
- Biome JSON uses material names; resolved to ids via
  `content.getMaterialByName()`.

### Loader expansion

- Add `biomes` and `zones` to iteration in `packages/content/src/loader.ts`.
- Add to `scripts/gen_content.ts` `TARGETS` (client needs biome definitions
  for material coloring).

### System changes

- `packages/world/src/biomes.ts::classifyBiome()` iterates biome defs and
  picks the first whose climate range contains the sample.
- `packages/world/src/zones.ts` reads zone profiles from ContentStore.
- `server.ts` spawn-density lookups read from the zone profile rather than
  module constants.

### Deletions

- `MAT_GRASS`, `MAT_STONE`, and all `MAT_*` constants in
  `packages/world/src/biomes.ts` — deleted.
- Hardcoded temperature / moisture / altitude thresholds in
  `classifyBiome()` — deleted.
- `ZONE_PROFILES` object in `packages/world/src/zones.ts` — deleted.
- `ZoneType` enum — deleted. Zone identity becomes the def's `id` string.
- `NPC_DENSITY`, `NODE_DENSITY` module constants in `server.ts` — deleted.

**Estimate:** 4–6 hrs.

---

## Phase 7 — Recipe schema expansion

**Goal:** recipe expressiveness (multi-input, multi-output, tool alternates,
chain refs). Enables richer crafting content without further code changes.

### Schema changes (on `Recipe` type)

- `inputs: RecipeInput[]` — each input may include `alternates?: string[]`
- `outputs: RecipeOutput[]` — replaces single `outputType` / `outputQuantity`
- `requiredTools: string[]` — replaces single `requiredTool`
- `chainNextRecipeId?: string` — optional

### Rewrite existing content

Every file in `data/recipes/` is rewritten in the same PR to the new shape.
Loader accepts only the new shape. No backward-compat.

### Deletions

- Old fields (`outputType`, `outputQuantity`, `requiredTool`) removed from
  the `Recipe` type.
- Any code reading the old fields updated to the new shape.

**Estimate:** 3 hrs.

---

## Explicitly out of scope for this plan

- **Drop tables.** Trivial add on top of Phase 2's `DeathHook` registry.
- **Projectile `onHitEffect`.** One-line schema extension on top of Phase 1.
- **Structure cluster / layout schema.** Procgen villages — later.
- **Equipment slot layout as data.** Defer until new slots are actually
  needed.
- **Procedural model recipes (L-systems etc.).** Defer indefinitely.
- **Authoring new game-design content** (new BTs, new effects, new biomes
  beyond the extracted-from-code defaults). That's the post-scaffold phase.

---

## Sequencing recommendation

```
P0 (both sub-phases, parallel)
 └─ P1 (EffectRegistry)
     └─ P2 (DeathSystem)
         └─ P3 (JobHandler registry)
             └─ P4 (BehaviorTree)
 └─ P5 (RecipeStepHandler)  — independent, can slot anywhere after P0
 └─ P6 (Biome + Zone data)  — independent, can slot anywhere after P0
 └─ P7 (Recipe schema)      — after P5 ideally, but independent
```

P1 → P2 → P3 → P4 is the critical path. P5, P6 can land in parallel with
the chain. Total: ~22–30 hrs focused work.

---

## Definition of done for the whole effort

1. No `if (x === "somestring")` branching on content-defined strings anywhere
   in `packages/tile-server/src/systems/` or `packages/tile-server/src/handlers/`.
2. Every dispatch point resolves through a registry whose handlers are
   registered in `server.ts`.
3. Adding a new effect, job, BT node, recipe step, biome, or zone is a
   content-file drop plus (optionally) a handler TS file — never a system
   edit.
4. Existing gameplay is observationally identical to pre-refactor.
5. No deprecation markers, feature flags, legacy fields, or transitional
   shims anywhere in the tree.
