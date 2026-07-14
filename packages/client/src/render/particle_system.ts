/**
 * ParticleSystem (T-340) — the ONE content-driven particle draw path,
 * replacing dust_motes.ts + hit_spark_renderer.ts. Every ParticleEmitterDef
 * gets exactly one InstancedMesh archetype (built once from bakeVoxels /
 * buildVoxelMaterial off `material` — the same voxel-shard idiom
 * decal_renderer.ts already ships for combat splats: flatShaded, palette-
 * snapped, Sobel-outlined). A burst of N particles never costs N draw
 * calls — only the shared archetype's one, exactly like DecalRenderer's
 * splats and the forest/prop InstancePool before it.
 *
 * Three independent triggers feed the same primitive:
 *   - onEvent(ev)            — event-sourced bursts (hit_spark/hit_flash),
 *                               dispatched through particle_sources.ts.
 *   - updateMuzzleFlashes(…) — a ranged WeaponActionDef's active-phase
 *                               rising edge fires its muzzleParticleId once
 *                               (edge-triggered — a per-entity latch, not a
 *                               level check, so a 1-3 tick active window
 *                               spanning several render frames still fires
 *                               exactly once).
 *   - setAmbience(id)        — a continuous drifting population inside a
 *                               box centred on the camera target, wrapping
 *                               at the edges (DustMotes' replacement).
 *
 * Physics is server-space (Vec3, x=east/y=north/z=up) via the SAME
 * ballisticStep the server's projectile resolver and aim_indicator.ts's arc
 * preview already share — converted to Three-space only when writing the
 * instance matrix (T-281's documented world-position convention:
 * three(x,y,z) = server(x,z,y)).
 *
 * Fade is a size curve (shrink-to-nothing), never alpha — the same
 * voxel-honest decay decal_renderer.ts already established ("slabs vanish
 * whole, no fading opacity against the Sobel ink").
 */
import * as THREE from "three";
import type { GameEvent } from "@voxim/protocol";
import type { ParticleEmitterDef, WeaponActionDef } from "@voxim/content";
import { localToWorld } from "@voxim/content";
import { ballisticStep } from "@voxim/engine";
import type { Vec3 } from "@voxim/engine";
import { CHUNK_SIZE } from "@voxim/world";
import type { ContentCache } from "../state/content_cache.ts";
import type { EntityMeshGroup } from "./entity_mesh.ts";
import type { InstancePool, InstanceSlot } from "./instance_pool.ts";
import { bakeVoxels } from "./voxel_bake.ts";
import { geometryFromBaked } from "./voxel_geo.ts";
import { buildVoxelMaterial } from "./voxel_material.ts";
import { getParticleSource, registerBuiltinParticleSources } from "./particle_sources.ts";

/** Top-level handle namespace — dispose() wipes everything under this. */
const HANDLE_PREFIX = "particle:";
/** Burst handles vs. the ambience handle are disjoint sub-prefixes (never a
 *  shared-prefix ambiguity with a def id, however it's named). */
const BURST_HANDLE_PREFIX = "particle:burst:";
const AMBIENCE_HANDLE_PREFIX = "particle:ambience:";
/** Perf-rail safety cap on live one-shot burst particles — engine-owned,
 *  same status as HitSparkRenderer.MAX_SPARKS / DecalRenderer.MAX_SPLATS
 *  (not gameplay tuning). The ambience population is bounded by its own
 *  content `ambience.count` instead. */
const MAX_LIVE_BURST_PARTICLES = 256;

interface LiveParticle {
  pos: Vec3;   // server-space
  vel: Vec3;   // server-space
  life: number;
  maxLife: number;
  /** Per-particle orientation, rolled once at spawn (visual variety on an
   *  otherwise-identical unit cube — same trick decal_renderer.ts's splats
   *  use, not a simulated tumble). */
  rotQuat: THREE.Quaternion;
  matrix: THREE.Matrix4;
}

interface Burst {
  handle: string;
  archetypeId: string;
  chunkKey: string;
  def: ParticleEmitterDef;
  particles: LiveParticle[];
}

interface AmbienceParticle {
  pos: Vec3;
  vel: Vec3;
  rotQuat: THREE.Quaternion;
  matrix: THREE.Matrix4;
}

/** Per-entity muzzle-flash edge-detection latch — resets ONLY when the
 *  entity's weaponActionId changes identity, never every frame, so a
 *  multi-frame active window fires exactly once. */
interface MuzzleLatch {
  weaponActionId: string;
  fired: boolean;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** server(x,y,z) → three-space position (T-281 world-position convention:
 *  three.x=server.x, three.y=server.z (up), three.z=server.y (north)). */
function worldToThree(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.z, p.y);
}

/**
 * Sample a launch velocity inside a cone of half-angle `spreadDeg` around
 * unit direction `baseDir`, magnitude `speed`. The phi distribution
 * (`acos(1 - u·(1-cos(spreadDeg)))`) generalises HitSparkRenderer's old
 * hardcoded `acos(1-rand*1.6)` hemisphere bias (that constant was exactly
 * spreadDeg≈127°) into a content-authored angle for ANY base direction, not
 * just world-up.
 */
function coneSample(baseDir: Vec3, spreadDeg: number, speed: number): Vec3 {
  const up = Math.abs(baseDir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  // tangent = normalize(up × baseDir); bitangent = baseDir × tangent (both unit, orthogonal to baseDir).
  let tx = up.y * baseDir.z - up.z * baseDir.y;
  let ty = up.z * baseDir.x - up.x * baseDir.z;
  let tz = up.x * baseDir.y - up.y * baseDir.x;
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= tLen; ty /= tLen; tz /= tLen;
  const bx = baseDir.y * tz - baseDir.z * ty;
  const by = baseDir.z * tx - baseDir.x * tz;
  const bz = baseDir.x * ty - baseDir.y * tx;

  const spreadRad = spreadDeg * Math.PI / 180;
  const k = 1 - Math.cos(spreadRad);
  const phi = Math.acos(1 - Math.random() * k);
  const theta = Math.random() * Math.PI * 2;
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
  const ct = Math.cos(theta), st = Math.sin(theta);

  return {
    x: (baseDir.x * cosPhi + tx * sinPhi * ct + bx * sinPhi * st) * speed,
    y: (baseDir.y * cosPhi + ty * sinPhi * ct + by * sinPhi * st) * speed,
    z: (baseDir.z * cosPhi + tz * sinPhi * ct + bz * sinPhi * st) * speed,
  };
}

export class ParticleSystem {
  private defsById = new Map<string, ParticleEmitterDef>();
  private archetypeReady = new Set<string>();
  private content: ContentCache | null = null;
  private gravity = 20;

  private bursts: Burst[] = [];
  private liveBurstParticleCount = 0;
  private seq = 0;

  private ambienceDefId: string | null = null;
  private ambienceDef: ParticleEmitterDef | null = null;
  private ambienceParticles: AmbienceParticle[] = [];
  private lastTarget = new THREE.Vector3();

  private muzzleLatch = new Map<string, MuzzleLatch>();

  constructor(private readonly instancePool: InstancePool) {
    registerBuiltinParticleSources();
  }

  setContent(content: ContentCache): void {
    this.content = content;
  }

  setDefs(defs: ParticleEmitterDef[]): void {
    this.defsById.clear();
    for (const d of defs) this.defsById.set(d.id, d);
  }

  setPhysics(gravity: number): void {
    this.gravity = gravity;
  }

  /** One unit-cube archetype per ParticleEmitterDef; the instance matrix
   *  positions/scales/rotates it. Mirrors DecalRenderer.ensureArchetype. */
  private ensureArchetype(def: ParticleEmitterDef): string {
    const archId = `${HANDLE_PREFIX}${def.id}`;
    if (this.archetypeReady.has(archId)) return archId;
    const mat = this.content?.getMaterialByName(def.material);
    const baked = bakeVoxels(
      [{ cx: 0, cy: 0, cz: 0, sx: 1, sy: 1, sz: 1, materialId: mat?.id ?? 0 }],
      mat?.id ?? 0,
      undefined,
      mat?.render?.tintJitter,
    );
    this.instancePool.registerArchetype(archId, {
      geometry: geometryFromBaked(baked),
      material: buildVoxelMaterial(mat, mat?.id ?? 0),
      castShadow: false,
      receiveShadow: true,
    });
    this.archetypeReady.add(archId);
    return archId;
  }

  /** Feed every wire GameEvent through the source registry; matching defs burst. */
  onEvent(ev: GameEvent): void {
    for (const def of this.defsById.values()) {
      if (!def.source) continue;
      const source = getParticleSource(def.source);
      const spec = source?.(ev);
      if (spec) this.spawnBurst(def, { x: spec.x, y: spec.y, z: spec.z });
    }
  }

  /** Spawn one burst of `def`'s particles at `origin` (server-space),
   *  cone-spread around `baseDir` (default world-up). */
  private spawnBurst(def: ParticleEmitterDef, origin: Vec3, baseDir?: Vec3): void {
    if (this.liveBurstParticleCount >= MAX_LIVE_BURST_PARTICLES) return;
    const archetypeId = this.ensureArchetype(def);
    const dir = baseDir ?? { x: 0, y: 0, z: 1 };
    const n = Math.round(def.count[0] + Math.random() * (def.count[1] - def.count[0]));
    const particles: LiveParticle[] = [];
    for (let i = 0; i < n && this.liveBurstParticleCount < MAX_LIVE_BURST_PARTICLES; i++) {
      const speed = def.speed[0] + Math.random() * (def.speed[1] - def.speed[0]);
      const vel = coneSample(dir, def.spreadDeg, speed);
      const maxLife = def.lifetime[0] + Math.random() * (def.lifetime[1] - def.lifetime[0]);
      particles.push({
        pos: { x: origin.x, y: origin.y, z: origin.z },
        vel,
        life: maxLife,
        maxLife,
        rotQuat: new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.random() * Math.PI * 2),
        matrix: new THREE.Matrix4(),
      });
      this.liveBurstParticleCount++;
    }
    if (particles.length === 0) return;
    const handle = `${BURST_HANDLE_PREFIX}${def.id}:${this.seq++}`;
    const chunkKey = `${Math.floor(origin.x / CHUNK_SIZE)},${Math.floor(origin.y / CHUNK_SIZE)}`;
    this.bursts.push({ handle, archetypeId, chunkKey, def, particles });
  }

  /**
   * Per-entity ranged-weapon active-phase rising edge → one muzzle burst.
   * The latch resets ONLY on a weaponActionId identity change (a new swing
   * started), never every frame — that is what makes a several-render-frame
   * active window fire exactly once instead of every frame it's active.
   */
  updateMuzzleFlashes(
    entityMeshes: ReadonlyMap<string, EntityMeshGroup>,
    weaponActions: ReadonlyMap<string, WeaponActionDef>,
    now: number,
  ): void {
    for (const [entityId, mesh] of entityMeshes) {
      const weaponActionId = mesh.animationState?.weaponActionId ?? "";
      let latch = this.muzzleLatch.get(entityId);
      if (!latch || latch.weaponActionId !== weaponActionId) {
        latch = { weaponActionId, fired: false };
        this.muzzleLatch.set(entityId, latch);
      }
      if (!weaponActionId || latch.fired) continue;
      const weaponAction = weaponActions.get(weaponActionId);
      if (!weaponAction || weaponAction.actionType !== "ranged" || !weaponAction.muzzleParticleId) continue;
      const def = this.defsById.get(weaponAction.muzzleParticleId);
      if (!def) continue;

      const elapsed = (now - mesh.lastAnimUpdateMs) / 50;
      const ticks = (mesh.animationState?.ticksIntoAction ?? 0) + elapsed;
      if (ticks < weaponAction.windupTicks) continue;
      latch.fired = true;

      const gameConfig = this.content?.getGameConfig();
      if (!gameConfig) continue;
      const muzzleLocal = weaponAction.projectile?.spawnOffset ?? gameConfig.combat.projectileDefaults.spawnOffset;
      const origin: Vec3 = { x: mesh.group.position.x, y: mesh.group.position.z, z: mesh.group.position.y };
      const muzzle = localToWorld(muzzleLocal.fwd, muzzleLocal.right, muzzleLocal.up, origin, mesh.facingAngle);
      const baseDir: Vec3 = { x: Math.cos(mesh.facingAngle), y: Math.sin(mesh.facingAngle), z: 0 };
      this.spawnBurst(def, muzzle, baseDir);
    }
    // Drop latch state for entities no longer present.
    for (const id of [...this.muzzleLatch.keys()]) {
      if (!entityMeshes.has(id)) this.muzzleLatch.delete(id);
    }
  }

  /**
   * Select (or clear) the continuous ambience population. Re-checked every
   * frame off the live AtmosphereDef — renderer.ts already re-selects the
   * atmosphere per-frame off biomeTag; this rides the same call, so a tile
   * transition or biome change picks up a different ambience for free.
   */
  setAmbience(defId: string | null): void {
    if (defId === this.ambienceDefId) return;
    this.instancePool.removeByPrefix(AMBIENCE_HANDLE_PREFIX);
    this.ambienceParticles = [];
    this.ambienceDefId = defId;
    this.ambienceDef = defId ? this.defsById.get(defId) ?? null : null;
    const def = this.ambienceDef;
    if (!def?.ambience) return;
    this.ensureArchetype(def);
    const dir = { x: 0, y: 0, z: 1 };
    for (let i = 0; i < def.ambience.count; i++) {
      const speed = def.speed[0] + Math.random() * (def.speed[1] - def.speed[0]);
      const vel = coneSample(dir, def.spreadDeg, speed);
      const pos: Vec3 = {
        x: this.lastTarget.x + (Math.random() * 2 - 1) * def.ambience.boxHalfExtent,
        y: this.lastTarget.z + (Math.random() * 2 - 1) * def.ambience.boxHalfExtent,
        z: Math.random() * def.ambience.boxHeight,
      };
      this.ambienceParticles.push({
        pos, vel,
        rotQuat: new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.random() * Math.PI * 2),
        matrix: new THREE.Matrix4(),
      });
    }
  }

  /** Integrate every live particle, cull the dead, rewrite InstancePool
   *  handles. Call once per frame, before instancePool.update(). */
  update(dt: number, target: THREE.Vector3): void {
    this.lastTarget.copy(target);

    // -- one-shot bursts --
    for (let bi = this.bursts.length - 1; bi >= 0; bi--) {
      const burst = this.bursts[bi];
      const slots: InstanceSlot[] = [];
      for (let i = burst.particles.length - 1; i >= 0; i--) {
        const p = burst.particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          burst.particles.splice(i, 1);
          this.liveBurstParticleCount--;
          continue;
        }
        const stepped = ballisticStep({ pos: p.pos, vel: p.vel }, this.gravity, burst.def.gravityScale, dt);
        p.pos = stepped.pos;
        p.vel = stepped.vel;
        const frac = 1 - p.life / p.maxLife; // 0 at spawn -> 1 at death
        const size = burst.def.size.start + (burst.def.size.end - burst.def.size.start) * frac;
        p.matrix.compose(worldToThree(p.pos), p.rotQuat, new THREE.Vector3(size, size, size));
        slots.push({ archetypeId: burst.archetypeId, matrix: p.matrix });
      }
      if (burst.particles.length === 0) {
        this.instancePool.remove(burst.handle);
        this.bursts.splice(bi, 1);
      } else {
        this.instancePool.add(burst.handle, burst.chunkKey, slots);
      }
    }

    // -- ambience --
    const def = this.ambienceDef;
    if (def?.ambience) {
      const half = def.ambience.boxHalfExtent;
      const height = def.ambience.boxHeight;
      const cx = this.lastTarget.x, cy = this.lastTarget.z;
      const archetypeId = this.ensureArchetype(def);
      const slots: InstanceSlot[] = [];
      for (const p of this.ambienceParticles) {
        const stepped = ballisticStep({ pos: p.pos, vel: p.vel }, this.gravity, def.gravityScale, dt);
        p.pos = stepped.pos;
        p.vel = stepped.vel;
        if (p.pos.x - cx > half) p.pos.x -= half * 2; else if (p.pos.x - cx < -half) p.pos.x += half * 2;
        if (p.pos.y - cy > half) p.pos.y -= half * 2; else if (p.pos.y - cy < -half) p.pos.y += half * 2;
        if (p.pos.z > height) p.pos.z -= height; else if (p.pos.z < 0) p.pos.z += height;
        const size = def.size.start;
        p.matrix.compose(worldToThree(p.pos), p.rotQuat, new THREE.Vector3(size, size, size));
        slots.push({ archetypeId, matrix: p.matrix });
      }
      const chunkKey = `${Math.floor(cx / CHUNK_SIZE)},${Math.floor(cy / CHUNK_SIZE)}`;
      this.instancePool.add(`${AMBIENCE_HANDLE_PREFIX}${def.id}`, chunkKey, slots);
    }
  }

  /** Drop everything (renderer shutdown). */
  dispose(): void {
    this.instancePool.removeByPrefix(HANDLE_PREFIX);
    this.bursts = [];
    this.liveBurstParticleCount = 0;
    this.ambienceParticles = [];
    this.ambienceDefId = null;
    this.ambienceDef = null;
    this.muzzleLatch.clear();
  }
}
