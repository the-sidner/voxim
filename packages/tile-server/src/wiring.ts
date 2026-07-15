/**
 * wireGameSystems — the registry composition root (T-352).
 *
 * Everything between "content is loaded and validated" and "the tile has a
 * dependency-sorted system list" lives here: the eight content-driven
 * registries (resource effects/modifiers, modifier sources, death hooks,
 * jobs, BT nodes, recipe steps, action gates/effects, trigger catalog/
 * sources, POI activities/puzzle kinds), every register() call, every boot
 * fail-fast content cross-check, the EventBus subscriber wiring (trigger /
 * sensory / enclosure collectors, hearth-anchor cache, workstation +
 * container ownership stamps), and the declared System[] fed through
 * sortSystemsByDependencies.
 *
 * Called exactly once from TileServer.start(), after content load /
 * validation and before atlas terrain load — the same point in boot the
 * inline block occupied, so all cross-checks fire at the same moment with
 * the same fail-fast semantics.
 */
import { Registry } from "@voxim/engine";
import type { EntityId, EventBus, World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { EntityDeployedPayload } from "@voxim/protocol";
import { BIOME_TAG_RULES } from "@voxim/atlas";
import type { ContentService } from "@voxim/content";
import { MOB_NPC_POOL } from "./poi_placer.ts";
import { STAIR_FOUND_PREFAB_ID, STAIR_LOCKED_PREFAB_ID } from "./stair_spawner.ts";
import type { System } from "./system.ts";
import type { StateHistoryBuffer } from "./state_history.ts";
import type { AccountClient, HearthAnchor } from "./account_client.ts";
import { destroyCarriedItemEntities } from "./spawner.ts";
import { stampOwnershipAndCapture, stampContainerOwner } from "./ownership.ts";
import { sortSystemsByDependencies } from "./system_order.ts";
import { NpcAiSystem } from "./systems/npc_ai.ts";
import { NpcSensorySystem } from "./systems/npc_sensory.ts";
import { PhysicsSystem } from "./systems/physics.ts";
import { NoiseSystem } from "./systems/noise.ts";
import { FogOfWarSystem } from "./systems/fog_of_war.ts";
import { ItemPhysicsSystem } from "./systems/item_physics.ts";
import { EquipmentSystem } from "./systems/equipment.ts";
import { ContainerSystem } from "./systems/container.ts";
import { PlacementSystem } from "./systems/placement.ts";
import { EnclosureSystem } from "./systems/enclosure.ts";
import { CraftingSystem } from "./systems/crafting.ts";
import { TerrainDigSystem } from "./systems/terrain_dig.ts";
import { DayNightSystem } from "./systems/day_night.ts";
import { PoiSystem } from "./systems/poi.ts";
import { TriggerSystem } from "./systems/trigger.ts";
import { DeathSystem } from "./systems/death.ts";
import type { DeathHook } from "./systems/death.ts";
import { ResourceSystem } from "./systems/resource.ts";
import { TraderSystem } from "./systems/trader.ts";
import { DynastySystem } from "./systems/dynasty.ts";
import { StaleSlotCleanupSystem } from "./systems/stale_slot_cleanup.ts";
import { AnimationSystem } from "./systems/animation.ts";
import { HitboxSystem } from "./systems/hitbox.ts";
import { ChunkLifecycleSystem } from "./systems/chunk_lifecycle.ts";
import { DebugCommandSystem } from "./systems/debug_commands.ts";
import { TrainingDummySystem } from "./systems/training_dummy_system.ts";
import { ActionDispatcher, newGateRegistry, newEffectRegistry, WeaponTraceResolver, ProjectileSpawnResolver, ProjectileTraceResolver } from "./actions/index.ts";
import { PostureIntentResolver, CompositeIntentResolver, PrimaryIntentResolver, SkillIntentResolver, ReactionIntentResolver, RequestedActionIntentResolver } from "./actions/intent.ts";
import { LocomotionIntentResolver } from "./actions/locomotion_intent.ts";
import { setTagResolver, clearTagResolver } from "./actions/resolvers/tags.ts";
import { dodgeImpulseResolver } from "./actions/resolvers/movement.ts";
import { notStaggeredGate, notExhaustedGate, healthBelowGate, uninterruptibleActiveGate } from "./actions/resolvers/gates.ts";
import { StaminaCostHandler } from "./actions/cost.ts";
import { slotHasUsableGate, ApplyItemEffectsResolver, adjustResourceResolver, spendItemResolver } from "./actions/resolvers/item_use.ts";
import { hasItemGate, consumeItemResolver } from "./actions/resolvers/inventory_item.ts";
import { spawnNpcTableResolver } from "./actions/resolvers/spawn_npc_table.ts";
import { UnlockStairResolver } from "./actions/resolvers/unlock_stair.ts";
import { speedSkillEffect, damageBoostSkillEffect, shieldSkillEffect, fleeSkillEffect, HealthSkillResolver } from "./actions/resolvers/skill_effects.ts";
import { startBuffResolver, buffTickResolver } from "./actions/resolvers/buff.ts";
import { newResourceEffectRegistry } from "./resources/effect.ts";
import { newResourceModifierRegistry } from "./resources/modifier.ts";
import { equipmentStatModifier } from "./resources/modifiers/equipment_stat.ts";
import { newModifierSourceRegistry } from "./modifiers/modifier.ts";
import { equipmentSource } from "./modifiers/sources/equipment.ts";
import { encumbranceSource } from "./modifiers/sources/encumbrance.ts";
import { speciesSource } from "./modifiers/sources/species.ts";
import { injurySource } from "./modifiers/sources/injury.ts";
import { buffsSource } from "./modifiers/sources/buffs.ts";
import { modifyHealthEffect } from "./resources/effects/modify_health.ts";
import { emitEventEffect } from "./resources/effects/emit_event.ts";
import { resolveRecipeEffect } from "./resources/effects/resolve_recipe.ts";
import { expireBuffEffect } from "./resources/effects/expire_buff.ts";
import { destroySelfEffect } from "./resources/effects/destroy_self.ts";
import { respawnNodeEffect } from "./resources/effects/respawn_node.ts";
import { clearCounterReadyEffect } from "./resources/effects/clear_counter_ready.ts";
import { spawnNextWaveEffect } from "./resources/effects/spawn_next_wave.ts";
import { bossArenaUnlockHook } from "./deathhooks/boss_arena_unlock.ts";
import { createShedDissolveHook } from "./deathhooks/shed_dissolve.ts";
import { createShedCrumbleHook } from "./deathhooks/shed_crumble.ts";
import { HealthHitHandler } from "./handlers/health_hit_handler.ts";
import { ResourceNodeHitHandler } from "./handlers/resource_node_hit_handler.ts";
import { BlueprintHitHandler } from "./handlers/blueprint_hit_handler.ts";
import { WorkstationHitHandler } from "./handlers/workstation_hit_handler.ts";
import { newPoiActivityRegistry } from "./poi/mod.ts";
import { newPuzzleKindRegistry } from "./poi/puzzle_kinds/mod.ts";
import { newTriggerCatalog } from "./triggers/catalog.ts";
import {
  newTriggerSourceRegistry, equipmentTriggerSource, npcTemplateTriggerSource, bossArenaLinkTriggerSource,
} from "./triggers/source.ts";
import { createJobRegistry, registerBuiltinJobs } from "./ai/mod.ts";
import { createBTNodeRegistry, registerBuiltinBTNodes, buildAllBehaviorTrees } from "./ai/bt/mod.ts";
import { createRecipeStepRegistry, registerBuiltinSteps } from "./crafting/mod.ts";

export interface WireGameSystemsDeps {
  content: ContentService;
  world: World;
  eventBus: EventBus;
  stateHistory: StateHistoryBuffer;
  tickRateHz: number;
  devMode: boolean;
  tileId: string;
  /** Null when running without a gateway (dev/demo) — hearth wiring is skipped. */
  accountClient: AccountClient | null;
  /** Lazy: TileServer assigns its zoneBuffer after atlas load, later in start(). */
  getZoneBuffer: () => Uint16Array | null;
  /** Live view of the connected player ids (PoiSystem proximity checks). */
  getSessionPlayerIds: () => IterableIterator<EntityId>;
  /** Mirrors a freshly persisted hearth anchor into TileServer's per-player cache. */
  onHearthAnchorUpdate: (placerId: EntityId, anchor: HearthAnchor) => void;
}

export function wireGameSystems(deps: WireGameSystemsDeps): System[] {
  const {
    content, world, eventBus, stateHistory, tickRateHz, devMode, tileId,
    accountClient, getZoneBuffer, getSessionPlayerIds, onHearthAnchorUpdate,
  } = deps;

  // Resource substrate (T-238) — the one tick loop for every bounded
  // scalar (stamina/hunger/thirst/poise + the crafting countdown).
  // Thresholds dispatch through resourceEffects; rateModifiers through
  // resourceModifiers — same Registry<H> doctrine as the action arc.
  const resourceEffects = newResourceEffectRegistry();
  resourceEffects.register(modifyHealthEffect);
  resourceEffects.register(emitEventEffect);
  resourceEffects.register(resolveRecipeEffect);
  // expire_buff: a buff child's buff_timer Resource hits 0 → destroySubtree.
  resourceEffects.register(expireBuffEffect);
  resourceEffects.register(destroySelfEffect);
  resourceEffects.register(respawnNodeEffect);
  resourceEffects.register(clearCounterReadyEffect);
  // spawn_next_wave: a wave POI's inter-wave wave_timer hits 0 → dispatch
  // the next wave (T-212 v2).
  resourceEffects.register(spawnNextWaveEffect);
  const resourceModifiers = newResourceModifierRegistry();
  resourceModifiers.register(equipmentStatModifier);

  // Status/Modifier query (T-239) — the one place "what changes this
  // entity's stats?" composes: equipment (live), buffs (scene-graph
  // children), encumbrance (live). effective() over this replaces
  // BuffSystem's compose pass, SpeedModifier, EncumbrancePenalty, and
  // the per-consumer deriveItemStats scans.
  const modifierSources = newModifierSourceRegistry();
  modifierSources.register(equipmentSource);
  modifierSources.register(encumbranceSource);
  modifierSources.register(buffsSource);
  modifierSources.register(speciesSource);
  modifierSources.register(injurySource);

  // T-084: the default player species must exist in content.species, else a
  // fresh player would spawn with a Species id no source can resolve.
  const defaultSpecies = content.getGameConfig().player.species ?? "human";
  if (!content.getGameConfig().species[defaultSpecies]) {
    throw new Error(
      `game_config.player.species "${defaultSpecies}" is not defined in game_config.species`,
    );
  }

  // T-085: every species' morphValues key must resolve against the player
  // model's skeleton morphParams, or the id silently does nothing at spawn
  // (sampleMorphValues would happily write an unknown key onto ModelRef,
  // and no skeleton_solver bone would ever read it back). Same fail-fast
  // stance as the resource/buff/recipe-step/BT checks below.
  {
    const playerPrefab = content.prefabs.get("player");
    const playerSkeleton = playerPrefab?.modelId
      ? content.getSkeletonForModel(playerPrefab.modelId)
      : null;
    const knownMorphIds = new Set((playerSkeleton?.morphParams ?? []).map((p) => p.id));
    for (const [speciesId, def] of Object.entries(content.getGameConfig().species)) {
      for (const key of Object.keys(def.morphValues ?? {})) {
        if (!knownMorphIds.has(key)) {
          throw new Error(
            `game_config.species.${speciesId}.morphValues references unknown morph "${key}" ` +
              `(player model's skeleton morphParams: [${[...knownMorphIds].join(", ")}])`,
          );
        }
      }
    }
  }

  // T-238g: ResourceDef content cross-check — every threshold `effect`
  // and rateModifier `kind` referenced from data/resources/*.json must
  // resolve to a registered handler, or the runtime can't dispatch it.
  // Fail fast at boot (mirrors the buff / recipe-step / BT checks).
  for (const def of content.resources.values()) {
    for (const t of def.thresholds ?? []) {
      if (!resourceEffects.has(t.effect)) {
        throw new Error(
          `ResourceDef "${def.id}" references threshold effect "${t.effect}" ` +
          `but no resource-effect handler is registered. ` +
          `Registered: [${resourceEffects.ids().join(", ")}]`,
        );
      }
    }
    for (const m of def.rateModifiers ?? []) {
      if (!resourceModifiers.has(m.kind)) {
        throw new Error(
          `ResourceDef "${def.id}" references rateModifier kind "${m.kind}" ` +
          `but no resource-modifier handler is registered. ` +
          `Registered: [${resourceModifiers.ids().join(", ")}]`,
        );
      }
    }
  }


  // DeathSystem owns the single RequestDeath queue — systems with health-loss
  // kill paths publish here instead of calling world.destroy directly.
  // Hook registry is empty for now; later populated with drop-table, heir-spawn,
  // corpse-spawn hooks — additive, no system-file edits required.
  const deathHooks = new Registry<DeathHook>();
  // T-252: dying holders take their carried item ENTITIES with them
  // (equipment + unique inventory slots) — drop-tables become a sibling
  // hook later; until then a kill must not leak entities.
  deathHooks.register({
    id: "equip_cleanup",
    onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId),
  });
  // boss_arena_unlock (T-212 v2) — bossfight's death-side arena clear.
  // A DeathHook, not an entity_died Trigger: see components/boss_arena.ts
  // for why the trigger path is structurally unable to see the boss
  // alive by the time it would fire.
  deathHooks.register(bossArenaUnlockHook);
  // shed_dissolve (T-311 P5c, refactored onto DeathStyleDef at T-339) —
  // corrupted-creature death-dissolve. Same DeathHook-not-Trigger
  // reasoning as boss_arena_unlock; additionally votes {linger: true} for
  // dissolve-styled entities so DeathSystem defers world.destroy to the
  // timer Resource's terminal threshold.
  deathHooks.register(createShedDissolveHook(content));
  // shed_crumble (T-339) — a body breaks apart into its bone parts and
  // falls (client-driven; the server just lingers the corpse for the
  // timer's duration). Same shape as shed_dissolve — each hook resolves
  // the SAME NpcTemplate.deathStyleId -> DeathStyleDef chain and no-ops
  // unless its OWN style matches, so exactly one of the two ever seeds a
  // timer for a given death.
  deathHooks.register(createShedCrumbleHook(content));
  const deathSystem = new DeathSystem(deathHooks);

  // Job handler registry — NpcAiSystem dispatches each NPC's current Job
  // through this. Built-in handlers: idle, wander, flee, seekFood, seekWater,
  // attackTarget. Adding a job type is a new handler file + one register call.
  const jobs = createJobRegistry();
  registerBuiltinJobs(jobs);

  // Behavior tree node registry + compiled trees. Every NpcTemplate
  // references a behaviorTreeId; trees are built from data/behavior_trees/
  // JSON at startup using the node registry. Unknown node types or missing
  // tree references fail fast here.
  const btNodes = createBTNodeRegistry();
  registerBuiltinBTNodes(btNodes);
  const behaviorTrees = buildAllBehaviorTrees(content, btNodes);
  for (const tmpl of content.npcTemplates.values()) {
    if (!behaviorTrees.has(tmpl.behaviorTreeId)) {
      throw new Error(
        `NpcTemplate "${tmpl.id}" references behaviorTreeId "${tmpl.behaviorTreeId}" ` +
        `but no such tree was loaded. Available: [${[...behaviorTrees.keys()].join(", ")}]`,
      );
    }
  }

  // Recipe step handler registry — WorkstationHitHandler + CraftingSystem
  // both dispatch through this. Built-ins: assembly (first, so explicit
  // selection wins), attack, time. Adding a step type is one handler file
  // + one register call.
  const recipeSteps = createRecipeStepRegistry();
  registerBuiltinSteps(recipeSteps);
  for (const recipe of content.recipes.values()) {
    const stepType = recipe.stepType ?? "time";
    if (!recipeSteps.has(stepType)) {
      throw new Error(
        `Recipe "${recipe.id}" references stepType "${stepType}" but no step ` +
        `handler is registered. Registered: [${recipeSteps.ids().join(", ")}]`,
      );
    }
  }

  // Action runtime (T-226). Gate registry is empty until an action
  // references a gate (T-227 swings); the effect registry carries the
  // posture tag resolvers. Posture (T-226b) + locomotion (T-226c)
  // intent are merged via CompositeIntentResolver — more slots compose
  // here as further layers migrate. No cost handler yet (both slots
  // are free).
  const actionGates = newGateRegistry();
  actionGates.register(notStaggeredGate);
  actionGates.register(notExhaustedGate);
  actionGates.register(slotHasUsableGate);
  // health_below: the low-health proc condition (T-259c) — usable by
  // trigger conditions and action preconditions alike.
  actionGates.register(healthBelowGate);
  // uninterruptible_active (T-299): a committed swing's active phase can't
  // be flinched out of by a light hit reaction — only stagger_heavy/death.
  actionGates.register(uninterruptibleActiveGate);
  // has_item (T-337): generic named-inventory-item precondition — the ammo
  // economy for hold-to-aim draw actions (bow_draw checks "arrow", a
  // thrown rock's draw checks "throwing_rock"). Vacuously true for
  // entities with no Inventory (NPCs) — see inventory_item.ts's doc.
  actionGates.register(hasItemGate);
  const actionEffects = newEffectRegistry();
  actionEffects.register(setTagResolver);
  actionEffects.register(clearTagResolver);
  actionEffects.register(dodgeImpulseResolver);
  // T-240: `use_item`'s apply_item_effects fans an item's EffectSpec[]
  // back through this same registry (adjust_resource etc.).
  actionEffects.register(adjustResourceResolver);
  actionEffects.register(spendItemResolver);
  actionEffects.register(new ApplyItemEffectsResolver(actionEffects));
  // consume_item (T-337): has_item's effect-side pair — decrements the
  // named item on the release action's active:enter, alongside
  // projectile_spawn.
  actionEffects.register(consumeItemResolver);
  // spawn_npc_table (T-212 v2) — bossfight's phase-adds trigger effect.
  actionEffects.register(spawnNpcTableResolver);
  // unlock_stair (T-213b) — a trinket's use_item effect. Reads
  // the zone buffer via the injected lazy accessor: registration happens
  // here (early boot), but TileServer only assigns its zoneBuffer after
  // loadTerrainFromAtlas runs later in start() — the closure reads it
  // fresh at call time, not at registration time, so ordering is safe.
  actionEffects.register(new UnlockStairResolver(getZoneBuffer));
  // Buffs: start_buff spawns a buff scene-graph child; the child's
  // `buff` ambient action fires buff_tick (DoT/HoT) each tick.
  actionEffects.register(startBuffResolver);
  actionEffects.register(buffTickResolver);
  // T-246: the five skill effects fold onto this one substrate (the
  // parallel `effects/` apply registry is gone). speed/damage_boost/shield
  // are buff children; health is the targeted heal/drain (needs the death
  // port); flee forces NPC job queues. SkillSystem fires them through this
  // registry; an action's effect spec can name them too.
  actionEffects.register(speedSkillEffect);
  actionEffects.register(damageBoostSkillEffect);
  actionEffects.register(shieldSkillEffect);
  actionEffects.register(fleeSkillEffect);
  actionEffects.register(new HealthSkillResolver(deathSystem));

  // T-260b: every configured starting-skill slot must be a loaded
  // ActionDef (the slots ARE action ids now; matrix + verbs are gone).
  for (const sk of content.getGameConfig().player.startingSkills ?? []) {
    if (sk !== null && !content.actions.get(sk)) {
      throw new Error(
        `player.startingSkills names action "${sk}" but no such ActionDef ` +
        `is loaded.`,
      );
    }
  }

  // T-311 P2: every prefab light reference (a placed `lightEmitter` or an item
  // `illuminator`) must resolve to a loaded LightDef — fail-fast before the
  // client silently falls back to a default light.
  for (const prefab of content.prefabs.values()) {
    const comps = prefab.components as Record<string, { lightDefId?: string }> | undefined;
    for (const key of ["lightEmitter", "illuminator"] as const) {
      const id = comps?.[key]?.lightDefId;
      if (id && !content.lights.get(id)) {
        throw new Error(
          `prefab "${prefab.id}" ${key}.lightDefId "${id}" but no such LightDef is loaded.`,
        );
      }
    }
  }

  // T-315 A6: boot cross-checks for content ids that were previously
  // validated (or silently unvalidated) at runtime — fail-fast, matching
  // the startingSkills / lightEmitter checks above.
  for (const id of MOB_NPC_POOL) {
    if (!content.prefabs.get(id)) {
      throw new Error(`poi_placer.MOB_NPC_POOL names prefab "${id}" but no such prefab is loaded.`);
    }
  }
  for (const id of [STAIR_FOUND_PREFAB_ID, STAIR_LOCKED_PREFAB_ID]) {
    if (!content.prefabs.get(id)) {
      throw new Error(`stair_spawner needs prefab "${id}" but no such prefab is loaded.`);
    }
  }
  for (const prefabId of Object.values(content.getGameConfig().terrain.materialDrops)) {
    if (!content.prefabs.get(prefabId)) {
      throw new Error(
        `game_config.terrain.materialDrops names prefab "${prefabId}" but no such prefab is loaded.`,
      );
    }
  }
  // T-311 P5a/P5b: AtmosphereDef/WaterStyleDef selection is
  // `content.X.get(biomeTag) ?? content.X.getOrThrow("default")` —
  // "default" existing is already enforced at load (loader.ts) for both,
  // so the only new failure mode here is an authored non-default id that
  // doesn't name a real biomeTag() output (a typo would silently never be
  // selected). Fail fast, same pattern for both content categories that
  // share this render-context key.
  {
    const validTags = new Set(BIOME_TAG_RULES.map((r) => r.tag));
    for (const atmo of content.atmospheres.values()) {
      if (atmo.id !== "default" && !validTags.has(atmo.id)) {
        throw new Error(
          `AtmosphereDef "${atmo.id}" doesn't match any biomeTag() output ` +
          `([${[...validTags].join(", ")}, default]) — it can never be selected.`,
        );
      }
    }
    for (const style of content.waterStyles.values()) {
      if (style.id !== "default" && !validTags.has(style.id)) {
        throw new Error(
          `WaterStyleDef "${style.id}" doesn't match any biomeTag() output ` +
          `([${[...validTags].join(", ")}, default]) — it can never be selected.`,
        );
      }
    }
  }

  // Trigger primitive (T-259) — the single event→effect bridge. Catalog
  // (closed event-kind vocabulary) + sources (live "who owns which
  // triggers" reads; v1: equipment) + the buffered TriggerSystem.
  const triggerCatalog = newTriggerCatalog();
  const triggerSources = newTriggerSourceRegistry();
  triggerSources.register(equipmentTriggerSource);
  triggerSources.register(npcTemplateTriggerSource);
  // Bossfight phase-adds (T-212 v2) — BossArenaLink presence grants
  // {poiDefId}_phase_add_{i} triggers; see triggers/source.ts's header.
  triggerSources.register(bossArenaLinkTriggerSource);
  const triggerSystem = new TriggerSystem(content, triggerCatalog, triggerSources, actionGates, actionEffects);

  // NPC sensory system (T-040) — the event-driven half of NPC awareness,
  // alongside the spatial detection scan in set_job_attack_nearest. Buffers
  // perceived combat/noise events on the bus, then aggros nearby NPCs
  // toward the threat at the top of its next run (the TriggerSystem shape).
  const npcSensorySystem = new NpcSensorySystem(content);

  // Enclosure detection (T-065, server core) — caches which world cells are
  // sealed inside walls, recomputing only on a wall-change signal
  // (BuildingCompleted). Publishes TileEvents.EnclosureChanged on a
  // recompute that actually changes the set; EventRouter forwards it to
  // every client so the roof renderer can rebuild (T-066).
  const enclosureSystem = new EnclosureSystem();

  // T-259 content cross-checks — every TriggerDef's `on` must be a
  // catalog kind, every condition gate and effect kind registered, and
  // every prefab `triggers[]` ref must resolve. Fail fast at boot, same
  // stance as the ResourceDef / action-effect / POI checks.
  for (const trig of content.triggers.values()) {
    if (!triggerCatalog.has(trig.on)) {
      throw new Error(
        `Trigger "${trig.id}" listens to "${trig.on}" but no such event ` +
        `kind is in the catalog. Known: [${triggerCatalog.ids().join(", ")}]`,
      );
    }
    for (const c of trig.conditions ?? []) {
      if (!actionGates.has(c.gate)) {
        throw new Error(
          `Trigger "${trig.id}" condition gate "${c.gate}" is not ` +
          `registered. Registered: [${actionGates.ids().join(", ")}]`,
        );
      }
    }
    for (const eff of trig.effects) {
      if (!actionEffects.has(eff.kind)) {
        throw new Error(
          `Trigger "${trig.id}" lists effect "${eff.kind}" but no ` +
          `action-effect resolver is registered. ` +
          `Registered: [${actionEffects.ids().join(", ")}]`,
        );
      }
    }
  }
  for (const prefab of content.prefabs.values()) {
    for (const t of prefab.triggers ?? []) {
      if (!content.triggers.get(t)) {
        throw new Error(
          `Prefab "${prefab.id}" grants trigger "${t}" but no such ` +
          `TriggerDef is loaded. Loaded: [${[...content.triggers.ids()].join(", ")}]`,
        );
      }
    }
  }
  for (const tmpl of content.npcTemplates.values()) {
    for (const t of tmpl.triggers ?? []) {
      if (!content.triggers.get(t)) {
        throw new Error(
          `NpcTemplate "${tmpl.id}" grants trigger "${t}" but no such ` +
          `TriggerDef is loaded. Loaded: [${[...content.triggers.ids()].join(", ")}]`,
        );
      }
    }
  }
  // T-339: every NpcTemplate.deathStyleId must resolve — the
  // shed_dissolve/shed_crumble DeathHooks and the client death-style
  // registry both assume it does. (A DeathStyleDef's OWN internal refs —
  // resourceKey/dissolveProfileId/crumble.impactParticleId — are pure
  // content→content and are already cross-checked in loader.ts.)
  for (const tmpl of content.npcTemplates.values()) {
    if (tmpl.deathStyleId && !content.deathStyles.get(tmpl.deathStyleId)) {
      throw new Error(
        `NpcTemplate "${tmpl.id}" references deathStyleId "${tmpl.deathStyleId}" ` +
        `but no such DeathStyleDef is loaded. ` +
        `Loaded: [${[...content.deathStyles.ids()].join(", ")}]`,
      );
    }
  }

  const actionDispatcher = new ActionDispatcher(
    content, actionGates, actionEffects,
    new CompositeIntentResolver([
      PostureIntentResolver,
      LocomotionIntentResolver,
      new PrimaryIntentResolver(content),
      // T-260b: a SKILL_N press overrides the bit-derived primary intent —
      // the skill bar IS the action system now (SkillSystem is gone).
      SkillIntentResolver,
      ReactionIntentResolver,
      // Last: a BT-named action request overrides the bit-derived intent.
      RequestedActionIntentResolver,
    ]),
    StaminaCostHandler,
  );
  // Trigger collectors run during the (notify-only) post-changeset flush
  // and only buffer; the TriggerSystem drains at the top of its next run.
  triggerSystem.registerSubscribers(eventBus);
  // Same shape for the NPC sensory collectors (T-040): they buffer perceived
  // combat/noise events during the flush; NpcSensorySystem drains next run.
  npcSensorySystem.registerSubscribers(eventBus);
  // Enclosure recompute trigger (T-065): a finished wall blueprint closes a
  // cell. The collector only flips a dirty flag at flush time; the recompute
  // runs at the top of EnclosureSystem's next run.
  enclosureSystem.registerSubscribers(eventBus);

  // Hearth anchor subscriber — when a prefab carrying the `hearth` component
  // is placed, tell the account service so the heir spawns at the new
  // location on next login. Fire-and-forget; a failed write leaves the
  // previous anchor in place and is logged. Runs during the post-changeset
  // flush; requires no world mutation, so a 1-tick latency is irrelevant.
  if (accountClient && tileId) {
    eventBus.subscribe(TileEvents.EntityDeployed, (p: EntityDeployedPayload) => {
      const prefab = content.prefabs.get(p.prefabId);
      if (!prefab?.components.hearth) return;
      const anchor = { tileId, position: { x: p.worldX, y: p.worldY, z: p.worldZ } };
      accountClient.updateHearth(p.placerId, anchor).catch((err: unknown) =>
        console.warn(`[hearth] updateHearth failed for ${p.placerId.slice(0, 8)}:`, err)
      );
      // Keep the in-session anchor cache (T-079) in sync with what was just
      // persisted, so an in-session respawn spawns at a hearth built THIS
      // session — not only one carried in via the join-time SessionInfo.
      onHearthAnchorUpdate(p.placerId, anchor);
      console.log(
        `[hearth] anchored player=${p.placerId.slice(0, 8)} entity=${p.entityId.slice(0, 8)} ` +
        `at (${p.worldX.toFixed(1)}, ${p.worldY.toFixed(1)}) on ${tileId}`,
      );
    });
  }

  // Workstation ownership + base capture (T-082, generalises T-038's
  // job_board-only stamp) — when a player deploys any workstation, stamp it
  // with their dynasty and re-stamp nearby enemy-owned workstations to them.
  // Runs in the post-changeset flush, so the freshly spawned entity and every
  // existing owner are committed and queryable. job_board carries a
  // WorkstationTag, so hiring-board ownership is covered by this one path.
  const captureRadius = content.getGameConfig().building.capture.radiusWorldUnits;
  eventBus.subscribe(TileEvents.EntityDeployed, (p: EntityDeployedPayload) => {
    const result = stampOwnershipAndCapture(world, p, captureRadius);
    if (!result) return;
    console.log(
      `[ownership] dynasty=${result.dynastyId.slice(0, 8)} claimed ` +
      `workstation=${p.entityId.slice(0, 8)} (${p.prefabId})` +
      (result.captured.length
        ? ` — captured ${result.captured.length} structure(s) from ` +
          result.captured.map((c) => c.previousDynastyId.slice(0, 8)).join(", ")
        : ""),
    );
  });

  // T-077/T-078: stamp a freshly deployed family chest (library/treasury) with
  // the placer's dynasty so only that dynasty's heir can store/withdraw. Chests
  // carry a Container, not a WorkstationTag, so the ownership stamp above skips
  // them — this parallel subscriber handles them.
  eventBus.subscribe(TileEvents.EntityDeployed, (p: EntityDeployedPayload) => {
    const dynastyId = stampContainerOwner(world, p);
    if (!dynastyId) return;
    console.log(`[container] dynasty=${dynastyId.slice(0, 8)} claimed chest=${p.entityId.slice(0, 8)} (${p.prefabId})`);
  });


  const hitHandlers = [
    new HealthHitHandler(content, deathSystem, modifierSources),
    new ResourceNodeHitHandler(content),
    new BlueprintHitHandler(),
    new WorkstationHitHandler(content, recipeSteps),
  ];

  // T-227: the swing's active phase fires these through the dispatcher's
  // effect registry (registered after hitHandlers since weapon_trace
  // dispatches to them). Replaces ActionSystem.resolveHits / spawnProjectile.
  actionEffects.register(new WeaponTraceResolver(stateHistory, tickRateHz, hitHandlers));
  actionEffects.register(new ProjectileSpawnResolver());
  // T-243: projectile flight is an ambient action (`projectile_flight`)
  // whose `hold:tick` fires this — motion + collision + hit dispatch over
  // the shared hitHandlers. Replaces the bespoke ProjectileSystem.
  actionEffects.register(new ProjectileTraceResolver(hitHandlers));

  // T-240 Ph3: item effect content cross-check — every `effects[].id` on
  // every prefab must resolve to a registered action-effect resolver, or
  // `use_item` can't dispatch it. Fail fast at boot (mirrors the
  // ResourceDef / buff / recipe-step / BT checks). Unique items' runtime
  // `ItemEffects` (procedural) can't be boot-checked; the prefab payload
  // is the static surface generation targets.
  for (const prefab of content.prefabs.values()) {
    for (const spec of prefab.effects ?? []) {
      if (!actionEffects.has(spec.id)) {
        throw new Error(
          `Prefab "${prefab.id}" lists item effect "${spec.id}" but no ` +
          `action-effect resolver is registered. ` +
          `Registered: [${actionEffects.ids().join(", ")}]`,
        );
      }
    }
  }

  // T-077/T-078 content cross-checks (fail-fast, mirrors the checks above):
  //  1. the lore tome prefabs referenced by game_config exist (this also
  //     catches the long-latent missing tome/blank_tome prefab bug);
  //  2. every prefab with a `container` declares a valid kind + capacity;
  //  3. every `deployable` names a prefab that actually loads (covers the
  //     chest kits + the pre-existing workbench/job_board kits).
  const lore = content.getGameConfig().lore;
  for (const id of [lore.tomeItemType, lore.blankTomeItemType]) {
    if (!content.prefabs.get(id)) {
      throw new Error(`game_config.lore references item prefab "${id}" but no such prefab is loaded.`);
    }
  }
  for (const prefab of content.prefabs.values()) {
    const container = (prefab.components as Record<string, unknown> | undefined)?.container as
      | { kind?: string; capacity?: number } | undefined;
    if (container) {
      if (container.kind !== "tome" && container.kind !== "equipment") {
        throw new Error(`Prefab "${prefab.id}" container.kind must be "tome" or "equipment", got "${container.kind}".`);
      }
      if (!(typeof container.capacity === "number" && container.capacity > 0)) {
        throw new Error(`Prefab "${prefab.id}" container.capacity must be a positive number.`);
      }
    }
    const deployable = (prefab.components as Record<string, unknown> | undefined)?.deployable as
      | { prefabId?: string } | undefined;
    if (deployable?.prefabId && !content.prefabs.get(deployable.prefabId)) {
      throw new Error(`Prefab "${prefab.id}" deployable.prefabId "${deployable.prefabId}" resolves to no prefab.`);
    }
    // T-337/T-338: every weapon's explicit swingActionId must resolve to a
    // loaded ActionDef — a typo here previously degraded to a runtime
    // warning (PrimaryIntentResolver's "intent requested unknown action")
    // instead of a fail-fast boot error, same bar as every other content
    // cross-check on this page.
    const swingable = (prefab.components as Record<string, unknown> | undefined)?.swingable as
      | { swingActionId?: string; chain?: Array<{ light?: string; heavy?: string }> } | undefined;
    if (swingable?.swingActionId && !content.actions.get(swingable.swingActionId)) {
      throw new Error(`Prefab "${prefab.id}" swingable.swingActionId "${swingable.swingActionId}" resolves to no ActionDef.`);
    }
    // T-337: a HOLD-TO-AIM weapon must not offer a light/heavy split.
    //
    // The server picks light-vs-heavy from the SwingChain component, which is a
    // MELEE combo concept — nothing writes or resets it when a hold-to-aim
    // weapon is equipped. So a stale `heavy` left behind by a previously-held
    // sword could make the server fire the .heavy WeaponActionDef while the
    // client's aim arc — which has no access to SwingChain — always previews
    // .light. The arc would then lie about where the shot lands, and a landing
    // marker that lies reads as "netcode" forever. Every shipped ranged/thrown
    // weapon happens to set light === heavy today, so the divergence is
    // currently unreachable; this makes that a rule instead of a coincidence.
    //
    // Lifting it means giving hold-to-aim weapons a real charge→variant model
    // that the client can also see. That is a design call, not an oversight —
    // and this check is what will force it to be made deliberately.
    const swingAction = swingable?.swingActionId ? content.actions.get(swingable.swingActionId) : undefined;
    if (swingAction?.releaseActionId) {
      for (const [i, step] of (swingable?.chain ?? []).entries()) {
        if (step.light !== step.heavy) {
          throw new Error(
            `Prefab "${prefab.id}" is hold-to-aim (its action "${swingable!.swingActionId}" has releaseActionId ` +
            `"${swingAction.releaseActionId}") but chain[${i}] declares light "${step.light}" ≠ heavy "${step.heavy}". ` +
            `The client's aim arc cannot see SwingChain, so it would preview one action while the server fires the ` +
            `other — the arc would lie about the impact point. Make them equal, or design a charge→variant model ` +
            `the client can read too.`,
          );
        }
      }
    }
  }

  // T-243: action-effect content cross-check — every `effects[].kind` on
  // every ActionDef must resolve to a registered resolver, or the
  // dispatcher throws mid-tick the first time that phase edge fires.
  // Closes the doctrine gap (weapon_trace / buff_tick / projectile_trace
  // were dispatch-time-only); same fail-fast stance as the checks above.
  for (const action of content.actions.values()) {
    for (const eff of action.effects) {
      if (!actionEffects.has(eff.kind)) {
        throw new Error(
          `Action "${action.id}" phase "${eff.phase}" lists effect ` +
          `"${eff.kind}" but no action-effect resolver is registered. ` +
          `Registered: [${actionEffects.ids().join(", ")}]`,
        );
      }
    }
    // T-254: gate ids too (preconditions + cancel-rule gates) — an
    // unknown gate previously threw mid-tick on first arbitration
    // (sword_overhead shipped with an unregistered `tag_absent` for
    // months and nothing noticed).
    const gateRefs = [
      ...(action.preconditions ?? []),
      ...Object.values(action.cancel).flatMap((r) => r.gates ?? []),
    ];
    for (const g of gateRefs) {
      if (!actionGates.has(g.gate)) {
        throw new Error(
          `Action "${action.id}" references gate "${g.gate}" but no gate ` +
          `handler is registered. Registered: [${actionGates.ids().join(", ")}]`,
        );
      }
    }
  }

  // T-245: POI activity registry + content cross-check — every PoiDef's
  // `type` must resolve to a registered PoiActivityHandler, or PoiSystem
  // throws when that POI first fires. Replaces the per-type switch; same
  // fail-fast stance as the checks above.
  const poiActivities = newPoiActivityRegistry();
  for (const poi of content.pois.values()) {
    if (!poiActivities.has(poi.type)) {
      throw new Error(
        `POI "${poi.id}" has activity type "${poi.type}" but no ` +
        `PoiActivityHandler is registered. ` +
        `Registered: [${poiActivities.ids().join(", ")}]`,
      );
    }
  }
  // T-212 v2: every bossfight POI's phase-add trigger set
  // ({poiDefId}_phase_add_{i}, one per arenaRules.phaseTriggers entry —
  // see triggers/source.ts's bossArenaLinkTriggerSource) and addsTable
  // must resolve, or the fight silently no-ops adds at runtime instead
  // of throwing at boot.
  for (const poi of content.pois.values()) {
    if (poi.type !== "bossfight") continue;
    for (let i = 0; i < poi.activity.arenaRules.phaseTriggers.length; i++) {
      const trigId = `${poi.id}_phase_add_${i}`;
      if (!content.triggers.get(trigId)) {
        throw new Error(
          `POI "${poi.id}" declares ${poi.activity.arenaRules.phaseTriggers.length} ` +
          `phaseTriggers but TriggerDef "${trigId}" is not loaded. Author ` +
          `data/triggers/${trigId}.json.`,
        );
      }
    }
  }
  // T-212 v2: every puzzle POI's puzzleId must resolve to a loaded
  // PuzzleDef, and that def's `kind` must resolve to a registered
  // PuzzleKindHandler — same fail-fast stance as every other content-id
  // cross-check (T-315 A6 house pattern).
  const puzzleKinds = newPuzzleKindRegistry();
  for (const poi of content.pois.values()) {
    if (poi.type !== "puzzle") continue;
    const puzzleDef = content.puzzles.get(poi.activity.puzzleId);
    if (!puzzleDef) {
      throw new Error(
        `POI "${poi.id}" references puzzleId "${poi.activity.puzzleId}" but no ` +
        `PuzzleDef is loaded. Loaded: [${[...content.puzzles.ids()].join(", ")}]`,
      );
    }
    if (!puzzleKinds.has(puzzleDef.kind)) {
      throw new Error(
        `Puzzle "${puzzleDef.id}" has kind "${puzzleDef.kind}" but no ` +
        `PuzzleKindHandler is registered. Registered: [${puzzleKinds.ids().join(", ")}]`,
      );
    }
  }

  // System pipeline, declared in reading order. Real ordering constraints
  // live on each system as `dependsOn` (e.g. PhysicsSystem.dependsOn =
  // ["NpcAiSystem"] because NpcAi writes InputState via world.write() that
  // Physics must see this tick). sortSystemsByDependencies computes the
  // final order: it honours dependsOn and preserves this reading order for
  // any pair whose relative ordering isn't load-bearing.
  //
  // DeathSystem stays last so it drains RequestDeath calls accumulated
  // this tick; its position is implicit in the declaration order since no
  // other system depends on it.
  const declared: System[] = [
    // Runs first so any Inventory/Equipment slot referencing an item entity
    // destroyed last tick (durability broken, consumed, traded away) is
    // scrubbed before downstream systems read slots or a stale ref is sent
    // on the wire.
    new StaleSlotCleanupSystem(),
    // TriggerSystem drains last tick's buffered events early so its
    // effects (procs, buffs, damage) land in this tick's changeset
    // alongside everything else (T-259).
    triggerSystem,
    // NpcSensorySystem (T-040) drains last tick's perceived combat/noise
    // events before NpcAiSystem runs, so the attackTarget jobs it sets are
    // committed for the BT to honour next tick (gated like its own aggro).
    npcSensorySystem,
    new NpcAiSystem(content, jobs, behaviorTrees),
    new EquipmentSystem(content),
    new ContainerSystem(content),
    new PlacementSystem(content),
    // Recomputes the enclosed-cell cache on wall-change (dependsOn
    // PlacementSystem so a wall deployed this tick is committed first). T-065.
    enclosureSystem,
    new CraftingSystem(content, recipeSteps),
    new DayNightSystem(content),
    new ResourceSystem(content, resourceEffects, resourceModifiers, deathSystem, modifierSources),
    new PhysicsSystem(content, modifierSources),
    new NoiseSystem(content),
    new FogOfWarSystem(content),
    // ActionDispatcher advances every actor's slots (posture, locomotion,
    // primary, reaction) from intent + events. The CSM is gone (T-228).
    actionDispatcher,
    new ItemPhysicsSystem(content),
    new TerrainDigSystem(content),
    new TraderSystem(content),
    new DynastySystem(content),
    new AnimationSystem(content),
    new HitboxSystem(content),
    new PoiSystem(content, poiActivities, getSessionPlayerIds),
    // Streams terrain in/out by entity proximity (T-064). Late so it reads
    // this tick's committed positions; dependsOn PhysicsSystem pins that.
    new ChunkLifecycleSystem(content),
    new DebugCommandSystem(content, devMode),
    // Auto-heal for T-327's practice target — the actual "never dies"
    // guarantee is the Health floor in health_hit_handler.ts; this just
    // recovers it after healDelayTicks so no respawn is needed mid-session.
    new TrainingDummySystem(devMode),
    deathSystem,
  ];
  return sortSystemsByDependencies(declared);
}
