import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";
import type { BodyPartVolume } from "@voxim/content";

/**
 * Hit geometry for an entity. Always server-only.
 *
 * `derive` is the authority flag:
 *   true  — HitboxSystem repopulates `parts` each tick from ModelRef + the
 *           live skeleton pose. Prefabs for animated entities use this.
 *   false — `parts` is static and owned by whoever wrote it (spawner's
 *           one-shot derivation for non-skeletal models, or a prefab with
 *           hand-authored capsule geometry). HitboxSystem ignores the entity.
 */
export interface HitboxData {
  derive: boolean;
  parts: BodyPartVolume[];
}

function writeBodyPart(w: WireWriter, p: BodyPartVolume): void {
  w.writeStr(p.id);
  w.writeF32(p.fromFwd);  w.writeF32(p.fromRight); w.writeF32(p.fromUp);
  w.writeF32(p.toFwd);    w.writeF32(p.toRight);   w.writeF32(p.toUp);
  w.writeF32(p.radius);
}

function readBodyPart(r: WireReader): BodyPartVolume {
  const id        = r.readStr();
  const fromFwd   = r.readF32(); const fromRight = r.readF32(); const fromUp  = r.readF32();
  const toFwd     = r.readF32(); const toRight   = r.readF32(); const toUp    = r.readF32();
  const radius    = r.readF32();
  return { id, fromFwd, fromRight, fromUp, toFwd, toRight, toUp, radius };
}

export const hitboxCodec: Serialiser<HitboxData> = {
  encode(v: HitboxData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(v.derive ? 1 : 0);
    w.writeU16(v.parts.length);
    for (const p of v.parts) writeBodyPart(w, p);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): HitboxData {
    const r = new WireReader(bytes);
    const derive = r.readU8() === 1;
    const count = r.readU16();
    const parts: BodyPartVolume[] = [];
    for (let i = 0; i < count; i++) parts.push(readBodyPart(r));
    return { derive, parts };
  },
};

/**
 * Collision geometry for hit detection. Server-only — clients never receive it.
 * All coordinates are entity-local (right=X, fwd=Y, up=Z).
 *
 * `derive` is the single switch that routes authorship:
 *   true  → HitboxSystem repopulates `parts` each tick from the live skeleton
 *   false → `parts` is static; HitboxSystem skips the entity
 *
 * Default is { derive: true, parts: [] } so a prefab that declares nothing
 * inherits the animated contract. Static props override with derive: false
 * and hand-authored or spawn-derived parts.
 *
 * An entity without this component (or with an empty parts array) is invisible
 * to hit detection. This is the single gate for hittability.
 */
export const Hitbox = defineComponent({
  name: "hitbox" as const,
  codec: hitboxCodec,
  networked: false,
  default: (): HitboxData => ({ derive: true, parts: [] }),
});
