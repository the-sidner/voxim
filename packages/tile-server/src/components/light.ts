import { defineComponent } from "@voxim/engine";
import type { World } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { lightEmitterCodec, darknessModifierCodec } from "@voxim/codecs";
import type { LightEmitterData, DarknessModifierData } from "@voxim/codecs";
import { Position } from "./game.ts";

// ---- LightEmitter ----
// Present on any entity that currently emits light: held torch (player/NPC),
// placed torch, campfire, hearth. EquipmentSystem writes it when a torch is
// equipped and removes it on unequip. spawnPrefab() writes it for placed emitters
// via the `lightEmitter` prefab archetype.

export const LightEmitter = defineComponent({
  name: "lightEmitter" as const,
  wireId: ComponentType.lightEmitter,
  codec: lightEmitterCodec,
  default: (): LightEmitterData => ({ color: 0xffaa44, intensity: 1.0, radius: 8.0, flicker: 0.15 }),
});

// ---- DarknessModifier ----
// Present on entities that suppress ambient light (deep corruption zones,
// shadow-cursed creatures). Client darkens tiles within radius * strength.

export const DarknessModifier = defineComponent({
  name: "darknessModifier" as const,
  wireId: ComponentType.darknessModifier,
  codec: darknessModifierCodec,
  default: (): DarknessModifierData => ({ radius: 6.0, strength: 0.5 }),
});

// ---- getLightAt ----
// Pure on-demand light query — no precomputed grid, no stored state.
// Returns the net light contribution at (x, y) as a 0–1 value:
//   1.0 = fully lit (multiple bright emitters nearby)
//   0.0 = completely dark (no emitters + full darkness suppression)
//
// Usage: getLightAt(world, 120.5, 87.3)
// Cost: O(emitters in AoI) — acceptable at query-time (not every tick).

export function getLightAt(world: World, x: number, y: number): number {
  let light = 0;

  for (const { position, lightEmitter } of world.query(Position, LightEmitter)) {
    // intensity=0 is the "off" sentinel written by EquipmentSystem when a torch
    // is unequipped (workaround for missing wire component-removal — see T-097).
    if (lightEmitter.intensity <= 0 || lightEmitter.radius <= 0) continue;
    const dx = x - position.x;
    const dy = y - position.y;
    const distSq = dx * dx + dy * dy;
    const radiusSq = lightEmitter.radius * lightEmitter.radius;
    if (distSq >= radiusSq) continue;
    const t = 1 - Math.sqrt(distSq) / lightEmitter.radius; // linear falloff 1→0
    light += t * lightEmitter.intensity;
  }

  // Clamp to 0–1 before applying darkness suppression.
  light = Math.min(1, light);

  let darkness = 0;
  for (const { position, darknessModifier } of world.query(Position, DarknessModifier)) {
    const dx = x - position.x;
    const dy = y - position.y;
    const distSq = dx * dx + dy * dy;
    const radiusSq = darknessModifier.radius * darknessModifier.radius;
    if (distSq >= radiusSq) continue;
    const t = 1 - Math.sqrt(distSq) / darknessModifier.radius;
    darkness += t * darknessModifier.strength;
  }

  return Math.max(0, light - Math.min(1, darkness));
}
