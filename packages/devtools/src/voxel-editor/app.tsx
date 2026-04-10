/**
 * Root editor layout.
 *
 * ┌─────────────────────────────┬──────────────────┐
 * │  Toolbar (top bar)          │                  │
 * ├─────────────────────────────┤  Sidebar (right) │
 * │                             │  - Materials     │
 * │  3D Viewport (canvas)       │  - Model meta    │
 * │                             │  - SubObjects    │
 * │                             │  - Selection     │
 * │                             │  - Export        │
 * └─────────────────────────────┴──────────────────┘
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { effect } from "@preact/signals";
import type { MaterialDef, SkeletonDef } from "@voxim/content";

import { Toolbar } from "./ui/toolbar.tsx";
import { MaterialPanel } from "./ui/material_panel.tsx";
import { ModelPanel } from "./ui/model_panel.tsx";
import { SubObjectPanel } from "./ui/subobject_panel.tsx";
import { SelectionPanel } from "./ui/selection_panel.tsx";
import { ExportPanel } from "./ui/export_panel.tsx";
import { ImportModal } from "./ui/import_modal.tsx";

import { init as initViewport, setVoxelMesh, setSubObjectMesh } from "./viewport.ts";
import {
  rebuildVoxelMesh, rebuildSubObjectMeshes,
  setCursorCell, setSelectionHighlight,
} from "./voxel_mesh.ts";
import { pick } from "./ray_pick.ts";
import { paintDown, paintMove, paintUp } from "./tools/paint.ts";
import { fillAt } from "./tools/fill.ts";
import { selectDown, selectMove, selectUp } from "./tools/select.ts";
import {
  voxels, subObjects, activeTool, activeLayer, undo,
  selectedVoxelKey, selectedSubObject, parseKey,
} from "./state.ts";
import type { BrowserContentStore } from "./content_loader.ts";

interface Props {
  content: BrowserContentStore;
}

export function App({ content }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showImport, setShowImport] = useState(false);
  const isPainting   = useRef(false);
  const isDraggingSub = useRef(false);

  const materials: MaterialDef[] = content.getAllMaterials();
  const skeletons: SkeletonDef[] = (() => {
    const ids = new Set<string>();
    for (const id of content.allModelIds) {
      const m = content.getModel(id);
      if (m?.skeletonId) ids.add(m.skeletonId);
    }
    return [...ids].map((id) => content.getSkeleton(id)).filter(Boolean) as SkeletonDef[];
  })();

  useEffect(() => {
    const canvas = canvasRef.current!;

    initViewport(canvas, {
      onPointerMove(e) {
        const mode   = activeTool.value;
        const result = pick(e, canvas, activeLayer.value);
        if (!result) { setCursorCell(null); return; }

        // Cursor only on grid picks in paint/erase/fill modes
        if (mode !== "select") setCursorCell(result.cell);
        else setCursorCell(null);

        if (mode === "select" && isDraggingSub.current) {
          selectMove(result);
        } else if (isPainting.current && (mode === "paint" || mode === "erase")) {
          paintMove(result, mode);
        }
      },
      onPointerDown(e) {
        if (e.button !== 0) return;
        const mode   = activeTool.value;
        const result = pick(e, canvas, activeLayer.value);
        if (!result) return;

        if (mode === "select") {
          selectDown(result);
          if (result.hitSubObjectIndex !== undefined) isDraggingSub.current = true;
        } else if (mode === "paint" || mode === "erase") {
          isPainting.current = true;
          paintDown(result, mode);
        } else if (mode === "fill") {
          fillAt(result);
        }
      },
      onPointerUp(_e) {
        if (isPainting.current)   { paintUp(); isPainting.current = false; }
        if (isDraggingSub.current) { selectUp(); isDraggingSub.current = false; }
      },
    });

    // Rebuild main voxel mesh when voxels change
    const disposeVoxels = effect(() => {
      setVoxelMesh(rebuildVoxelMesh(voxels.value, content));
    });

    // Rebuild subobject mesh when subobjects or selection changes
    const disposeSubObjects = effect(() => {
      setSubObjectMesh(rebuildSubObjectMeshes(subObjects.value, content, selectedSubObject.value));
    });

    // Drive selection highlight wireframe from selectedVoxelKey signal
    const disposeHighlight = effect(() => {
      const key = selectedVoxelKey.value;
      if (key === null) { setSelectionHighlight(null); return; }
      const [x, y, z] = parseKey(key);
      setSelectionHighlight({ x, y, z });
    });

    // Keyboard shortcuts
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "s" || e.key === "S") activeTool.value = "select";
      if (e.key === "p" || e.key === "P") activeTool.value = "paint";
      if (e.key === "e" || e.key === "E") activeTool.value = "erase";
      if (e.key === "f" || e.key === "F") activeTool.value = "fill";
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); }
      if (e.key === "[") activeLayer.value -= 1;
      if (e.key === "]") activeLayer.value += 1;
      if (e.key === "Escape") { selectedVoxelKey.value = null; selectedSubObject.value = null; }
    }
    window.addEventListener("keydown", onKey);

    return () => {
      disposeVoxels();
      disposeSubObjects();
      disposeHighlight();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", background: "#1a1a1a", borderBottom: "1px solid #333", flexShrink: 0 }}>
        <span style={{ padding: "6px 12px", color: "#4a9c3f", fontWeight: "bold", fontSize: 13 }}>VOXIM EDITOR</span>
        <div style={{ flex: 1 }}>
          <Toolbar />
        </div>
        <button onClick={() => setShowImport(true)} style={{
          margin: "0 8px", padding: "4px 10px", background: "#2a2a2a",
          border: "1px solid #555", color: "#aaa", cursor: "pointer",
          borderRadius: 3, fontSize: 11, fontFamily: "monospace",
        }}>Import</button>
      </div>

      {/* Main area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* 3D Viewport */}
        <canvas ref={canvasRef} style={{ flex: 1, display: "block", cursor: "crosshair" }} />

        {/* Right sidebar */}
        <div style={{
          width: 220, flexShrink: 0, background: "#1e1e1e",
          borderLeft: "1px solid #333", overflowY: "auto",
          display: "flex", flexDirection: "column",
        }}>
          <MaterialPanel materials={materials} />
          <ModelPanel skeletons={skeletons} />
          <SubObjectPanel />
          <SelectionPanel materials={materials} modelIds={content.allModelIds} skeletons={skeletons} />
          <ExportPanel />
        </div>
      </div>

      {showImport && (
        <ImportModal modelIds={content.allModelIds} onClose={() => setShowImport(false)} />
      )}
    </div>
  );
}
