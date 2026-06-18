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
import { Parent } from "@voxim/engine";
import { Heightmap, KindGrid, MaterialGrid, OpenMask } from "@voxim/world";
import {
  AnimationState,
  Facing,
  Health,
  InputState,
  ModelRef,
  Name,
  Position,
  Velocity,
} from "./components/game.ts";
import {
  CounterReady,
} from "./components/combat.ts";
import { ActorSlots, ActiveActions } from "./components/action.ts";
import { Resource } from "./components/resource.ts";
import { BuffSpec } from "./components/buff.ts";
import { Equipment } from "./components/equipment.ts";
import { Heritage } from "./components/heritage.ts";
import {
  CraftingQueue,
  Inventory,
  ItemData,
} from "./components/items.ts";
import {
  Durability,
  History,
  Inscribed,
  Owned,
  Provenance,
  QualityStamped,
  Stats,
} from "./components/instance.ts";
import {
  Blueprint,
  WorkstationBuffer,
  WorkstationTag,
} from "./components/building.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { WorldClock } from "./components/world.ts";
import { TraderInventory } from "./components/trader.ts";
import { LoreLoadout } from "./components/lore_loadout.ts";
import { DarknessModifier, LightEmitter } from "./components/light.ts";
import { Hitbox } from "./components/hitbox.ts";
import { GateLink } from "./components/gate.ts";
import { Hearth } from "./components/hearth.ts";
import { AssignedJobBoard, JobBoard } from "./components/job_board.ts";
import { PoiTrigger } from "./components/poi.ts";
import { Stair } from "./components/stair.ts";
import { NpcJobQueue, NpcTag } from "./components/npcs.ts";
import { ProjectileData } from "./components/projectile.ts";
import { AnimationSlots } from "./components/animation_slots.ts";
import {
  Armor,
  Composed,
  Deployable,
  Equippable,
  Illuminator,
  MaterialSource,
  Placeable,
  Stackable,
  Swingable,
  Tool,
  Weight,
} from "./components/item_behaviours.ts";

/** All networked component defs. wireId is on each def — no separate typeId mapping needed. */
export const NETWORKED_DEFS: ReadonlyArray<NetworkedComponentDef<any>> = [
  Heightmap,
  MaterialGrid,
  // OpenMask carries the per-cell impassability used by stepPhysics on
  // both server and client (predictor). Networked so client doesn't have
  // to rubber-band on boundaries that lack a heightmap step (vegetation).
  OpenMask,
  // KindGrid: per-cell boundary kind (forest/stone/water/grass mound).
  // Lets the client decorate the closed pixels (forest tiles → trees,
  // stone tiles → rocks) without server entities.
  KindGrid,
  Position,
  Velocity,
  Facing,
  // 5 (inputState) retired from the wire (T-250) — server-only now; it never
  //   produced a delta (every writer uses world.write) and has no client
  //   consumer (clients reconcile on ackInputSeq, render remotes from
  //   AnimationState). Listed in ALL_DEFS below.
  Health,
  // 7 (hunger) / 8 (thirst) retired — server-only Resources now (T-238c)
  // 9 (stamina) retired — server-only Resource now (T-238b)
  // 10 (attackCooldown) retired
  // 11 (combatState) retired — only CounterReady (below) survives from the
  //    split. (T-229: IFrameActive → `iframe` tag, DodgeCooldown removed.
  //    T-232: networked Staggered → `staggered` tag + stagger reaction
  //    actions, wire id 36 retired. T-233: BlockHeld removed — parry window
  //    is the held `block` action's ticksInPhase.)
  // 12 (lifetime) retired — Lifetime is data/resources/lifetime.json
  //    (cross@0 → destroy_self). T-241.
  ModelRef,
  AnimationState,
  Equipment,
  Heritage,
  ItemData,
  Inventory,
  CraftingQueue,
  // 20 (interactCooldown) retired — server-only, never needed on client
  Blueprint,
  ResourceNode,
  WorldClock,
  // 24 (tileCorruption) + 25 (corruptionExposure) retired — corruption
  // mechanic removed (T-238e); wire ids reserved in component_types.ts
  TraderInventory,
  LoreLoadout,
  // 28 (activeEffects) retired — buffs are scene-graph children (T-239);
  // wire id reserved in component_types.ts
  // hitbox slot reserved — networked: false (server-only, listed in ALL_DEFS below)
  WorkstationBuffer,
  WorkstationTag,
  LightEmitter,
  DarknessModifier,
  // ── Instance-lifetime components — held unique items stream to the
  //    holder's session via AoI inclusion in aoi.ts.
  Durability,
  Inscribed,
  QualityStamped,
  Stats,
  Provenance,
  // 37 (counterReady) retired from the wire (T-250) — combat presence-flags
  //    are server-only now (the wire carries data, not flags; the client
  //    derives presentation from AnimationState/Health). Listed in ALL_DEFS.
  //    (Staggered went server-only at T-232 for the same reason.)
  GateLink,
  Name,
  // Action runtime (T-226): networked so the client's mirrored World runs
  // the same slot dispatch for prediction. ActorSlots is spawn-immutable;
  // ActiveActions changes only when a slot's phase/action changes.
  ActorSlots,
  ActiveActions,
  // Scene graph (T-215): the Parent hierarchy link. Networked so subtrees
  // (POIs, bones, equipment, buffs) replicate for free. Engine owns the
  // def + codec; wire id 49 is reserved in @voxim/protocol. Inert until
  // a consumer calls the World hierarchy APIs.
  Parent,
];

/** Look up a ComponentDef by wire type ID — used by save/load and client decode. */
export const DEF_BY_TYPE_ID: ReadonlyMap<number, NetworkedComponentDef<any>> =
  new Map(
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
  // InputState (T-250) — the tick's input stimulus; written via world.write,
  // read by physics/dispatcher/AI. Never on the wire (see NETWORKED_DEFS note).
  InputState,
  // CounterReady (T-250) — parry bonus-damage flag; server-only, bounded by
  // the counter_window Resource. Read by health_hit_handler.
  CounterReady,
  Hitbox,
  // (Combat counters all retired: T-229 IFrameActive→`iframe` tag &
  // DodgeCooldown removed; T-233 BlockHeld removed — parry window is the
  // held `block` action's ticksInPhase. CombatTimersSystem is gone.)
  // Resource (T-238) — every tick-scalar (stamina/hunger/thirst/poise/…)
  // lives here. Server-only. Poise folded in at T-238d (the standalone
  // Poise component is gone).
  Resource,
  // BuffSpec (T-239) — a buff scene-graph child's modifier data. Server-
  // only. Inert until start_buff spawns one (phase 2b wires the callers).
  BuffSpec,
  Hearth,
  JobBoard,
  AssignedJobBoard,
  // POI runtime marker (T-212). Server-only — placed at each
  // narrative POI's zone centroid; PoiSystem fires the activity on
  // first player proximity.
  PoiTrigger,
  // Stair runtime marker (T-213). Server-only — placed at every narrative
  // stair anchor; carries lock state for the future unlock pipeline.
  Stair,
  NpcTag,
  NpcJobQueue,
  ProjectileData,
  AnimationSlots,
  // SpeedModifier + EncumbrancePenalty retired (T-239) — effective()
  // query replaces the composed-output components.
  // ── Instance-lifetime components (server-only) ──────────────────────────
  History,
  Owned,
  // ── Item-behaviour template defs ─────────────────────────────────────────
  // Declared on any prefab that represents a holdable/wearable/usable thing.
  // Server-only: clients reconstruct item behaviour from the prefab id they
  // already have.
  Equippable,
  Swingable,
  Tool,
  Deployable,
  Placeable,
  Illuminator,
  Armor,
  MaterialSource,
  Composed,
  Stackable,
  Weight,
];

/**
 * Look up a ComponentDef by its string name — the prefab loader's primary
 * index. Built once at module load; immutable afterwards.
 */
export const DEF_BY_NAME: ReadonlyMap<string, ComponentDef<any>> = (() => {
  const map = new Map<string, ComponentDef<any>>();
  for (const def of ALL_DEFS) {
    if (map.has(def.name)) {
      throw new Error(
        `[component_registry] duplicate component name "${def.name}"`,
      );
    }
    map.set(def.name, def);
  }
  return map;
})();
