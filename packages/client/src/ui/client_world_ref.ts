/**
 * Module-level handle to the ClientWorld so UI components can read entity
 * state (stats, provenance, …) without threading it through every render
 * tree. Set once at game.start; cleared on game.stop.
 *
 * UI components must tolerate `value === null` (e.g. during hot-reload, or
 * before the world is constructed) and never assume entities still exist —
 * the world entries are mutated reactively by ClientWorld's apply* methods,
 * so consumers should re-read on every render.
 */
import { signal } from "@preact/signals";
import type { ClientWorld } from "../state/client_world.ts";

export const clientWorld = signal<ClientWorld | null>(null);

export function setClientWorld(world: ClientWorld | null): void {
  clientWorld.value = world;
}

/**
 * Local-player entity ID, set on join handshake. UI components key the local
 * player's per-entity components (CSM, animation state, …) by this ID.
 */
export const localPlayerId = signal<string | null>(null);

export function setLocalPlayerId(id: string | null): void {
  localPlayerId.value = id;
}
