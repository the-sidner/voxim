/**
 * Readable i-frame flash (T-298) — a client-only bone-shine while
 * `dodge_roll`'s `dash` phase (the i-frame window) is live, so the player
 * SEES why a dodge worked. Purely client-derived from the already-networked
 * `ActiveActions` locomotion slot (mirrored onto `EntityMeshGroup.activeActions`
 * per T-297's plumbing) cross-referenced against the `dodge_roll` ActionDef's
 * own phase ticks (full content access via ContentCache.getAction) — no new
 * wire field, no server change.
 *
 * Implementation: each voxel mesh's material is a FRESH instance per entity
 * (buildVoxelMaterial is called once per (entity, materialId) pair, never
 * shared across entities — confirmed by reading entity_mesh.ts), so directly
 * brightening `material.emissive` per-entity is safe; it can never bleed onto
 * another entity's rig. The baseline emissive is captured once (`userData`)
 * so the flash can lerp back to it cleanly every frame instead of drifting.
 */
import type * as THREE from "three";
import type { ActionDef } from "@voxim/content";
import type { ActiveActionsData } from "@voxim/codecs";
import type { EntityMeshGroup } from "./entity_mesh.ts";

const FLASH_COLOR_R = 1.0, FLASH_COLOR_G = 1.0, FLASH_COLOR_B = 1.0;

/**
 * Flash intensity [0,1] for this frame — peaks at the start of the dash
 * (ticksInPhase 0) and fades linearly to 0 across the phase's own tick
 * count, or 0 when no dodge_roll dash is running. `getAction` resolves the
 * dodge_roll ActionDef to read its `dash` phase's authored duration rather
 * than hardcoding a tick count.
 */
export function computeIframeFlash(
  activeActions: ActiveActionsData | null,
  getAction: (id: string) => ActionDef | undefined,
): number {
  const slot = activeActions?.states["locomotion"];
  if (!slot || slot.actionId !== "dodge_roll" || slot.phase !== "dash") return 0;
  const def = getAction("dodge_roll");
  const totalTicks = def?.phases["dash"]?.ticks ?? 0;
  if (totalTicks <= 0) return 0;
  return Math.max(0, 1 - slot.ticksInPhase / totalTicks);
}

/**
 * Apply (or clear) the i-frame flash on every voxel mesh's material,
 * lerping each material's emissive toward a bright highlight proportional
 * to `intensity` (0 = fully restored to the material's own baseline).
 */
export function applyIframeFlash(mesh: EntityMeshGroup, intensity: number): void {
  if (!mesh.voxelMeshes) return;
  for (const m of mesh.voxelMeshes) {
    const mat = m.material as THREE.MeshPhongMaterial;
    if (!mat.emissive) continue;
    const ud = mat.userData as { baseEmissive?: [number, number, number] };
    if (!ud.baseEmissive) {
      ud.baseEmissive = [mat.emissive.r, mat.emissive.g, mat.emissive.b];
    }
    const [br, bg, bb] = ud.baseEmissive;
    mat.emissive.setRGB(
      br + (FLASH_COLOR_R - br) * intensity,
      bg + (FLASH_COLOR_G - bg) * intensity,
      bb + (FLASH_COLOR_B - bb) * intensity,
    );
  }
}
