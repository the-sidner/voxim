/// <reference lib="dom" />
/**
 * Voxel editor — Layer A. Loads a ModelDefinition, renders it in the
 * viewport, surfaces structure via the scene tree, edits properties
 * via the inspector, saves the edited def back to disk.
 *
 * What's here (T-191b v1):
 *   - file pick → load model + load materials.json once
 *   - render the model in the viewport (instanced voxels, recursed sub-objects)
 *   - scene tree with voxels + sub-objects rows
 *   - inspector with material remap and sub-object transform/identity edits
 *   - "Add sub-object" + "Remove sub-object" actions
 *   - Save button — writes def back to models/<id>.json
 *
 * What's deferred (T-191b v2):
 *   - 3D translate/rotate/scale gizmos directly in the viewport
 *   - interactive voxel painting (click to add, shift-click remove)
 *   - generator-node spawning (waits on T-183)
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as THREE from "three";
import { Layout } from "../shell/Layout.tsx";
import { AssetBrowser } from "../shell/AssetBrowser.tsx";
import { ViewportPane } from "../shell/ViewportPane.tsx";
import { readJson, writeJson } from "../shell/file_io.ts";
import type { Viewport } from "../shell/viewport.ts";
import type { ModelDefinition, MaterialDef } from "./model_types.ts";
import { defaultSubTransform } from "./model_types.ts";
import { renderModel } from "./voxel_render.ts";
import { SceneTree, type Selection } from "./SceneTree.tsx";
import { Inspector } from "./Inspector.tsx";
import { buildSkeletonView, type SkeletonView } from "../animation-editor/skeleton_view.ts";

const FILTER_DIRS = ["models", "materials"];

type Mode = "edit" | "preview";

// Biped skeleton path — preview overlay loads this to demo the model
// in a held-weapon context.
const PREVIEW_SKELETON = "skeletons/biped.json";

export function VoxelEditor() {
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [def, setDef]               = useState<ModelDefinition | null>(null);
  const [dirty, setDirty]           = useState(false);
  const [selection, setSelection]   = useState<Selection>(null);
  const [materials, setMaterials]   = useState<Map<number, MaterialDef>>(new Map());
  const [subDefs, setSubDefs]       = useState<Map<string, ModelDefinition>>(new Map());
  const viewportRef = useRef<Viewport | null>(null);
  const renderedRef = useRef<{ dispose(): void } | null>(null);
  const [mode, setMode] = useState<Mode>("edit");
  const previewRef = useRef<{ dispose(): void } | null>(null);

  // Load materials once on mount — the inspector needs them for the
  // remap palette and the renderer needs them for voxel colours.
  useEffect(() => {
    (async () => {
      try {
        const list = await readJson<MaterialDef[]>("materials.json");
        const map = new Map<number, MaterialDef>();
        for (const m of list) map.set(m.id, m);
        setMaterials(map);
      } catch (e) {
        console.warn("voxel editor: materials load failed:", e);
      }
    })();
  }, []);

  // Load the picked file.
  useEffect(() => {
    if (!pickedPath || !pickedPath.startsWith("models/")) return;
    (async () => {
      try {
        const m = await readJson<ModelDefinition>(pickedPath);
        setDef(m);
        setDirty(false);
        setSelection(null);
      } catch (e) {
        console.warn("voxel editor: load failed:", e);
      }
    })();
  }, [pickedPath]);

  // Eagerly load sub-models referenced by the current def so the
  // viewport can render attached children (axe with handle sub-object,
  // etc.). Each unique sub-id is fetched once and cached.
  useEffect(() => {
    if (!def) return;
    const needed = new Set<string>();
    for (const sub of def.subObjects) {
      const id = sub.modelId ?? sub.pool?.[0];
      if (id && !subDefs.has(id)) needed.add(id);
    }
    if (needed.size === 0) return;
    (async () => {
      const updated = new Map(subDefs);
      for (const id of needed) {
        try {
          const m = await readJson<ModelDefinition>(`models/${id}.json`);
          updated.set(id, m);
        } catch {
          // missing referenced model — leave un-cached, renderer shows
          // the orange placeholder cube.
        }
      }
      setSubDefs(updated);
    })();
  }, [def]);

  // Build / rebuild the rendered model whenever def, sub-deps, mode, or
  // selection change. Two modes:
  //   edit:    render the model directly at origin (current behaviour).
  //   preview: load a biped skeleton, attach the model to hand_r as if
  //            it were equipped, frame on the actor. Scene-preview
  //            overlay for T-191d.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || !def) return;
    renderedRef.current?.dispose();
    previewRef.current?.dispose();
    renderedRef.current = null;
    previewRef.current = null;

    if (mode === "edit") {
      const r = renderModel(
        def,
        materials,
        (id) => subDefs.get(id),
        selection?.kind === "sub" ? selection.index : undefined,
      );
      vp.contentGroup.add(r.group);
      vp.frame(r.bbox);
      renderedRef.current = r;
      return () => { r.dispose(); };
    }

    // Preview mode — load biped skeleton, render the live in-memory
    // model into the hand bone. We render directly here instead of
    // going through attachEquipment(), which loads from disk —
    // unsaved edits need to be visible in preview.
    let cancelled = false;
    const teardown: Array<() => void> = [];
    (async () => {
      try {
        const sk = await readJson<{ bones: { id: string; parent: string | null; restX: number; restY: number; restZ: number; restRotX?: number; restRotY?: number; restRotZ?: number }[] }>(PREVIEW_SKELETON);
        if (cancelled) return;
        const view: SkeletonView = buildSkeletonView(sk.bones, { scale: 1 });
        vp.contentGroup.add(view.group);
        teardown.push(() => view.dispose());

        const handBone = view.boneGroups.get("hand_r");
        if (handBone) {
          // AABB-bottom anchor — same algebra the engine renderer
          // uses so the pommel sits at the hand, not the model origin.
          let minZ = Infinity;
          for (const n of def.nodes) if (n.z < minZ) minZ = n.z;
          if (minZ === Infinity) minZ = 0;

          const rendered = renderModel(def, materials, (id) => subDefs.get(id));
          rendered.group.position.set(0, -minZ, 0);
          handBone.add(rendered.group);
          teardown.push(() => rendered.dispose());
        }

        vp.frame(view.bbox, 1.6);
        if (cancelled) { for (const t of teardown) t(); return; }
        previewRef.current = { dispose: () => { for (const t of teardown) t(); } };
      } catch (e) {
        console.warn("voxel editor preview: skeleton load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
      for (const t of teardown) t();
    };
  }, [def, materials, subDefs, selection, mode]);

  const save = async () => {
    if (!pickedPath || !def) return;
    try {
      // Always serialise materials = de-duped sorted union of voxel
      // material ids. Authors don't need to keep this in sync; the
      // editor is the source of truth.
      const next: ModelDefinition = {
        ...def,
        materials: [...new Set(def.nodes.map((n) => n.materialId))].sort((a, b) => a - b),
      };
      await writeJson(pickedPath, next);
      setDef(next);
      setDirty(false);
    } catch (e) {
      alert(`save failed: ${(e as Error).message}`);
    }
  };

  const addSub = () => {
    if (!def) return;
    setDef({
      ...def,
      subObjects: [...def.subObjects, { transform: defaultSubTransform() }],
    });
    setSelection({ kind: "sub", index: def.subObjects.length });
    setDirty(true);
  };

  const onChange = (next: ModelDefinition) => {
    setDef(next);
    setDirty(true);
  };

  return (
    <Layout
      topBar={<EditorTopBar
        path={pickedPath}
        dirty={dirty}
        onSave={save}
        onAddSub={addSub}
        canEdit={!!def}
        mode={mode}
        onModeChange={setMode}
      />}
      left={
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: "auto", borderBottom: "1px solid #2a2a30" }}>
            <AssetBrowser filter={FILTER_DIRS} onPickFile={setPickedPath} />
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            <div style={{ padding: "6px 10px", color: "#888", fontSize: 11, borderBottom: "1px solid #2a2a30" }}>
              Scene
            </div>
            <SceneTree def={def} selection={selection} onSelect={setSelection} />
          </div>
        </div>
      }
      centre={<ViewportPane onReady={(vp) => { viewportRef.current = vp; }} />}
      right={
        <Inspector
          def={def}
          selection={selection}
          materials={materials}
          onChange={onChange}
        />
      }
    />
  );
}

function EditorTopBar({ path, dirty, onSave, onAddSub, canEdit, mode, onModeChange }: {
  path: string | null;
  dirty: boolean;
  onSave: () => void;
  onAddSub: () => void;
  canEdit: boolean;
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", width: "100%", gap: 12 }}>
      <span style={{ color: "#aaa", fontSize: 12 }}>
        {path ?? "(no file)"} {dirty && <span style={{ color: "#ffcc77" }}>•</span>}
      </span>
      <div style={{ flex: 1 }} />
      <ModeToggle mode={mode} onPick={onModeChange} />
      <Button disabled={!canEdit} onClick={onAddSub}>+ sub-object</Button>
      <Button disabled={!canEdit || !dirty} onClick={onSave} primary>Save</Button>
    </div>
  );
}

function ModeToggle({ mode, onPick }: { mode: Mode; onPick: (m: Mode) => void }) {
  const opt = (id: Mode, label: string) => (
    <div
      onClick={() => onPick(id)}
      style={{
        cursor: "pointer",
        padding: "4px 10px",
        background: mode === id ? "#2a5a8a" : "transparent",
        color: mode === id ? "#fff" : "#888",
        fontSize: 11,
      }}
    >{label}</div>
  );
  return (
    <div style={{
      display: "flex",
      border: "1px solid #3a3a42",
      borderRadius: 3,
      overflow: "hidden",
    }}>
      {opt("edit",    "Edit")}
      {opt("preview", "Preview")}
    </div>
  );
}

function Button({ children, onClick, disabled, primary }: {
  children: preact.ComponentChildren;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: "4px 10px",
        background: disabled ? "#252528" : (primary ? "#2a5a8a" : "#222226"),
        color: disabled ? "#666" : "#fff",
        border: `1px solid ${disabled ? "#2a2a30" : (primary ? "#4080c0" : "#3a3a42")}`,
        borderRadius: 3,
        cursor: disabled ? "default" : "pointer",
        fontSize: 11,
      }}
    >{children}</button>
  );
}
