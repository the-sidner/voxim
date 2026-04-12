# Voxel Editor — Devtools Plan

## Goal

A browser-based 3D voxel model editor that reads and writes the native `ModelDefinition` format
from `packages/content/data/models.json`. Runs standalone (no tile-server). Uses the same shared
code the client uses: `@voxim/content`, `@voxim/engine`, Three.js, Preact.

Features:
- 3D viewport with orbit camera and grid floor
- Click/drag to place/erase voxels; fill tool for volume painting
- Material picker driven by `materials.json`
- SubObject manager for nested models (pool variants, transforms, bone attachment)
- Import/export `ModelDefinition` JSON (paste into models.json directly)

---

## What the engine already offers — reuse without change

| Existing piece | Where it lives | How the editor uses it |
|----------------|---------------|------------------------|
| `ModelDefinition`, `VoxelNode`, `SubObjectRef` types | `packages/content/src/types.ts` | Editor's native data model. No conversion. |
| `MaterialDef` with `.color`, `.name`, physical props | `packages/content/src/types.ts` | Drives material picker swatches. |
| `ContentStore` / `StaticContentStore` | `packages/content/src/store.ts` | Load materials, models (for SubObjectRef modelId dropdown), skeletons (for boneId dropdown). |
| `material_textures.ts` | `packages/client/src/render/` | Reused as-is for material swatch thumbnails and voxel face textures. |
| `ik_solver.ts`, `skeleton_evaluator.ts` | `packages/client/src/render/` | Not used in editor — pure data editing, no animation playback needed. |
| Three.js | client's `deno.json` import map | 3D scene, geometry, raycasting. |
| Preact + signals | client's `deno.json` import map | Editor UI. |

`entity_mesh.ts` (`buildDisplacedVoxelGeo`) is **not** reused in the editor — displacement offsets
vertices away from grid positions, which would make click-picking confusing. The editor builds its
own axis-aligned voxel mesh with exact 1-unit cubes. The displacement version is still used when
previewing the in-game appearance (a separate "preview mode" button in the viewport).

---

## Package structure

```
packages/devtools/
  deno.json                     — imports: three, preact, @voxim/content, @voxim/engine
  mod.ts                        — empty (no public API; tool only)
  src/
    voxel-editor/
      main.tsx                  — mounts <App /> into DOM
      app.tsx                   — root layout: <Viewport> + <Sidebar>
      state.ts                  — EditorState, signals, undo stack
      viewport.ts               — Three.js scene: camera, grid, lights, render loop
      voxel_mesh.ts             — VoxelNode[] → THREE.InstancedMesh (one instance per voxel)
      ray_pick.ts               — mousemove/click → grid cell (x,y,z) or voxel face
      tools/
        paint.ts                — place/erase single voxel on click
        fill.ts                 — 6-connected flood fill within bounding box
      ui/
        toolbar.tsx             — tool mode selector (paint / erase / fill / subobject)
        material_panel.tsx      — scrollable material grid with colored swatches
        model_panel.tsx         — model id, hitbox AABB editor, skeletonId picker
        subobject_panel.tsx     — list SubObjectRefs; add/edit each ref
        export_panel.tsx        — preview JSON + Copy to clipboard button
        import_modal.tsx        — paste JSON or pick model ID from content store
  dist/
    voxel_editor.html           — minimal HTML shell
    voxel_editor.js             — esbuild output

scripts/
  build_voxel_editor.ts         — esbuild, mirrors build_client.ts
  serve_devtools.ts             — static HTTP server (Deno.serve) on port 8888
```

Add to root `deno.json`:
```json
"devtools":            "deno task build-voxel-editor && deno run -A scripts/serve_devtools.ts",
"build-voxel-editor":  "deno run -A scripts/build_voxel_editor.ts"
```

Add `"packages/devtools"` to `workspace` array in root `deno.json`.

---

## Editor state model (`state.ts`)

```typescript
// Voxel grid — the primary model data
type VoxelKey = `${number},${number},${number}`;    // "x,y,z"

interface EditorState {
  // Model metadata
  modelId: string;
  hitbox: { minX: number; minY: number; minZ: number;
            maxX: number; maxY: number; maxZ: number };
  skeletonId: string | null;

  // Voxels
  voxels: Map<VoxelKey, MaterialId>;                // source of truth for the grid

  // SubObjects
  subObjects: SubObjectRef[];

  // UI state
  activeMaterial: MaterialId;
  activeTool: "paint" | "erase" | "fill" | "subobject";
  selectedSubObject: number | null;                 // index into subObjects

  // Undo
  undoStack: VoxelPatch[];                          // list of inverse patches
}

// A patch records the before-state of changed cells for undo
type VoxelPatch = Map<VoxelKey, MaterialId | null>;  // null = was absent
```

All state is plain signals (`@preact/signals`) so UI panels re-render automatically on change.
No ECS — the editor manipulates a `ModelDefinition`-shaped data structure directly.

Undo: every tool action pushes a `VoxelPatch` onto `undoStack`. `Ctrl+Z` pops the stack and
applies the inverse. Cap at 128 patches.

---

## Viewport (`viewport.ts`)

```
Camera:     THREE.PerspectiveCamera, 60° FoV
            Default position: (8, 12, 16) looking at (4, 4, 4)
            Mouse-drag orbit implemented manually (mousedown + mousemove + mouseup)
            Scroll to zoom (FOV or dolly)

Lights:     AmbientLight (0.6) + DirectionalLight (1.2) at (10, 20, 10)

Floor grid: THREE.GridHelper 32×32, 1-unit cells — visual reference only

Axes:       THREE.AxesHelper at origin

Cursor:     A wireframe unit cube that follows the hovered grid cell (ghost voxel preview)

Render:     requestAnimationFrame loop, ~60 Hz. No post-processing (editor clarity > aesthetics).
```

Two display modes toggled by a button:
- **Editor mode** — exact 1-unit axis-aligned cubes, face colors from `MaterialDef.color`
- **Preview mode** — calls `buildDisplacedVoxelGeo` from `entity_mesh.ts` to show the in-game look with displacement and procedural textures

---

## Voxel mesh builder (`voxel_mesh.ts`)

Uses `THREE.InstancedMesh` with a `BoxGeometry(1,1,1)`:
- One instance per voxel
- Per-instance color set from `MaterialDef.color` via `InstancedMesh.setColorAt()`
- Rebuilt incrementally: on each edit, only the changed instance index is updated (not a full
  rebuild), using instance ID = stable index in a flat `VoxelNode[]` derived from the map

Face culling: adjacent-face removal. For each voxel, skip faces that are shared with a
neighbouring voxel (6-connectivity check into the map). Use `THREE.BufferGeometry` with
`addGroup()` per exposed face, so we can assign a `MeshLambertMaterial` per material group —
this mirrors how `entity_mesh.ts` handles it and gives correct per-face material colors.

For simplicity in the initial implementation: one mesh, all faces always rendered,
color from `MaterialDef.color`. Add face culling as an optimization pass later.

---

## Ray picking (`ray_pick.ts`)

Two picking modes:

**Face pick** — when hovering over an existing voxel:
Use `THREE.Raycaster.intersectObject()` on the instanced mesh. The intersection gives a face
normal. Place new voxel at `hitCell + normal` (adjacent cell). Erase targets `hitCell`.

**Grid pick** — when hovering over empty space:
Cast ray against the Y=0 plane (or Y=activeLayer plane). Returns the nearest integer grid cell.
For multi-layer editing, a keyboard shortcut (`[` / `]`) shifts the active Y layer up/down;
the cursor ghost cube moves to the right layer.

Hover updates a `cursorCell: Signal<{x,y,z} | null>` which the viewport reads to position the
wireframe cursor cube.

---

## Tools

### Paint (`tools/paint.ts`)
On `mousedown` (left button): set `voxels.set(key, activeMaterial)`.
Hold mouse + drag: paint continuously as cursor moves (debounced to one write per cell).
Records patch for undo.

### Erase (`tools/paint.ts`, same file, different path)
On `mousedown` (right button or erase mode): `voxels.delete(key)`.
Records patch for undo.

### Fill (`tools/fill.ts`)
Click target cell → 6-connected flood fill:
- Seeds from clicked cell's current material (or empty space if target is empty)
- Fills with `activeMaterial`
- Stops at cells with different material (paint mode) or at non-empty cells (empty-fill mode)
- Bounded by a configurable max-cell limit (default 4096) to prevent runaway fills
- Records a single patch for the entire fill operation for one-shot undo

---

## SubObject manager (`ui/subobject_panel.tsx`)

Displays a list of `SubObjectRef[]`. Each row shows:
- `modelId` or `pool[]` (dropdown to switch between fixed/pool mode)
- Pool: comma-separated model IDs; probability slider (0–100%)
- Transform: numeric inputs for x/y/z, rotX/Y/Z (degrees), scaleX/Y/Z
- `boneId`: dropdown of bone IDs from the active skeleton (or "none")
- `materialSlot`: free-text input
- `hitbox`: checkbox (include in hitbox derivation)
- Add / Delete / Duplicate row buttons

SubObjects are rendered in the viewport as semi-transparent wireframe bounding boxes at their
transformed positions. In preview mode, the referenced model's voxels are rendered at the
transformed position.

---

## Export/Import

### Export
Converts editor state to `ModelDefinition`:
```typescript
function toModelDefinition(state: EditorState): ModelDefinition {
  const nodes = [...state.voxels.entries()].map(([key, materialId]) => {
    const [x, y, z] = key.split(",").map(Number);
    return { x, y, z, materialId };
  });
  const materials = [...new Set(nodes.map(n => n.materialId))];
  return {
    id: state.modelId,
    version: 1,
    hitbox: state.hitbox,
    nodes,
    subObjects: state.subObjects,
    materials,
    ...(state.skeletonId ? { skeletonId: state.skeletonId } : {}),
  };
}
```
Export panel shows the JSON in a `<textarea>` and a "Copy" button.
A "Download" button saves `{modelId}.json` via a Blob URL.

### Import
Two paths:
1. **Paste JSON** — `<textarea>` + parse + validate shape — loads into editor state
2. **Pick from content** — dropdown of all model IDs from `ContentStore.getAllModels()` —
   fetches the definition and loads it

---

## Build script (`scripts/build_voxel_editor.ts`)

Mirrors `build_client.ts` exactly:
```typescript
await esbuild.build({
  entryPoints: ["packages/devtools/src/voxel-editor/main.tsx"],
  outfile: "packages/devtools/dist/voxel_editor.js",
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  jsx: "automatic", jsxImportSource: "preact",
  plugins: [...denoPlugins({ configPath: "deno.json" })],
});
```

The HTML shell (`dist/voxel_editor.html`) is a static file committed to the repo. It imports
`./voxel_editor.js` as an ES module and has a single `<div id="app">` mount point.

The serve script (`scripts/serve_devtools.ts`) is ~20 lines: `Deno.serve` on port 8888,
serves files from `packages/devtools/dist/` with correct MIME types.

---

## `packages/devtools/deno.json`

```json
{
  "name": "@voxim/devtools",
  "version": "0.1.0",
  "exports": "./mod.ts",
  "imports": {
    "three": "https://esm.sh/three@0.167.0",
    "preact": "npm:preact@10.25.4",
    "preact/hooks": "npm:preact@10.25.4/hooks",
    "preact/jsx-runtime": "npm:preact@10.25.4/jsx-runtime",
    "@preact/signals": "npm:@preact/signals@1.3.0"
  },
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "preact"
  }
}
```

Exact same dep versions as `@voxim/client` so no duplicate bundles in the output.

---

## Implementation steps

1. **Scaffold package**
   - Create `packages/devtools/deno.json`, `mod.ts`
   - Add to workspace in root `deno.json`
   - Add tasks `devtools` / `build-voxel-editor`

2. **Build + serve scripts**
   - `scripts/build_voxel_editor.ts` (copy build_client.ts, change entry/output)
   - `scripts/serve_devtools.ts` (simple Deno.serve static file server)
   - `packages/devtools/dist/voxel_editor.html` (minimal HTML shell)

3. **State layer**
   - `state.ts` — EditorState, signals, `applyPatch()`, `pushUndo()`, `undo()`
   - `main.tsx` — load ContentStore from `/content/data/*.json`, mount `<App />`

4. **Viewport**
   - `viewport.ts` — scene, camera, orbit controls, grid helper, cursor cube, render loop
   - `voxel_mesh.ts` — `VoxelNode[] → InstancedMesh`, `updateInstance()` for incremental edits

5. **Ray picking**
   - `ray_pick.ts` — face pick + grid pick, active layer, cursor signal

6. **Tools**
   - `tools/paint.ts` — place/erase with undo
   - `tools/fill.ts` — flood fill with undo

7. **UI panels**
   - `ui/toolbar.tsx`
   - `ui/material_panel.tsx` (reuses `material_textures.ts` for canvas swatches)
   - `ui/model_panel.tsx`
   - `ui/subobject_panel.tsx`
   - `ui/export_panel.tsx` + `ui/import_modal.tsx`

8. **Preview mode**
   - Wire the "Preview" button in `viewport.ts` to swap `voxel_mesh.ts` output with
     `buildDisplacedVoxelGeo` from `entity_mesh.ts`

9. **Wire it up**
   - `app.tsx` — compose all panels, connect signals to viewport and tools
   - Keyboard shortcuts: `Ctrl+Z` undo, `[`/`]` layer shift, `P` paint, `E` erase, `F` fill

---

## What is explicitly out of scope for this plan

- Skeleton/animation preview (bone visualization, clip playback) — future devtool
- Terrain chunk editor — different tool, different data shape
- Multi-user / server-synced editing
- Undo of SubObject edits (only voxel edits are undo-able in v1)
- In-editor hitbox gizmo (hitbox is edited via numeric inputs only)
