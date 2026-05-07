/**
 * Module-level handle to the renderer's FogOfWar instance.  Used by the
 * minimap component (see components/Minimap.tsx) to read exploration state
 * without threading the renderer through the Preact tree.
 *
 * Set once at game.start (after the renderer is constructed); cleared on
 * game.stop.  Consumers must tolerate `value === null` — UI mounts before
 * the renderer exists during the loading screen.
 */
import { signal } from "@preact/signals";
import type { FogOfWar } from "../state/fog_of_war.ts";

export const fogRef = signal<FogOfWar | null>(null);

export function setFogRef(fog: FogOfWar | null): void {
  fogRef.value = fog;
}
