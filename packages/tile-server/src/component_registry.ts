/**
 * Component registry — single source of truth for all networked components.
 *
 * To add a new networked component:
 *   1. Define its codec in @voxim/codecs (or inline in the component file).
 *   2. Define the ComponentDef with a `wireId` in the appropriate component file.
 *   3. Assign a stable wire ID in @voxim/protocol's ComponentType enum.
 *   4. Add the def to NETWORKED_DEFS below.
 *
 * NETWORKED_DEFS and DEF_BY_TYPE_ID are derived automatically.
 * IDs are wire format — never reassign or reuse one.
 */

import type { NetworkedComponentDef } from "@voxim/engine";
import { Heightmap, MaterialGrid } from "@voxim/world";
import {
  Position, Velocity, Facing, InputState,
  Health, Hunger, Thirst, Stamina,
  CombatState, Lifetime,
  ModelRef, AnimationState,
} from "./components/game.ts";
import { Equipment } from "./components/equipment.ts";
import { Heritage } from "./components/heritage.ts";
import { ItemData, Inventory, CraftingQueue, InteractCooldown } from "./components/items.ts";
import { Blueprint, WorkstationBuffer } from "./components/building.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { WorldClock, TileCorruption, CorruptionExposure } from "./components/world.ts";
import { TraderInventory } from "./components/trader.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { LightEmitter, DarknessModifier } from "./components/light.ts";
// Hitbox and WorkstationTag are server-only (networked: false) — not in registry

/** All networked component defs. wireId is on each def — no separate typeId mapping needed. */
// deno-lint-ignore no-explicit-any
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
  // hitbox slot reserved — networked: false (server-only)
  // workstationTag slot reserved — networked: false (server-only)
  WorkstationBuffer,
  LightEmitter,
  DarknessModifier,
];

/** Look up a ComponentDef by wire type ID — used by save/load and client decode. */
// deno-lint-ignore no-explicit-any
export const DEF_BY_TYPE_ID: ReadonlyMap<number, NetworkedComponentDef<any>> = new Map(
  NETWORKED_DEFS.map((d) => [d.wireId, d]),
);
