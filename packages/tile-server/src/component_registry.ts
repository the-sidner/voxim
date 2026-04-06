/**
 * Component registry — single source of truth for all networked components.
 *
 * To add a new networked component:
 *   1. Define its codec in @voxim/codecs (or inline in the component file).
 *   2. Define the ComponentDef in the appropriate component file.
 *   3. Assign a stable wire ID in @voxim/protocol's ComponentType enum.
 *   4. Add one entry to COMPONENT_REGISTRY below.
 *
 * That is all. NETWORKED_DEFS and DEF_BY_TYPE_ID are derived automatically.
 * IDs are wire format — never reassign or reuse one.
 */

import type { ComponentDef } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
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
import { Blueprint } from "./components/building.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { WorldClock, TileCorruption, CorruptionExposure } from "./components/world.ts";
import { TraderInventory } from "./components/trader.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";

interface RegistryEntry {
  readonly typeId: number;
  // deno-lint-ignore no-explicit-any
  readonly def: ComponentDef<any>;
}

/**
 * All networked components with their stable wire type IDs.
 * Order does not matter — lookups use the explicit typeId.
 */
export const COMPONENT_REGISTRY: ReadonlyArray<RegistryEntry> = [
  { typeId: ComponentType.heightmap,          def: Heightmap },
  { typeId: ComponentType.materialGrid,       def: MaterialGrid },
  { typeId: ComponentType.position,           def: Position },
  { typeId: ComponentType.velocity,           def: Velocity },
  { typeId: ComponentType.facing,             def: Facing },
  { typeId: ComponentType.inputState,         def: InputState },
  { typeId: ComponentType.health,             def: Health },
  { typeId: ComponentType.hunger,             def: Hunger },
  { typeId: ComponentType.thirst,             def: Thirst },
  { typeId: ComponentType.stamina,            def: Stamina },
  // 10 (attackCooldown) retired
  { typeId: ComponentType.combatState,        def: CombatState },
  { typeId: ComponentType.lifetime,           def: Lifetime },
  { typeId: ComponentType.modelRef,           def: ModelRef },
  { typeId: ComponentType.animationState,     def: AnimationState },
  { typeId: ComponentType.equipment,          def: Equipment },
  { typeId: ComponentType.heritage,           def: Heritage },
  { typeId: ComponentType.itemData,           def: ItemData },
  { typeId: ComponentType.inventory,          def: Inventory },
  { typeId: ComponentType.craftingQueue,      def: CraftingQueue },
  { typeId: ComponentType.interactCooldown,   def: InteractCooldown },
  { typeId: ComponentType.blueprint,          def: Blueprint },
  { typeId: ComponentType.resource_node,      def: ResourceNode },
  { typeId: ComponentType.worldClock,         def: WorldClock },
  { typeId: ComponentType.tileCorruption,     def: TileCorruption },
  { typeId: ComponentType.corruptionExposure, def: CorruptionExposure },
  { typeId: ComponentType.traderInventory,    def: TraderInventory },
  { typeId: ComponentType.loreLoadout,        def: LoreLoadout },
  { typeId: ComponentType.activeEffects,      def: ActiveEffects },
];

/** Flat list of all networked ComponentDefs — used by AoI spawn builder. */
// deno-lint-ignore no-explicit-any
export const NETWORKED_DEFS: ReadonlyArray<ComponentDef<any>> =
  COMPONENT_REGISTRY.map((e) => e.def);

/** Look up a ComponentDef by wire type ID — used by save/load and client decode. */
// deno-lint-ignore no-explicit-any
export const DEF_BY_TYPE_ID: ReadonlyMap<number, ComponentDef<any>> = new Map(
  COMPONENT_REGISTRY.map((e) => [e.typeId, e.def]),
);
