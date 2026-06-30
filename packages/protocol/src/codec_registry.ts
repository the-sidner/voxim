/**
 * Networked-component decode registry: wire id → decoder. The single table the
 * client's delta/spawn decode loop dispatches through (replacing a 31-case
 * switch), so adding a networked component is one entry here, not a new switch
 * arm. Keyed by `ComponentType`; the server's analogous map is
 * `DEF_BY_TYPE_ID` (derived from `def.wireId`) — this is its client-shareable
 * twin, living in @voxim/protocol because it pairs ComponentType (here) with the
 * codecs (from @voxim/codecs, which protocol already depends on).
 *
 * Components whose decode has SIDE EFFECTS (terrain chunk binding for
 * heightmap/openMask/kindGrid) are still handled explicitly by the client; their
 * codec lives here too so the table is complete + round-trippable, the client
 * just runs the binding around the same decode.
 */
import { ComponentType } from "./component_types.ts";
import {
  positionCodec, velocityCodec, facingCodec, healthCodec,
  resourceCodec, actionCooldownsCodec, activeActionsCodec,
  heightmapCodec, materialGridCodec, openMaskCodec, kindGridCodec,
  vegFieldGridCodec, surfaceStateGridCodec, waterGridCodec,
  modelRefCodec, animationStateCodec, equipmentCodec, inventoryCodec,
  blueprintCodec, lightEmitterCodec, darknessModifierCodec, loreLoadoutCodec,
  durabilityCodec, craftingQueueCodec, itemDataCodec,
  workstationBufferCodec, workstationTagCodec, traderInventoryCodec, jobBoardCodec,
  statsCodec, provenanceCodec, worldClockCodec, gateLinkCodec, nameCodec,
  containerCodec,
} from "@voxim/codecs";

/** The only capability the decode loop needs — narrower than Serialiser, so each
 *  concrete `Serialiser<T>` is assignable here without a variance cast. */
export interface WireDecoder {
  decode(data: Uint8Array): unknown;
}

export const CODEC_BY_WIREID: ReadonlyMap<number, WireDecoder> = new Map<number, WireDecoder>([
  [ComponentType.position, positionCodec],
  [ComponentType.velocity, velocityCodec],
  [ComponentType.facing, facingCodec],
  [ComponentType.health, healthCodec],
  [ComponentType.resource, resourceCodec],
  [ComponentType.actionCooldowns, actionCooldownsCodec],
  [ComponentType.activeActions, activeActionsCodec],
  [ComponentType.heightmap, heightmapCodec],
  [ComponentType.materialGrid, materialGridCodec],
  [ComponentType.openMask, openMaskCodec],
  [ComponentType.kindGrid, kindGridCodec],
  [ComponentType.vegFieldGrid, vegFieldGridCodec],
  [ComponentType.surfaceStateGrid, surfaceStateGridCodec],
  [ComponentType.waterGrid, waterGridCodec],
  [ComponentType.modelRef, modelRefCodec],
  [ComponentType.animationState, animationStateCodec],
  [ComponentType.equipment, equipmentCodec],
  [ComponentType.inventory, inventoryCodec],
  [ComponentType.blueprint, blueprintCodec],
  [ComponentType.lightEmitter, lightEmitterCodec],
  [ComponentType.darknessModifier, darknessModifierCodec],
  [ComponentType.loreLoadout, loreLoadoutCodec],
  [ComponentType.durability, durabilityCodec],
  [ComponentType.craftingQueue, craftingQueueCodec],
  [ComponentType.itemData, itemDataCodec],
  [ComponentType.workstationBuffer, workstationBufferCodec],
  [ComponentType.workstationTag, workstationTagCodec],
  [ComponentType.traderInventory, traderInventoryCodec],
  [ComponentType.jobBoard, jobBoardCodec],
  [ComponentType.stats, statsCodec],
  [ComponentType.provenance, provenanceCodec],
  [ComponentType.worldClock, worldClockCodec],
  [ComponentType.gateLink, gateLinkCodec],
  [ComponentType.container, containerCodec],
  [ComponentType.name, nameCodec],
]);
