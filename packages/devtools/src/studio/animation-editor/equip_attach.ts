/**
 * Equipment overlay — attach a weapon's voxel mesh to a bone in the
 * studio's skeleton view, using the same FK-driven math the engine
 * renderer uses (blade.baseLocal / blade.tipLocal × hand bone matrix).
 *
 * Layer B utility: imports the voxel renderer (Layer A) plus content
 * loaders (Layer B). The skeleton view is unchanged — we just
 * `add()` a new Group as a child of the named bone, with the weapon
 * model inside it.
 *
 * Returns a dispose hook the caller invokes when swapping equipment.
 */
import * as THREE from "three";
import { renderModel } from "../voxel-editor/voxel_render.ts";
import type { ModelDefinition, MaterialDef } from "../voxel-editor/model_types.ts";
import { readJson } from "../shell/file_io.ts";
import type { WeaponBlade } from "../shell/content_loader.ts";
import type { SkeletonView } from "./skeleton_view.ts";

export interface AttachedEquipment {
  modelId: string;
  prefabId: string;
  group: THREE.Group;
  dispose(): void;
}

export interface AttachOptions {
  /** Bone to parent the weapon to (e.g. "hand_r"). */
  holdBone: string;
  /** Weapon's overall scale — read from prefab.modelScale. */
  weaponScale: number;
  /**
   * Optional blade anchor — same shape as WeaponActionDef.blade. If
   * provided, the weapon's pommel (AABB min along Z) is placed at
   * `baseLocal` and the +Y axis is oriented toward `tipLocal`. If
   * absent, the weapon sits at the bone origin with no rotation
   * (suitable for shields, lanterns, anything without a blade).
   */
  blade?: WeaponBlade;
}

export async function attachEquipment(
  prefabId: string,
  modelId: string,
  view: SkeletonView,
  materials: Map<number, MaterialDef>,
  opts: AttachOptions,
): Promise<AttachedEquipment | null> {
  const bone = view.boneGroups.get(opts.holdBone);
  if (!bone) {
    console.warn(`equip: bone ${opts.holdBone} not in skeleton`);
    return null;
  }

  const def = await readJson<ModelDefinition>(`models/${modelId}.json`);

  // AABB scan for bottom-anchor offset (matches the engine renderer's
  // syncHandSlot logic: stretch the model so its lowest voxel sits at
  // the hand bone, not the authored origin which is typically mid-grip).
  let minZ = Infinity, maxZ = -Infinity;
  for (const n of def.nodes) {
    if (n.z < minZ) minZ = n.z;
    if (n.z + 1 > maxZ) maxZ = n.z + 1;
  }
  if (minZ === Infinity) { minZ = 0; maxZ = 0; }

  const wrap = new THREE.Group();
  wrap.name = `equip:${prefabId}`;

  const rendered = renderModel(def, materials, () => undefined);
  // Scale the voxel mesh by weaponScale (modelScale was the size knob
  // the engine renderer applies to held items).
  rendered.group.scale.setScalar(opts.weaponScale);
  // Bottom-anchor: shift the model so model-Z min sits at three.js y=0
  // (the bone origin). Same algebra as renderer.ts:1543-ish.
  rendered.group.position.set(0, -minZ * opts.weaponScale, 0);

  wrap.add(rendered.group);

  // Orient the wrap according to the blade direction (in hand-local
  // coords). If no blade declared, leave at identity — weapon hangs
  // along the bone's local +Y (finger direction).
  if (opts.blade) {
    const base = new THREE.Vector3(opts.blade.baseLocal[0], opts.blade.baseLocal[1], opts.blade.baseLocal[2]);
    const tip  = new THREE.Vector3(opts.blade.tipLocal[0],  opts.blade.tipLocal[1],  opts.blade.tipLocal[2]);
    const dir  = tip.clone().sub(base).normalize();
    wrap.position.copy(base);
    if (dir.lengthSq() > 0.001) {
      wrap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    }
  }

  bone.add(wrap);

  return {
    modelId,
    prefabId,
    group: wrap,
    dispose() {
      bone.remove(wrap);
      rendered.dispose();
    },
  };
}
