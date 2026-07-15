import { defineComponent } from "@voxim/engine";
import type { World } from "@voxim/engine";
import { ComponentType, networkedCodec } from "@voxim/protocol";
import type { LightEmitterData } from "@voxim/codecs";
import { Position } from "./game.ts";

// ---- LightEmitter ----
// Present on any entity that currently emits light: held torch (player/NPC),
// placed torch, campfire, hearth. EquipmentSystem writes it when a torch is
// equipped and removes it on unequip. spawnPrefab() writes it for placed emitters
// via the `lightEmitter` prefab archetype.

export const LightEmitter = defineComponent({
  name: "lightEmitter" as const,
  wireId: ComponentType.lightEmitter,
  codec: networkedCodec<LightEmitterData>(ComponentType.lightEmitter),
  default: (): LightEmitterData => ({ color: 0xffaa44, intensity: 1.0, radius: 8.0, lightDefId: "torch" }),
});

// ---- getLightAt ----
// Pure on-demand light query — no precomputed grid, no stored state.
// Returns the net light contribution at (x, y) as a 0–1 value:
//   1.0 = fully lit (multiple bright emitters nearby)
//   0.0 = no emitters in range
//
// Usage: getLightAt(world, 120.5, 87.3)
// Cost: O(emitters in AoI) — acceptable at query-time (not every tick).

export function getLightAt(world: World, x: number, y: number): number {
  let light = 0;

  for (const { position, lightEmitter } of world.query(Position, LightEmitter)) {
    // Defensive: a degenerate emitter contributes no light. Unequip now removes
    // the component outright (T-269), so this rarely triggers.
    if (lightEmitter.intensity <= 0 || lightEmitter.radius <= 0) continue;
    const dx = x - position.x;
    const dy = y - position.y;
    const distSq = dx * dx + dy * dy;
    const radiusSq = lightEmitter.radius * lightEmitter.radius;
    if (distSq >= radiusSq) continue;
    const t = 1 - Math.sqrt(distSq) / lightEmitter.radius; // linear falloff 1→0
    light += t * lightEmitter.intensity;
  }

  return Math.min(1, light);
}
