/**
 * InputMode — the single owner of "who does the mouse belong to right now"
 * (T-325).
 *
 * Before this, pointer-lock engagement (`PointerLockController` had its own
 * private `worldOwnsCursor()`) and world-action dispatch (`IntentTranslator`'s
 * `targetIsInteractiveUI` target check) each re-derived a PARTIAL answer, and
 * neither re-checked itself against two real gaps:
 *   - the build radial menu is shown via `uiState.radialMenu`, a plain patch —
 *     it was never added to `openPanels`, so opening it left pointer-lock
 *     thinking the world still owned the cursor;
 *   - a panel opening between events raced pointer-lock's own `_locked`
 *     mirror, which only updates on the async `pointerlockchange` event —
 *     mousemove deltas arriving in that gap still reached the camera.
 * "the guard is incomplete" (T-325) was both of these. Every mouse-driven
 * consumer now reads this ONE computed signal instead of re-deriving its own;
 * it has zero writers (pure derivation from `modeState` + `uiState`), so it
 * cannot desync from the state it's answering about.
 *
 *   gameplay — world owns the mouse: pointer-lock free-look camera engages,
 *              canvas clicks drive world actions (swing/block/interact).
 *   ui       — a panel or the build-radial overlay is open: the mouse is a
 *              normal OS cursor over DOM UI. Pointer-lock cannot engage (and
 *              releases immediately if it was already held); canvas mouse
 *              handlers bail out and see nothing.
 *   build    — placing voxels (T-284): needs the OS cursor for cursor-plane
 *              placement, same free cursor as `ui`, but keeps its own canvas
 *              mouse handlers (ghost preview, placement clicks).
 */
import { computed } from "@preact/signals";
import { modeState } from "./context.ts";
import { uiState } from "../ui/ui_store.ts";

export type InputMode = "gameplay" | "ui" | "build";

export const inputMode = computed<InputMode>(() => {
  if (modeState.value.kind === "build") return "build";
  if (uiState.value.openPanels.size > 0 || uiState.value.radialMenu !== null) return "ui";
  return "gameplay";
});

/** True only in `gameplay` — the sole mode the pointer-locked camera owns the mouse. */
export const cameraOwnsMouse = computed<boolean>(() => inputMode.value === "gameplay");
