/**
 * The wireId→codec pairing, authored ONCE here (T-349) — the single table both
 * sides of the wire resolve through. The client's delta/spawn decode loop
 * dispatches on it directly; every networked ComponentDef (tile-server/world)
 * pulls its codec back OUT of it via `networkedCodec()` instead of importing
 * the raw codec from @voxim/codecs a second time, so the pairing cannot drift
 * (the heritage/16 and parent/49 silent-decode bugs were exactly that drift).
 * Lives in @voxim/protocol because it pairs ComponentType (here) with the
 * codecs (from @voxim/codecs, which protocol already depends on).
 *
 * Components whose decode has SIDE EFFECTS (terrain chunk binding for
 * heightmap/openMask/kindGrid) are still handled explicitly by the client; their
 * codec lives here too so the table is complete + round-trippable, the client
 * just runs the binding around the same decode.
 */
import { ComponentType } from "./component_types.ts";
import { Parent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import {
  positionCodec, velocityCodec, facingCodec, healthCodec,
  resourceCodec, actionCooldownsCodec, activeActionsCodec,
  heightmapCodec, materialGridCodec, openMaskCodec, kindGridCodec,
  vegFieldGridCodec, surfaceStateGridCodec, waterGridCodec, cliffGridCodec,
  modelRefCodec, animationStateCodec, equipmentCodec, inventoryCodec,
  blueprintCodec, lightEmitterCodec, loreLoadoutCodec,
  durabilityCodec, itemDataCodec,
  workstationBufferCodec, workstationTagCodec, traderInventoryCodec, jobBoardCodec,
  statsCodec, provenanceCodec, worldClockCodec, gateLinkCodec, nameCodec,
  containerCodec, poiInteractableCodec, heritageCodec, boneCodec,
} from "@voxim/codecs";

export const CODEC_BY_WIREID: ReadonlyMap<number, Serialiser<unknown>> = new Map<number, Serialiser<unknown>>([
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
  [ComponentType.cliffGrid, cliffGridCodec],
  [ComponentType.modelRef, modelRefCodec],
  [ComponentType.animationState, animationStateCodec],
  [ComponentType.equipment, equipmentCodec],
  [ComponentType.inventory, inventoryCodec],
  [ComponentType.blueprint, blueprintCodec],
  [ComponentType.lightEmitter, lightEmitterCodec],
  [ComponentType.loreLoadout, loreLoadoutCodec],
  [ComponentType.durability, durabilityCodec],
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
  [ComponentType.poiInteractable, poiInteractableCodec],
  // T-072: the client needs its own dynastyId/generation to know it just
  // respawned as an heir (a real Heritage.generation bump this session) and
  // to tell its own family's chests apart from a neighbouring dynasty's —
  // Heritage was networked (wireId 16) since T-079/T-270 but never reached
  // this table, so it silently decoded nowhere on the client.
  [ComponentType.heritage, heritageCodec],
  // T-215/T-219: Parent (engine-owned scene-graph link, wireId 49) was
  // registered in tile-server's NETWORKED_DEFS since T-215 but never reached
  // this table either — same silent-drop shape as heritage above. T-219 is
  // the first ticket that populates it at real scale (bone entities +
  // scene-graph-parented equipment), so this closes the gap before that
  // traffic starts.
  [ComponentType.parent, Parent.codec],
  // T-219: Bone — one entity per skeleton bone, boneId only (restPose/
  // parentBoneId are content data; transforms are never wired at all).
  [ComponentType.bone, boneCodec],
]);

/**
 * Resolve a networked component's codec from the one authoring site above
 * (T-349). Every networked `defineComponent()` call goes through this — a
 * wireId the table can't resolve throws at module load, before any bug
 * reaches the wire.
 */
export function networkedCodec<T>(wireId: number): Serialiser<T> {
  const codec = CODEC_BY_WIREID.get(wireId);
  if (!codec) {
    throw new Error(
      `[codec_registry] no codec registered for wire id ${wireId} — add it to ` +
        `CODEC_BY_WIREID, or list the id in PRESENCE_ONLY_WIRE_IDS if the ` +
        `client intentionally never decodes it (see resource_node).`,
    );
  }
  return codec as Serialiser<T>;
}

/**
 * Networked components with NO client decoder, by deliberate choice (not a
 * gap) — the boot cross-check in tile-server's component_registry.ts treats
 * membership here as an explicit opt-out. Such a component's def imports its
 * codec straight from @voxim/codecs (the server still encodes it); the client
 * sees it only as a presence marker via `EntityState.raw.has(name)`.
 *
 *   resource_node — the client only checks `raw.has("resource_node")` for
 *   hover/interaction; it never reads hitPoints or nodeTypeId off the wire.
 */
export const PRESENCE_ONLY_WIRE_IDS: ReadonlySet<number> = new Set([
  ComponentType.resource_node,
]);
