/**
 * ProjectileData component — server-only, not networked.
 *
 * Attached to projectile entities spawned by ranged weapon actions.
 * Carries all data needed by ProjectileSystem for physics and hit dispatch:
 *   - Owner reference (prevents self-hit)
 *   - Flat weapon stats used by HitHandlers (mirrors DerivedItemStats fields)
 *   - Physics parameters (gravity scale, collision radius)
 *   - Hit tracking (prevents multi-hit on same target)
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface ProjectileDataData {
  ownerId: string;
  // Flat subset of DerivedItemStats — only fields HitHandlers actually use
  damage: number;
  toolType: string;       // "" when absent
  harvestPower: number;
  buildPower: number;
  armorReduction: number;
  // Physics
  gravityScale: number;   // applied against physics.gravity each tick
  radius: number;         // collision sphere radius (world units)
  // Hit tracking
  hitEntities: string[];  // entity IDs already struck this flight
  maxHits: number;        // 0 = unlimited
}

const projectileDataCodec: Serialiser<ProjectileDataData> = {
  encode(v: ProjectileDataData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.ownerId);
    w.writeF32(v.damage);
    w.writeStr(v.toolType);
    w.writeF32(v.harvestPower);
    w.writeF32(v.buildPower);
    w.writeF32(v.armorReduction);
    w.writeF32(v.gravityScale);
    w.writeF32(v.radius);
    w.writeU16(v.hitEntities.length);
    for (const id of v.hitEntities) w.writeStr(id);
    w.writeU16(v.maxHits);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ProjectileDataData {
    const r = new WireReader(bytes);
    const ownerId = r.readStr();
    const damage = r.readF32();
    const toolType = r.readStr();
    const harvestPower = r.readF32();
    const buildPower = r.readF32();
    const armorReduction = r.readF32();
    const gravityScale = r.readF32();
    const radius = r.readF32();
    const count = r.readU16();
    const hitEntities: string[] = [];
    for (let i = 0; i < count; i++) hitEntities.push(r.readStr());
    const maxHits = r.readU16();
    return {
      ownerId, damage, toolType, harvestPower, buildPower, armorReduction,
      gravityScale, radius, hitEntities, maxHits,
    };
  },
};

export const ProjectileData = defineComponent({
  name: "projectileData" as const,
  codec: projectileDataCodec,
  networked: false,
  default: (): ProjectileDataData => ({
    ownerId: "",
    damage: 0,
    toolType: "",
    harvestPower: 1,
    buildPower: 0,
    armorReduction: 0,
    gravityScale: 0.4,
    radius: 0.1,
    hitEntities: [],
    maxHits: 1,
  }),
});
