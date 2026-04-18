/**
 * Component registry — single source of truth for every ComponentDef.
 *
 * Two lookup indices are derived here:
 *   NETWORKED_DEFS / DEF_BY_TYPE_ID — networked defs only, keyed by wire ID.
 *     Used by save/load, client decode, and AoI delta build.
 *   ALL_DEFS / DEF_BY_NAME — all defs (networked + server-only), keyed by
 *     the def's `name` string. Used by the prefab loader and any generic
 *     "look up a component by name" consumer.
 *
 * To add a new component:
 *   1. Define its codec in @voxim/codecs (or inline for server-only defs).
 *   2. Define the ComponentDef in the appropriate component file. Networked
 *      defs need a wireId from @voxim/protocol's ComponentType enum.
 *   3. Register it below — NETWORKED_DEFS if it's networked, ALL_DEFS
 *      otherwise.
 *
 * IDs are wire format — never reassign or reuse one.
 */

// deno-lint-ignore-file no-explicit-any
import type { ComponentDef, NetworkedComponentDef } from "@voxim/engine";
import { Heightmap, MaterialGrid } from "@voxim/world";
import {
  Position, Velocity, Facing, InputState,
  Health, Hunger, Thirst, Stamina,
  CombatState, Lifetime,
  ModelRef, AnimationState,
} from "./components/game.ts";
import { SkillInProgress } from "./components/combat.ts";
import { Equipment } from "./components/equipment.ts";
import { Heritage } from "./components/heritage.ts";
import { ItemData, Inventory, CraftingQueue, InteractCooldown } from "./components/items.ts";
import { Blueprint, WorkstationTag, WorkstationBuffer } from "./components/building.ts";
import { ResourceNode } from "./components/resource_node.ts";
import {
  WorldClock, TileCorruption, CorruptionExposure,
  SpeedModifier, EncumbrancePenalty,
} from "./components/world.ts";
import { TraderInventory } from "./components/trader.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { LightEmitter, DarknessModifier } from "./components/light.ts";
import { Hitbox } from "./components/hitbox.ts";
import { NpcTag, NpcJobQueue } from "./components/npcs.ts";
import { ProjectileData } from "./components/projectile.ts";

/** All networked component defs. wireId is on each def — no separate typeId mapping needed. */
export const NETWORKED_DEFS: ReadonlyArray<NetworkedComponentDef<any>> = [
  Heightmap,
  MaterialGrid,
  Position,
  Velocity,
  Facing,
  InputState,
  Health,
  Hunger,
  Thirst,
  Stamina,
  // 10 (attackCooldown) retired
  CombatState,
  Lifetime,
  ModelRef,
  AnimationState,
  Equipment,
  Heritage,
  ItemData,
  Inventory,
  CraftingQueue,
  InteractCooldown,
  Blueprint,
  ResourceNode,
  WorldClock,
  TileCorruption,
  CorruptionExposure,
  TraderInventory,
  LoreLoadout,
  ActiveEffects,
  // hitbox slot reserved — networked: false (server-only, listed in ALL_DEFS below)
  // workstationTag slot reserved — networked: false (server-only, listed in ALL_DEFS below)
  WorkstationBuffer,
  LightEmitter,
  DarknessModifier,
];

/** Look up a ComponentDef by wire type ID — used by save/load and client decode. */
export const DEF_BY_TYPE_ID: ReadonlyMap<number, NetworkedComponentDef<any>> = new Map(
  NETWORKED_DEFS.map((d) => [d.wireId, d]),
);

/**
 * Every ComponentDef, networked and server-only. The prefab loader resolves
 * component names against this list: a prefab declaring a component by name
 * that isn't registered here fails fast at content-load.
 */
export const ALL_DEFS: ReadonlyArray<ComponentDef<any>> = [
  ...NETWORKED_DEFS,
  // ── Server-only defs (networked: false) ──────────────────────────────────
  Hitbox,
  SkillInProgress,
  WorkstationTag,
  NpcTag,
  NpcJobQueue,
  ProjectileData,
  SpeedModifier,
  EncumbrancePenalty,
];

/**
 * Look up a ComponentDef by its string name — the prefab loader's primary
 * index. Built once at module load; immutable afterwards.
 */
export const DEF_BY_NAME: ReadonlyMap<string, ComponentDef<any>> = (() => {
  const map = new Map<string, ComponentDef<any>>();
  for (const def of ALL_DEFS) {
    if (map.has(def.name)) {
      throw new Error(`[component_registry] duplicate component name "${def.name}"`);
    }
    map.set(def.name, def);
  }
  return map;
})();
