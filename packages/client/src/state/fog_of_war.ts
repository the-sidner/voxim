/**
 * Client-side fog-of-war (T-157).
 *
 * Two grids over the active tile, one fog cell per `FOG_CELL_SIZE` world units
 * (256×256 cells covering the 512-unit tile):
 *
 *   seenEver         — bit-packed, **server-driven**.  Populated from
 *                      `BinaryStateMessage.fogSnapshot` (full bitmap on join)
 *                      and `BinaryStateMessage.fogReveals` (per-tick deltas).
 *                      Authoritative — survives reconnects.
 *   currentlyVisible — bit-packed, computed locally each frame from the LOS
 *                      cone + `OpenMask`.  Never networked; cleared per update.
 *
 * Texture upload packs the two grids into a single R8 enum sampled by EdgePass:
 *   0   → unseen           (rendered at uFogUnseen brightness)
 *   128 → seen-not-current (rendered at uFogSeen)
 *   255 → currently visible (rendered at uFogVisible)
 *
 * LOS algorithm matches the server's `FogOfWarSystem` exactly (same constants
 * imported from `@voxim/protocol`) so client-side `currentlyVisible` and the
 * server-side `seenEver` line up cleanly.
 */
import * as THREE from "three";
import {
  FOG_GRID_SIZE,
  FOG_CELL_SIZE,
  FOG_CELL_COUNT,
  FOG_GRID_BYTES,
  LOS_HALF_ANGLE_RAD,
  LOS_RADIUS,
  LOS_RAY_COUNT,
  LOS_STEP,
  packFogCell,
} from "@voxim/protocol";

// Re-export these so callers (Minimap, renderer wiring) don't need to add a
// second import path.
export { FOG_GRID_SIZE, FOG_CELL_SIZE };

/** Cell state enum baked into the texture R-channel. */
const CELL_UNSEEN  = 0;
const CELL_SEEN    = 128;
const CELL_VISIBLE = 255;

/** Predicate matching `ClientWorld.isOpen(wx, wy) → boolean`. */
export type IsOpenFn = (wx: number, wy: number) => boolean;

export class FogOfWar {
  /** Bit-packed seenEver bitmap.  Server-driven via apply* methods. */
  readonly seenEver = new Uint8Array(FOG_GRID_BYTES);
  /** Bit-packed currentlyVisible bitmap.  Cleared + recomputed each frame. */
  readonly currentlyVisible = new Uint8Array(FOG_GRID_BYTES);
  /** Texture data uploaded to the GPU (R8, one byte per cell). */
  private readonly textureData = new Uint8Array(FOG_CELL_COUNT);

  /** R8 texture sampled by EdgePass. NearestFilter — fog cells are world-aligned. */
  readonly texture: THREE.DataTexture;

  /** Bumped on each update so the minimap can poll for changes. */
  version = 0;

  /** Last player pose supplied to {@link updateLocalLOS}.  Drives the minimap marker. */
  lastPlayer: { x: number; y: number; facing: number } | null = null;

  constructor() {
    this.texture = new THREE.DataTexture(
      this.textureData,
      FOG_GRID_SIZE,
      FOG_GRID_SIZE,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  // ─── Server message handlers ─────────────────────────────────────────────

  /** Replace seenEver from a server full-bitmap message. */
  applySnapshot(packed: Uint8Array): void {
    if (packed.byteLength !== FOG_GRID_BYTES) {
      console.warn(`[FogOfWar] snapshot length ${packed.byteLength} != ${FOG_GRID_BYTES}, ignoring`);
      return;
    }
    this.seenEver.set(packed);
    this.repackTexture();
  }

  /** Merge per-tick reveals from a server message. */
  applyReveals(cellIndices: Uint16Array): void {
    if (cellIndices.length === 0) return;
    for (let i = 0; i < cellIndices.length; i++) {
      const idx = cellIndices[i];
      this.seenEver[idx >> 3] |= 1 << (idx & 7);
    }
    this.repackTexture();
  }

  // ─── Local LOS (client-side, every frame) ────────────────────────────────

  /**
   * Recompute `currentlyVisible` from the LOS cone.  Same algorithm and
   * parameters the server runs for `seenEver`, but local so the LOS arc
   * tracks player turning at frame rate without round-trip latency.
   *
   * @param px  Player world X (server convention — same as ThreeJS X)
   * @param py  Player world Y (server convention — ground plane, == ThreeJS Z)
   * @param facing  Facing angle in radians.  0 = +X, π/2 = +Y.
   * @param isOpen  Cell-occupancy probe (false → blocks sight).
   */
  updateLocalLOS(px: number, py: number, facing: number, isOpen: IsOpenFn): void {
    this.lastPlayer = { x: px, y: py, facing };
    this.currentlyVisible.fill(0);

    // Player's own cell — keep a small lit halo even when wedged.
    setBit(this.currentlyVisible, packFogCellSafe(px, py));

    const startAngle = facing - LOS_HALF_ANGLE_RAD;
    const angleStep  = (LOS_HALF_ANGLE_RAD * 2) / (LOS_RAY_COUNT - 1);

    for (let r = 0; r < LOS_RAY_COUNT; r++) {
      const a = startAngle + r * angleStep;
      const dx = Math.cos(a);
      const dy = Math.sin(a);

      let lastIdx = -1;
      for (let s = LOS_STEP; s <= LOS_RADIUS; s += LOS_STEP) {
        const wx = px + dx * s;
        const wy = py + dy * s;

        const cx = Math.floor(wx / FOG_CELL_SIZE);
        const cy = Math.floor(wy / FOG_CELL_SIZE);
        if (cx < 0 || cy < 0 || cx >= FOG_GRID_SIZE || cy >= FOG_GRID_SIZE) break;

        const idx = packFogCell(cx, cy);
        if (idx !== lastIdx) {
          setBit(this.currentlyVisible, idx);
          lastIdx = idx;
        }
        if (!isOpen(wx, wy)) break;
      }
    }

    this.repackTexture();
    this.version++;
  }

  /** Drop all exploration state — used on tile transitions. */
  reset(): void {
    this.seenEver.fill(0);
    this.currentlyVisible.fill(0);
    this.textureData.fill(0);
    this.texture.needsUpdate = true;
    this.lastPlayer = null;
    this.version++;
  }

  /** Read a single bit out of seenEver — used by the minimap drawer. */
  isSeen(cellIdx: number): boolean {
    return (this.seenEver[cellIdx >> 3] & (1 << (cellIdx & 7))) !== 0;
  }

  /** Read a single bit out of currentlyVisible — used by the minimap drawer. */
  isVisible(cellIdx: number): boolean {
    return (this.currentlyVisible[cellIdx >> 3] & (1 << (cellIdx & 7))) !== 0;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** Rebuild the dense R8 texture from the two bit-packed grids. */
  private repackTexture(): void {
    const tex = this.textureData;
    const seen = this.seenEver;
    const vis  = this.currentlyVisible;
    for (let byteIdx = 0; byteIdx < FOG_GRID_BYTES; byteIdx++) {
      const sByte = seen[byteIdx];
      const vByte = vis[byteIdx];
      const base = byteIdx << 3;
      for (let bit = 0; bit < 8; bit++) {
        const mask = 1 << bit;
        const isVis = (vByte & mask) !== 0;
        const isSeen = (sByte & mask) !== 0;
        tex[base + bit] = isVis ? CELL_VISIBLE : (isSeen ? CELL_SEEN : CELL_UNSEEN);
      }
    }
    this.texture.needsUpdate = true;
  }
}

function setBit(buf: Uint8Array, idx: number): void {
  buf[idx >> 3] |= 1 << (idx & 7);
}

function packFogCellSafe(wx: number, wy: number): number {
  const cx = Math.max(0, Math.min(FOG_GRID_SIZE - 1, Math.floor(wx / FOG_CELL_SIZE)));
  const cy = Math.max(0, Math.min(FOG_GRID_SIZE - 1, Math.floor(wy / FOG_CELL_SIZE)));
  return packFogCell(cx, cy);
}
