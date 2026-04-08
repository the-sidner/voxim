/**
 * DebugStore — signals for client-side debug overlay state.
 *
 * Kept separate from UIStore because debug state is purely client-local
 * and has no server representation.  game.ts writes here after calling
 * toggleDebug(); DebugPanel reads here to show toggle state.
 */
import { signal } from "@preact/signals";

export type DebugLayer = "skeleton" | "facing" | "chunks" | "heightmap" | "blade" | "hitbox";

export interface DebugOverlayState {
  skeleton:  boolean;
  facing:    boolean;
  chunks:    boolean;
  heightmap: boolean;
  blade:     boolean;
  hitbox:    boolean;
}

export const debugOverlays = signal<DebugOverlayState>({
  skeleton:  false,
  facing:    false,
  chunks:    false,
  heightmap: false,
  blade:     false,
  hitbox:    false,
});

export function setDebugLayer(layer: DebugLayer, on: boolean): void {
  debugOverlays.value = { ...debugOverlays.value, [layer]: on };
}
