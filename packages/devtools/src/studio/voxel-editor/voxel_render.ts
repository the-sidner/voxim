/**
 * Render a ModelDefinition into a Three.js Group.
 *
 * Voxels go into one InstancedMesh per material (cheap: a 1000-cell
 * model = a handful of draw calls, not 1000). Sub-objects are
 * recursed: each is its own nested Group with the authored transform.
 *
 * Pure rendering — owns no UI state. Callers replace the group when
 * the model changes, dispose() when leaving the editor.
 *
 * Axis convention matches the engine renderer: model (x, y, z) →
 * three.js (x, z, y) so the model's Z axis is up.
 */
import * as THREE from "three";
import type { ModelDefinition, MaterialDef, VoxelNode } from "./model_types.ts";

export interface RenderedModel {
  group: THREE.Group;
  dispose(): void;
  /** AABB in three.js coords — used by the viewport to frame the camera. */
  bbox: THREE.Box3;
}

const _box = new THREE.BoxGeometry(1, 1, 1);

export function renderModel(
  def: ModelDefinition,
  materials: Map<number, MaterialDef>,
  resolveSubModel: (id: string) => ModelDefinition | undefined,
  /** Optional sub-object outline highlight — passed sub-id is rendered with an outline. */
  highlightSubIndex?: number,
): RenderedModel {
  const group = new THREE.Group();
  group.name = `model:${def.id}`;
  const bbox = new THREE.Box3();
  const disposers: Array<() => void> = [];

  // Bucket voxels by material so we can use one InstancedMesh per bucket.
  const byMat = new Map<number, VoxelNode[]>();
  for (const n of def.nodes) {
    let bucket = byMat.get(n.materialId);
    if (!bucket) { bucket = []; byMat.set(n.materialId, bucket); }
    bucket.push(n);
  }

  for (const [matId, nodes] of byMat) {
    const def = materials.get(matId);
    const color = def?.color ?? 0x888888;
    const mat = new THREE.MeshLambertMaterial({
      color,
      emissive: def?.emissive ? new THREE.Color(color).multiplyScalar(def.emissive * 0.6) : 0x000000,
    });
    const inst = new THREE.InstancedMesh(_box, mat, nodes.length);
    const m = new THREE.Matrix4();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      // model (x, y, z) → three.js (x, z, y)
      m.makeTranslation(n.x, n.z, n.y);
      inst.setMatrixAt(i, m);
      bbox.expandByPoint(new THREE.Vector3(n.x - 0.5, n.z - 0.5, n.y - 0.5));
      bbox.expandByPoint(new THREE.Vector3(n.x + 0.5, n.z + 0.5, n.y + 0.5));
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    disposers.push(() => { mat.dispose(); inst.dispose(); });
  }

  // Sub-objects — recurse into their model defs (best effort: missing
  // models render as a tiny wireframe placeholder cube so the author
  // can still see where they attach).
  for (let i = 0; i < def.subObjects.length; i++) {
    const sub = def.subObjects[i];
    const subId = sub.modelId ?? sub.pool?.[0];
    const t = sub.transform;
    const subGroup = new THREE.Group();
    subGroup.name = `sub:${subId ?? "?"}`;
    subGroup.position.set(t.x, t.z, t.y);
    subGroup.rotation.set(t.rotX, t.rotZ, t.rotY);
    subGroup.scale.set(t.scaleX, t.scaleZ, t.scaleY);
    group.add(subGroup);

    if (highlightSubIndex === i) {
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.6, 0.6, 0.6)),
        new THREE.LineBasicMaterial({ color: 0x66ddff }),
      );
      subGroup.add(outline);
    }

    if (subId) {
      const childDef = resolveSubModel(subId);
      if (childDef) {
        const child = renderModel(childDef, materials, resolveSubModel);
        subGroup.add(child.group);
        disposers.push(child.dispose);
        bbox.union(child.bbox.clone().applyMatrix4(subGroup.matrixWorld));
      } else {
        // Placeholder: visible wireframe cube + label tail so authors
        // see "something here" even if the referenced model is missing.
        const wire = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
          new THREE.LineBasicMaterial({ color: 0xff8866 }),
        );
        subGroup.add(wire);
      }
    }
  }

  // Empty model? Make sure bbox isn't infinity.
  if (bbox.isEmpty()) bbox.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

  return {
    group,
    bbox,
    dispose() {
      for (const d of disposers) d();
      group.removeFromParent();
    },
  };
}
