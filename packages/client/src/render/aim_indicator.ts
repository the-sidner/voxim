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

export class AimIndicatorRenderer {
  private readonly lineGeo = new THREE.BufferGeometry();
  private readonly line: THREE.Line;
  private readonly marker: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    const lineMat = new THREE.LineBasicMaterial({
      color: paletteToken("trail"),
      transparent: true,
      opacity: 0.85,
    });
    this.line = new THREE.Line(this.lineGeo, lineMat);
    this.line.visible = false;
    this.line.frustumCulled = false;
    scene.add(this.line);

    const ringGeo = new THREE.RingGeometry(0.25, 0.45, 24);
    ringGeo.rotateX(-Math.PI / 2); // lies flat on the ground plane (world XY)
    const ringMat = new THREE.MeshBasicMaterial({
      color: paletteToken("trail"),
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.marker = new THREE.Mesh(ringGeo, ringMat);
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
      this.line.visible = false;
      this.marker.visible = false;
      return;
    }

    const resolved = resolveProjectileConfig(input.weaponPrefabId, content);
    if (!resolved) {
      this.line.visible = false;
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

    this.lineGeo.setFromPoints(pts);
    this.line.visible = true;

    const land = pts[pts.length - 1];
    this.marker.position.copy(land);
    this.marker.position.y += 0.03; // lift off terrain to avoid z-fighting
    this.marker.visible = true;
  }

  dispose(): void {
    this.line.removeFromParent();
    this.marker.removeFromParent();
    this.lineGeo.dispose();
    (this.line.material as THREE.Material).dispose();
    (this.marker.geometry as THREE.BufferGeometry).dispose();
    (this.marker.material as THREE.Material).dispose();
  }
}

function worldToThree(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.z, p.y);
}
