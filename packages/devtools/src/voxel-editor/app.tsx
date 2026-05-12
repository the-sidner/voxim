/**
 * Root editor layout.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │  Tab bar: [Voxel] [Animate]  +  mode-specific controls   │
 * ├──────────────────────────────────────────────┬───────────┤
 * │                                              │  Sidebar  │
 * │  3D Viewport (canvas) — shared              │  (voxel   │
 * │  Voxel mode: voxels + subobjects            │   or anim │
 * │  Animate mode: skeleton bones + spheres     │   panels) │
 * │                                              │           │
 * ├──────────────────────────────────────────────┴───────────┤
 * │  [Animate mode only] Timeline panel (full width)         │
 * └──────────────────────────────────────────────────────────┘
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { effect, signal } from "@preact/signals";
import * as THREE from "three";
import type { MaterialDef, SkeletonDef } from "@voxim/content";
import { evaluateAnimationLayers, buildClipIndex, buildMaskIndex } from "@voxim/content";

// ---- voxel editor imports ----
import { Toolbar } from "./ui/toolbar.tsx";
import { MaterialPanel } from "./ui/material_panel.tsx";
import { ModelPanel } from "./ui/model_panel.tsx";
import { SubObjectPanel } from "./ui/subobject_panel.tsx";
import { SelectionPanel } from "./ui/selection_panel.tsx";
import { ExportPanel } from "./ui/export_panel.tsx";
import { ImportModal } from "./ui/import_modal.tsx";

import { init as initViewport, setVoxelMesh, setSubObjectMesh, setFrameListener } from "./viewport.ts";
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

// ---- animate editor imports ----
import { AnimSidebar } from "./animate/ui/anim_sidebar.tsx";
import { PlaybackPanel } from "./animate/ui/playback_panel.tsx";
import { TimelinePanel } from "./animate/ui/timeline_panel.tsx";
import {
  editingSkeleton, editingClip, scrubTime, isPlaying, selectedBoneId,
} from "./animate/anim_state.ts";
import { buildSkeletonView, clearSkeletonView, applyPoseToView, resetToRestPose, highlightBone } from "./animate/skeleton_view.ts";
import { pickBone } from "./animate/bone_pick.ts";

// ---- library editor imports ----
import { LibraryPanel } from "./library/ui/library_panel.tsx";

import type { BrowserContentStore } from "./content_loader.ts";

// ---- editor mode ----

const editorMode = signal<"voxel" | "animate" | "library">("voxel");

// ---- component ----

interface Props {
  content: BrowserContentStore;
}

export function App({ content }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showImport, setShowImport] = useState(false);
  const isPainting    = useRef(false);
  const isDraggingSub = useRef(false);
  // Track last known scrub time for playback delta
  const lastFrameMs = useRef<number>(performance.now());
  const playingRef = useRef(false);

  const materials: MaterialDef[] = content.materials.values();
  const skeletons: SkeletonDef[] = (() => {
    const ids = new Set<string>();
    for (const id of content.allModelIds) {
      const m = content.models.get(id);
      if (m?.skeletonId) ids.add(m.skeletonId);
    }
    return [...ids].map((id) => content.skeletons.get(id)).filter(Boolean) as SkeletonDef[];
  })();

  useEffect(() => {
    const canvas = canvasRef.current!;

    initViewport(canvas, {
      onPointerMove(e) {
        if (editorMode.value === "animate") {
          // In animate mode, orbit is still active — nothing else needed on move
          return;
        }
        const mode   = activeTool.value;
        const result = pick(e, canvas, activeLayer.value);
        if (!result) { setCursorCell(null); return; }

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

        if (editorMode.value === "animate") {
          // Bone picking in animate mode
          const boneId = pickBone(e, canvas);
          selectedBoneId.value = boneId;
          return;
        }

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
        if (isPainting.current)    { paintUp(); isPainting.current = false; }
        if (isDraggingSub.current) { selectUp(); isDraggingSub.current = false; }
      },
    });

    // ---- Voxel mode effects ----

    const disposeVoxels = effect(() => {
      if (editorMode.value === "voxel") {
        setVoxelMesh(rebuildVoxelMesh(voxels.value, content));
      }
    });

    const disposeSubObjects = effect(() => {
      if (editorMode.value === "voxel") {
        setSubObjectMesh(rebuildSubObjectMeshes(subObjects.value, content, selectedSubObject.value));
      }
    });

    const disposeHighlight = effect(() => {
      if (editorMode.value !== "voxel") return;
      const key = selectedVoxelKey.value;
      if (key === null) { setSelectionHighlight(null); return; }
      const [x, y, z] = parseKey(key);
      setSelectionHighlight({ x, y, z });
    });

    // ---- Animate mode: build/clear skeleton view when skeleton or mode changes ----

    const disposeSkeletonView = effect(() => {
      const mode = editorMode.value;
      const sk = editingSkeleton.value;
      if (mode === "animate" && sk) {
        buildSkeletonView(sk);
        setVoxelMesh(null);
        setSubObjectMesh(null);
      } else if (mode === "voxel") {
        clearSkeletonView();
        // Voxel effects above will re-add voxel meshes automatically
      }
    });

    // ---- Animate mode: per-frame playback + pose evaluation ----

    setFrameListener(() => {
      if (editorMode.value !== "animate") return;

      const now = performance.now();
      const dtMs = now - lastFrameMs.current;
      lastFrameMs.current = now;

      // Advance playback
      if (playingRef.current) {
        const clip = editingClip.value;
        const dur = clip?.durationSeconds ?? 1.0;
        let t = scrubTime.value + (dtMs / 1000) / dur;
        if (clip?.loop) {
          t = t % 1;
        } else {
          t = Math.min(1, t);
          if (t >= 1) { isPlaying.value = false; playingRef.current = false; }
        }
        scrubTime.value = t;
      }

      // Evaluate skeleton pose
      const sk = editingSkeleton.value;
      const clip = editingClip.value;
      if (!sk) { resetToRestPose(); return; }

      if (!clip) { resetToRestPose(); return; }

      const clipIndex = buildClipIndex(sk);
      const maskIndex = buildMaskIndex(sk);
      const layers = [{ clipId: clip.id, maskId: "", time: scrubTime.value, weight: 1.0, blend: "override" as const, speedScale: 1.0 }];
      const boneRotations = evaluateAnimationLayers(sk, clipIndex, maskIndex, layers);
      const pose = new Map<string, THREE.Euler>();
      for (const [boneId, rot] of boneRotations) {
        pose.set(boneId, new THREE.Euler(rot.x, rot.y, rot.z));
      }
      applyPoseToView(pose);
      highlightBone(selectedBoneId.value);
    });

    // ---- Keyboard shortcuts ----
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (editorMode.value === "voxel") {
        if (e.key === "s" || e.key === "S") activeTool.value = "select";
        if (e.key === "p" || e.key === "P") activeTool.value = "paint";
        if (e.key === "e" || e.key === "E") activeTool.value = "erase";
        if (e.key === "f" || e.key === "F") activeTool.value = "fill";
        if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); }
        if (e.key === "[") activeLayer.value -= 1;
        if (e.key === "]") activeLayer.value += 1;
        if (e.key === "Escape") { selectedVoxelKey.value = null; selectedSubObject.value = null; }
      }

      if (editorMode.value === "animate") {
        if (e.key === " ") { e.preventDefault(); isPlaying.value = !isPlaying.value; }
        if (e.key === "Escape") { selectedBoneId.value = null; }
      }
    }
    window.addEventListener("keydown", onKey);

    return () => {
      disposeVoxels();
      disposeSubObjects();
      disposeHighlight();
      disposeSkeletonView();
      setFrameListener(null);
      clearSkeletonView();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Keep playingRef in sync with signal (signal reads inside setFrameListener are fine
  // but we also need the ref for the closure delta calc above)
  useEffect(() => {
    return effect(() => {
      playingRef.current = isPlaying.value;
      lastFrameMs.current = performance.now(); // reset delta on play state change
    });
  }, []);

  const mode = editorMode.value;

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>

      {/* ── Top bar ── */}
      <div class="dt-topbar">
        <span class="dt-brand">Voxim · Editor</span>

        {/* Mode tabs */}
        <button
          class={`dt-tab ${mode === "voxel" ? "is-active" : ""}`}
          onClick={() => { editorMode.value = "voxel"; }}
        >Voxel</button>
        <button
          class={`dt-tab ${mode === "animate" ? "is-active" : ""}`}
          onClick={() => { editorMode.value = "animate"; }}
        >Animate</button>
        <button
          class={`dt-tab ${mode === "library" ? "is-active" : ""}`}
          onClick={() => { editorMode.value = "library"; }}
        >Library</button>

        {/* Mode-specific toolbar content */}
        <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
          {mode === "voxel" && <Toolbar />}
          {mode === "animate" && <PlaybackPanel />}
        </div>

        {mode === "voxel" && (
          <button
            class="btn sm"
            style={{ margin: "auto var(--s-3) auto var(--s-3)" }}
            onClick={() => setShowImport(true)}
          >Import</button>
        )}
      </div>

      {/* ── Main area ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", flexDirection: "column" }}>
        {mode === "library" && (
          <LibraryPanel content={content} />
        )}
        {mode !== "library" && (
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* 3D Viewport */}
          <canvas
            ref={canvasRef}
            style={{ flex: 1, display: "block", cursor: mode === "animate" ? "default" : "crosshair" }}
          />

          {/* Right sidebar */}
          {mode === "voxel" && (
            <div class="dt-sidebar">
              <MaterialPanel materials={materials} />
              <ModelPanel skeletons={skeletons} />
              <SubObjectPanel />
              <SelectionPanel materials={materials} modelIds={content.allModelIds} skeletons={skeletons} />
              <ExportPanel />
            </div>
          )}

          {mode === "animate" && (
            <AnimSidebar skeletons={skeletons} />
          )}
        </div>
        )}

        {/* Timeline (animate mode only, below viewport) */}
        {mode === "animate" && (
          <div style={{
            flexShrink: 0, maxHeight: "35%", overflowY: "auto",
            borderTop: "1px solid var(--line-strong)",
            background: "var(--moss)",
          }}>
            <TimelinePanel />
          </div>
        )}
      </div>

      {showImport && (
        <ImportModal modelIds={content.allModelIds} onClose={() => setShowImport(false)} />
      )}
    </div>
  );
}
