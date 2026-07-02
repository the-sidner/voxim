/**
 * DecalRenderer (T-311 P4) — EPHEMERAL combat decals (the designer's Q8 call:
 * in-memory + decay; never saved, never networked, no DecalGrid wireId). A
 * wire GameEvent runs through the decal-source registry; each matching
 * `DecalDef` splats a handful of thin voxel slabs (the comic idiom — no alpha
 * quads) around the spec point, snapped to terrain, instanced through the
 * shared InstancePool. Splats live `ttlSeconds`, then crumble slab-by-slab
 * across `fadeSeconds` (voxel-honest decay — slabs vanish whole, no fading
 * opacity against the Sobel ink). A hard cap evicts the oldest splat first;
 * every slab is individually outlined, so the cap is a perf contract.
 *
 * Late joiners see no old blood — acceptable and self-healing (it decays),
 * which is exactly why the ephemeral call costs no permanent wire slot.
 */
import * as THREE from "three";
import type { GameEvent } from "@voxim/protocol";
import type { ContentService, DecalDef } from "@voxim/content";
import type { ClientWorld } from "../state/client_world.ts";
import type { InstancePool, InstanceSlot } from "./instance_pool.ts";
import { bakeVoxels } from "./voxel_bake.ts";
import { geometryFromBaked } from "./voxel_geo.ts";
import { buildVoxelMaterial } from "./voxel_material.ts";
import { getDecalSource, registerBuiltinDecalSources } from "./decal_sources.ts";

const CHUNK_SIDE = 32;
const HANDLE_PREFIX = "decal:";
const SLAB_THICKNESS = 0.1;
/** Lift above the displaced terrain top (± ~0.045) so slabs never z-fight. */
const GROUND_LIFT = 0.02;
/** Perf contract: at most this many live splats; oldest evicted first. */
const MAX_SPLATS = 160;
/** Decay scan cadence — slab expiry is coarse, no need for per-frame work. */
const UPDATE_INTERVAL_MS = 400;

const Y_AXIS = new THREE.Vector3(0, 1, 0);

interface Slab {
  slot: InstanceSlot;
  /** Wall-clock ms at which this slab crumbles away. */
  expiresAtMs: number;
}

interface Splat {
  handle: string;
  chunkCoord: string;
  slabs: Slab[];
}

export class DecalRenderer {
  private readonly defs: DecalDef[];
  private readonly splats: Splat[] = [];
  private readonly archetypeReady = new Set<string>();
  private seq = 0;
  private lastUpdateMs = 0;

  constructor(
    private readonly instancePool: InstancePool,
    private readonly content: ContentService,
    private readonly world: ClientWorld,
  ) {
    registerBuiltinDecalSources();
    this.defs = [...content.decals.values()];
  }

  /** Feed every wire GameEvent through the source registry; matching defs splat. */
  onEvent(ev: GameEvent): void {
    if (this.defs.length === 0) return;
    const positionOf = (entityId: string) => {
      const e = this.world.get(entityId);
      return e?.position ? { x: e.position.x, y: e.position.y } : null;
    };
    for (const def of this.defs) {
      const source = getDecalSource(def.source);
      const spec = source?.(ev, positionOf);
      if (spec) this.spawnSplat(def, spec.x, spec.y, spec.intensity);
    }
  }

  /** Coarse decay tick — call once per frame with performance.now(). */
  update(nowMs: number): void {
    if (nowMs - this.lastUpdateMs < UPDATE_INTERVAL_MS) return;
    this.lastUpdateMs = nowMs;
    for (let i = this.splats.length - 1; i >= 0; i--) {
      const splat = this.splats[i];
      const survivors = splat.slabs.filter((s) => s.expiresAtMs > nowMs);
      if (survivors.length === splat.slabs.length) continue;
      this.instancePool.remove(splat.handle);
      if (survivors.length === 0) {
        this.splats.splice(i, 1);
      } else {
        splat.slabs = survivors;
        this.instancePool.add(splat.handle, splat.chunkCoord, survivors.map((s) => s.slot));
      }
    }
  }

  /** Drop everything (tile transition). */
  reset(): void {
    this.instancePool.removeByPrefix(HANDLE_PREFIX);
    this.splats.length = 0;
  }

  /** One unit-cube archetype per DecalDef; the instance matrix flattens it. */
  private ensureArchetype(def: DecalDef): string {
    const archId = `${HANDLE_PREFIX}${def.id}`;
    if (this.archetypeReady.has(archId)) return archId;
    const mat = this.content.materials.get(def.material)!; // cross-checked at boot
    const baked = bakeVoxels(
      [{ cx: 0, cy: 0, cz: 0, sx: 1, sy: 1, sz: 1, materialId: mat.id }],
      mat.id,
      undefined,
      mat.render?.tintJitter,
    );
    this.instancePool.registerArchetype(archId, {
      geometry: geometryFromBaked(baked),
      material: buildVoxelMaterial(mat, mat.id),
      castShadow: false,
      receiveShadow: true,
    });
    this.archetypeReady.add(archId);
    return archId;
  }

  private spawnSplat(def: DecalDef, x: number, y: number, intensity: number): void {
    const archetypeId = this.ensureArchetype(def);
    const n = Math.max(1, Math.round(def.count[0] + (def.count[1] - def.count[0]) * intensity));
    const nowMs = performance.now();
    const ttlMs = def.ttlSeconds * 1000;
    const fadeMs = def.fadeSeconds * 1000;

    const slabs: Slab[] = [];
    for (let k = 0; k < n; k++) {
      // Transient presentation — Math.random is the fx idiom (hit sparks);
      // the doctrine's hash rule guards world DERIVATION, not ephemera.
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * def.radius;   // sqrt → uniform disk
      const wx = x + Math.cos(ang) * rad;
      const wy = y + Math.sin(ang) * rad;
      const size = def.sizeRange[0] + Math.random() * (def.sizeRange[1] - def.sizeRange[0]);
      const wz = this.world.getTerrainHeight(wx, wy) + SLAB_THICKNESS / 2 + GROUND_LIFT;
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(wx, wz, wy),
        new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.random() * Math.PI * 2),
        new THREE.Vector3(size, SLAB_THICKNESS, size),
      );
      slabs.push({
        slot: { archetypeId, matrix },
        expiresAtMs: nowMs + ttlMs + Math.random() * fadeMs,
      });
    }

    const handle = `${HANDLE_PREFIX}${def.id}:${this.seq++}`;
    const chunkCoord = `${Math.floor(x / CHUNK_SIDE)},${Math.floor(y / CHUNK_SIDE)}`;
    this.instancePool.add(handle, chunkCoord, slabs.map((s) => s.slot));
    this.splats.push({ handle, chunkCoord, slabs });

    // Perf cap — evict the oldest whole splat first.
    while (this.splats.length > MAX_SPLATS) {
      const oldest = this.splats.shift()!;
      this.instancePool.remove(oldest.handle);
    }
  }
}
