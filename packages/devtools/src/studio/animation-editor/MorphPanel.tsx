/// <reference lib="dom" />
/**
 * Morph panel — Layer A (T-186 Layer 2 authoring tool). One slider per
 * skeleton.morphParams entry; on change, re-voxelizes skeleton.bodyRecipe via
 * the REAL shared evaluateBodyRecipe() (the exact function
 * entity_mesh_registry.ts and hitbox_derive.ts call in-game — no
 * re-implementation, no drift, same discipline as the Material/ProcModel
 * panels) and renders the resulting atoms as simple boxes parented into the
 * existing skeleton_view.ts bone groups, so the recipe body is visible
 * directly against the same rig the clip player already draws.
 *
 * Read-only preview: this panel does not write morph values back to disk
 * (that's the character-creator UI, T-186's still-open auxiliary work) — its
 * job is "does this recipe read as a body / stay watertight across the
 * slider range", which is exactly what the ticket's Studio verification bar
 * asks for.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as THREE from "three";
import { evaluateBodyRecipe } from "@voxim/content";
import type { SkeletonView } from "./skeleton_view.ts";

interface MorphParamLike {
  id: string;
  min: number;
  max: number;
}

interface BodyPartRecipeLike {
  boneId: string;
  shape: "capsule" | "tapered_box";
  length: number | string;
  radiusOrWidthTop: number | string;
  radiusOrWidthBot?: number | string;
  material: string;
}

interface BodyRecipeLike {
  voxelSize: number;
  parts: BodyPartRecipeLike[];
}

export interface MorphSkeletonLike {
  id: string;
  morphParams?: MorphParamLike[];
  bodyRecipe?: BodyRecipeLike;
}

interface MaterialLike {
  id: number;
  name: string;
  color: number;
}

export function MorphPanel({
  skeleton,
  skeletonView,
  materials,
}: {
  skeleton: MorphSkeletonLike | null;
  skeletonView: SkeletonView | null;
  materials: Map<number, MaterialLike>;
}) {
  const [values, setValues] = useState<Record<string, number>>({});
  const previewGroupRef = useRef<THREE.Group | null>(null);

  // Reset sliders to the midpoint of each morphParam's range whenever the
  // skeleton changes.
  useEffect(() => {
    if (!skeleton?.morphParams) { setValues({}); return; }
    const mid: Record<string, number> = {};
    for (const p of skeleton.morphParams) mid[p.id] = (p.min + p.max) / 2;
    setValues(mid);
  }, [skeleton?.id]);

  const nameToId = useMemo(() => {
    const m = new Map<string, number>();
    for (const mat of materials.values()) m.set(mat.name, mat.id);
    return m;
  }, [materials]);

  // Rebuild the preview meshes whenever the recipe, slider values, or the
  // skeleton view itself changes.
  useEffect(() => {
    previewGroupRef.current?.removeFromParent();
    previewGroupRef.current?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[];
        (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose());
      }
    });
    previewGroupRef.current = null;

    if (!skeleton?.bodyRecipe || !skeletonView) return;

    const group = new THREE.Group();
    group.name = "morph-recipe-preview";

    const resolveMaterial = (name: string): number => nameToId.get(name) ?? -1;
    const atomsByBone = evaluateBodyRecipe(skeleton.bodyRecipe, values, resolveMaterial);

    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const [boneId, atoms] of atomsByBone) {
      const boneGroup = skeletonView.boneGroups.get(boneId);
      if (!boneGroup || atoms.length === 0) continue;
      for (const atom of atoms) {
        const matDef = materials.get(atom.materialId);
        const mat = new THREE.MeshLambertMaterial({
          color: matDef?.color ?? 0xc8a882,
          transparent: true,
          opacity: 0.85,
        });
        const mesh = new THREE.Mesh(geo, mat);
        // model space (x=right, y=fwd, z=up) -> three.js (x, z, y), matching
        // skeleton_view.ts's own bone-position convention.
        mesh.position.set(atom.cx, atom.cz, atom.cy);
        mesh.scale.set(atom.sx, atom.sz, atom.sy);
        boneGroup.add(mesh);
        group.add(mesh);
      }
    }
    previewGroupRef.current = group;

    return () => {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          const mat = mesh.material as THREE.Material | THREE.Material[];
          (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose());
        }
      });
    };
    // deno-lint-ignore no-explicit-any
  }, [skeleton, skeletonView, values, nameToId] as any);

  if (!skeleton) {
    return <div style={{ padding: 12, color: "var(--bone-dim)", fontSize: 12 }}>
      Pick a skeleton from <code>skeletons/</code> to start.
    </div>;
  }
  if (!skeleton.morphParams?.length) {
    return <div style={{ padding: 12, color: "var(--bone-dim)", fontSize: 12 }}>
      "{skeleton.id}" declares no morphParams.
    </div>;
  }
  if (!skeleton.bodyRecipe) {
    return <div style={{ padding: 12, color: "var(--rot)", fontSize: 12 }}>
      "{skeleton.id}" has morphParams but no bodyRecipe (T-186 Layer 2) — sliders
      would move the bones with nothing to preview.
    </div>;
  }

  return (
    <div style={{ padding: 12, fontSize: 11 }}>
      <div style={{ color: "var(--aether-hi)", fontWeight: 600, marginBottom: 8 }}>
        Body recipe — {skeleton.bodyRecipe.parts.length} parts
      </div>
      {skeleton.morphParams.map((p) => (
        <div key={p.id} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--bone-dim)" }}>
            <span>{p.id}</span>
            <span>{(values[p.id] ?? p.min).toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={p.min}
            max={p.max}
            step={(p.max - p.min) / 100}
            value={values[p.id] ?? p.min}
            onInput={(e) => {
              const v = parseFloat((e.target as HTMLInputElement).value);
              setValues((prev) => ({ ...prev, [p.id]: v }));
            }}
            style={{ width: "100%" }}
          />
        </div>
      ))}
      <button
        onClick={() => {
          if (!skeleton.morphParams) return;
          const mid: Record<string, number> = {};
          for (const p of skeleton.morphParams) mid[p.id] = (p.min + p.max) / 2;
          setValues(mid);
        }}
        style={{ marginTop: 4 }}
      >Reset to midpoint</button>
      <div style={{ marginTop: 6 }}>
        <button
          onClick={() => {
            if (!skeleton.morphParams) return;
            const min: Record<string, number> = {};
            for (const p of skeleton.morphParams) min[p.id] = p.min;
            setValues(min);
          }}
        >All min</button>
        {" "}
        <button
          onClick={() => {
            if (!skeleton.morphParams) return;
            const max: Record<string, number> = {};
            for (const p of skeleton.morphParams) max[p.id] = p.max;
            setValues(max);
          }}
        >All max</button>
      </div>
    </div>
  );
}
