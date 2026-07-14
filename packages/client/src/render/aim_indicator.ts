/**
 * AimIndicatorRenderer (T-337) — the hold-to-aim arc + landing marker.
 * "A hold-to-aim indicator is part of the deliverable — you cannot aim
 * what you cannot see."
 *
 * Integrates the SAME `launchVelocity` + `ballisticStep` the server's
 * `ProjectileSpawnResolver`/`ProjectileTraceResolver` use (both from
 * `@voxim/engine`, moved there for exactly this reason, T-337) — this is
 * "share the math", not a hand-rolled client approximation that could drift
 * from the server's own integration. Muzzle offset mirrors
 * `ProjectileSpawnResolver`'s own fallback logic
 * (`weaponAction.projectile.spawnOffset ?? combat.projectileDefaults.spawnOffset`)
 * so the drawn origin never drifts from the real one either.
 *
 * World→THREE convention (matches decal_renderer.ts / renderer.ts's own
 * entity placement): THREE(x, y, z) = world(x, z, y) — world Z is vertical.
 */
import * as THREE from "three";
import { launchVelocity, ballisticStep } from "@voxim/engine";
import type { Vec3 } from "@voxim/engine";
import { localToWorld } from "@voxim/content";
import type { ContentService, ProjectileActionConfig, SwingableData } from "@voxim/content";
import { paletteToken } from "./palette.ts";

const TICK_DT = 1 / 20;
/** Safety cap on simulated steps, independent of a weapon's own lifetimeTicks
 *  (keeps a pathological content value from spinning the preview forever). */
const MAX_PREVIEW_STEPS = 240;

export interface AimIndicatorInput {
  origin: Vec3;
  facing: number;
  pitch: number;
  /** The equipped weapon's prefab id (Equipment.weapon.prefabId), or undefined. */
  weaponPrefabId: string | undefined;
}

/** Resolve the equipped weapon's ProjectileActionConfig + spawn-offset
 *  override, mirroring ProjectileSpawnResolver's own resolution — the
 *  hold-to-aim weapon's chain is degenerate (light === heavy, no combo, no
 *  charge-tier selection), so chain[0].light always names the right
 *  WeaponActionDef without needing SwingChain (server-only, unnetworked). */
function resolveProjectileConfig(
  weaponPrefabId: string | undefined,
  content: ContentService,
): { projectile: ProjectileActionConfig } | null {
  if (!weaponPrefabId) return null;
  const swingable = content.prefabs.get(weaponPrefabId)?.components["swingable"] as SwingableData | undefined;
  const weaponActionId = swingable?.chain[0]?.light;
  if (!weaponActionId) return null;
  const action = content.weaponActions.get(weaponActionId);
  if (!action?.projectile) return null;
  return { projectile: action.projectile };
}

/** How many arc samples the dot trail can show at once. */
const MAX_DOTS = 64;
/** Draw a dot every Nth simulated step — spacing, not resolution. */
const DOT_STRIDE = 2;

export class AimIndicatorRenderer {
  /**
   * The arc is a trail of DOTS, not a `THREE.Line`.
   *
   * It used to be a Line with a `LineBasicMaterial`, and it was invisible in
   * play — because WebGL **ignores `linewidth` entirely**. Every `THREE.Line` is
   * exactly one pixel wide, no matter what you ask for. A 1px dark thread over
   * busy voxel terrain, mostly at your own feet (the rest pitch is level, so a
   * gravity-bearing arc lands close), is not something a player will ever see.
   * The renderer was reporting `visible = true` the whole time — the flag was
   * honest, the pixels were not.
   *
   * An InstancedMesh of small spheres has none of that problem: real geometry,
   * real thickness, occluded correctly by terrain, and no per-frame geometry
   * reallocation (we only rewrite instance matrices and the visible `count`).
   */
  private readonly dots: THREE.InstancedMesh;
  private readonly marker: THREE.Mesh;
  private readonly _m = new THREE.Matrix4();
  private readonly _v = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const dotGeo = new THREE.SphereGeometry(0.1, 6, 4);
    const dotMat = new THREE.MeshBasicMaterial({
      color: paletteToken("trail"),
      transparent: true,
      opacity: 0.95,
    });
    this.dots = new THREE.InstancedMesh(dotGeo, dotMat, MAX_DOTS);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.count = 0;
    this.dots.visible = false;
    this.dots.frustumCulled = false;
    scene.add(this.dots);

    // Landing ring — deliberately large and depth-test-free, so it reads as an
    // impact point even when the arc is short and the terrain is cluttered.
    const ringGeo = new THREE.RingGeometry(0.45, 0.75, 28);
    ringGeo.rotateX(-Math.PI / 2); // lies flat on the ground plane (world XY)
    const ringMat = new THREE.MeshBasicMaterial({
      color: paletteToken("trail"),
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    this.marker = new THREE.Mesh(ringGeo, ringMat);
    this.marker.renderOrder = 999;
    this.marker.visible = false;
    this.marker.frustumCulled = false;
    scene.add(this.marker);
  }

  /**
   * `visible` false hides both meshes and returns immediately — the common
   * case (not aiming). Otherwise simulates the arc from `input.origin`
   * using `input`'s facing/pitch and the resolved weapon's projectile
   * config, terminating at the first terrain crossing (the landing marker)
   * or after `projectile.lifetimeTicks` steps (a max-range fizzle — the
   * marker still lands at the final simulated point so the player learns
   * the range cap).
   */
  update(
    visible: boolean,
    input: AimIndicatorInput,
    content: ContentService,
    getTerrainHeight: (x: number, y: number) => number,
  ): void {
    if (!visible) {
      this.dots.visible = false;
      this.marker.visible = false;
      return;
    }

    const resolved = resolveProjectileConfig(input.weaponPrefabId, content);
    if (!resolved) {
      this.dots.visible = false;
      this.marker.visible = false;
      return;
    }
    const { projectile } = resolved;

    const combatCfg = content.getGameConfig().combat;
    const muzzleLocal = projectile.spawnOffset ?? combatCfg.projectileDefaults.spawnOffset;
    const muzzle = localToWorld(
      muzzleLocal.fwd, muzzleLocal.right, muzzleLocal.up,
      input.origin, input.facing,
    );

    const gravity = content.getGameConfig().physics.gravity;
    let pos: Vec3 = { x: muzzle.x, y: muzzle.y, z: muzzle.z };
    let vel = launchVelocity(input.facing, input.pitch, projectile.speed);

    const pts: THREE.Vector3[] = [worldToThree(pos)];
    const steps = Math.min(MAX_PREVIEW_STEPS, projectile.lifetimeTicks > 0 ? projectile.lifetimeTicks : MAX_PREVIEW_STEPS);
    for (let i = 0; i < steps; i++) {
      const stepped = ballisticStep({ pos, vel }, gravity, projectile.gravityScale, TICK_DT);
      pos = stepped.pos;
      vel = stepped.vel;
      pts.push(worldToThree(pos));
      const terrainZ = getTerrainHeight(pos.x, pos.y);
      if (pos.z <= terrainZ) break;
    }

    // Lay dots along the arc. Stride, don't downsample: the simulation keeps its
    // full fidelity (the landing point is the LAST simulated step, never a
    // rounded one), we just don't draw every step.
    let n = 0;
    for (let i = 0; i < pts.length && n < MAX_DOTS; i += DOT_STRIDE) {
      this._m.makeTranslation(pts[i].x, pts[i].y, pts[i].z);
      this.dots.setMatrixAt(n++, this._m);
    }
    // Always mark the true impact point, even if the stride skipped it.
    const land = pts[pts.length - 1];
    if (n < MAX_DOTS) {
      this._m.makeTranslation(land.x, land.y, land.z);
      this.dots.setMatrixAt(n++, this._m);
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    this.dots.visible = n > 0;

    this.marker.position.copy(land);
    this.marker.position.y += 0.03; // lift off terrain to avoid z-fighting
    this.marker.visible = true;
  }

  dispose(): void {
    this.dots.removeFromParent();
    this.marker.removeFromParent();
    this.dots.geometry.dispose();
    (this.dots.material as THREE.Material).dispose();
    (this.marker.geometry as THREE.BufferGeometry).dispose();
    (this.marker.material as THREE.Material).dispose();
  }
}

function worldToThree(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.z, p.y);
}
