/**
 * inputMode is the T-325 single mouse-ownership owner, derived from
 * `modeState` (build) + `uiState` (panels, radial menu). The load-bearing
 * contracts: build always wins over UI (voxel placement needs the cursor
 * exactly like a panel does, but keeps its own handlers), ANY open panel
 * forces "ui", and — the actual gap T-325 was filed against — the build
 * radial menu (`uiState.radialMenu`, never added to `openPanels`) also
 * forces "ui" even though it isn't a tracked panel.
 */
import { assertEquals } from "jsr:@std/assert";
import { modeState } from "./context.ts";
import { uiState } from "../ui/ui_store.ts";
import { inputMode, cameraOwnsMouse } from "./input_mode.ts";

function reset(): void {
  modeState.value = { kind: "normal" };
  uiState.value = { ...uiState.value, openPanels: new Set(), modalStack: [], radialMenu: null };
}

Deno.test("gameplay by default (no panels, no build)", () => {
  reset();
  assertEquals(inputMode.value, "gameplay");
  assertEquals(cameraOwnsMouse.value, true);
});

Deno.test("any open panel forces ui, even non-modal", () => {
  reset();
  uiState.value = { ...uiState.value, openPanels: new Set(["inventory"]) };
  assertEquals(inputMode.value, "ui");
  assertEquals(cameraOwnsMouse.value, false);
  reset();
});

Deno.test("T-325: the build radial menu forces ui though it's not a tracked panel", () => {
  reset();
  assertEquals(uiState.value.openPanels.size, 0, "precondition: no panel tracked");
  uiState.value = { ...uiState.value, radialMenu: { x: 10, y: 20 } };
  assertEquals(inputMode.value, "ui");
  assertEquals(cameraOwnsMouse.value, false);
  reset();
});

Deno.test("build mode wins even if a panel is (impossibly) also marked open", () => {
  reset();
  modeState.value = {
    kind: "build",
    blueprintId: "wood_wall",
    brush: { tool: "single", voxelSize: 1, spacing: 0 },
  };
  assertEquals(inputMode.value, "build");
  assertEquals(cameraOwnsMouse.value, false);
  reset();
});

Deno.test("closing the last panel restores gameplay", () => {
  reset();
  uiState.value = { ...uiState.value, openPanels: new Set(["stats"]) };
  assertEquals(inputMode.value, "ui");
  uiState.value = { ...uiState.value, openPanels: new Set() };
  assertEquals(inputMode.value, "gameplay");
  assertEquals(cameraOwnsMouse.value, true);
  reset();
});
