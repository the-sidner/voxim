/**
 * CrumbleController (T-339) — the "crumble" death-style handler. A body's
 * EXISTING bone-group meshes (already merged one-per-material by T-281's
 * `buildMergedSubMeshes`) detach out of the skeleton hierarchy into an
 * independent, ballistic, per-corpse container: NO new geometry, NO new
 * THREE.Mesh — only reparenting existing Object3Ds, so T-281's per-corpse
 * draw-call count is preserved by construction.
 *
 * Physics is the SAME `ballisticStep` (`@voxim/engine`) every projectile and
 * particle in this codebase already integrates with — one integrator, never
 * a second hand-rolled one.
 */
import * as THREE from "three";
import type { CrumbleStyleParams, DeathStyleDef } from "@voxim/content";
import { ballisticStep } from "@voxim/engine";
import type { Vec3 } from "@voxim/engine";
import type { EntityMeshGroup } from "./entity_mesh.ts";
import { coneSample } from "./particle_system.ts";
import type { DeathStyleContext } from "./death_style_registry.ts";

interface CrumblePiece {
  group: THREE.Group;
  /** Server-space (x=east, y=north, z=up) — same convention ballisticStep/
   *  particle_system.ts/aim_indicator.ts already use. */
  pos: Vec3;
  vel: Vec3;
  spinAxis: THREE.Vector3;
  spinSpeed: number; // rad/s, frozen once settled
  settled: boolean;
}

interface CrumbleCorpse {
  container: THREE.Group;
  pieces: CrumblePiece[];
  params: CrumbleStyleParams;
  ageSeconds: number;
  durationSeconds: number;
  fadeStartSeconds: number;
}

/** server(x,y,z) -> three-space (T-281 world-position convention:
 *  three.x=server.x, three.y=server.z (up), three.z=server.y (north)). */
function toThree(p: Vec3): [number, number, number] {
  return [p.x, p.z, p.y];
}

/** three-space world position -> server-space (inverse of toThree). Only
 *  valid immediately after `container.attach(bg)`, while `container` sits
 *  at the scene root with an identity transform — see `onDeath`'s comment. */
function threeToServer(v: THREE.Vector3): Vec3 {
  return { x: v.x, y: v.z, z: v.y };
}

export class CrumbleController {
  private corpses = new Map<string, CrumbleCorpse>();

  /**
   * DeathStyleHandler entry point (registered by VoximRenderer's
   * constructor under style "crumble"). Idempotent — a re-delivered
   * EntityDied for an already-crumbling entity is a no-op, never a
   * double-detach.
   */
  onDeath(entityId: string, mesh: EntityMeshGroup, def: DeathStyleDef, durationTicks: number, ctx: DeathStyleContext): void {
    const params = def.crumble;
    if (!params || !mesh.boneGroups || mesh.boneGroups.size === 0) return;
    if (this.corpses.has(entityId)) return;

    const container = new THREE.Group();
    ctx.scene.add(container);

    // Detach every bone group into this corpse's own container, preserving
    // world transform. THREE.Object3D.attach() handles the stale-matrix
    // problem internally (this runs from a network-event handler, not
    // inside the render loop): it calls updateWorldMatrix(true,false) on
    // BOTH the new parent's ancestor chain and the bone's CURRENT parent's
    // ancestor chain before reparenting — see three's Object3D.attach()
    // source. Iteration order doesn't matter: attach() always computes off
    // whatever the bone's CURRENT parent actually is, even if that parent
    // was itself already reparented into `container` earlier this loop.
    //
    // `container` sits at the scene root with an identity transform, so
    // `bg.position` immediately after attach() numerically EQUALS the
    // bone's three-space WORLD position — no separate decompose needed.
    // Every bone group's EXISTING children (the merged sub:/recipe: meshes,
    // and any bone-parented weapon/armor attachment anchor) move with it
    // unmodified, so an equipped item on a bone-parented slot rides along
    // for free.
    const captured: { group: THREE.Group; threePos: THREE.Vector3 }[] = [];
    for (const [, bg] of mesh.boneGroups) {
      container.attach(bg);
      captured.push({ group: bg, threePos: bg.position.clone() });
    }
    // Entity-ROOT attachment anchors (main_hand/off_hand — a held sword,
    // shield, torch) are NOT bone children: they're mesh.group children
    // positioned per-frame by updateAttachmentPositions, which stops running
    // once `mesh.crumbling` is set. Left behind they'd hang frozen in
    // mid-air for the whole linger window (the server's equip_cleanup
    // destroys the item ENTITY on death but never rewrites the corpse's
    // Equipment, so no delta detaches the visual either). Equipment dies
    // WITH the body: each populated entity-root anchor becomes a ballistic
    // piece of this corpse. Ownership transfers wholesale — the slot leaves
    // mesh.attachments so disposeCorpse (not clearMeshContent) is its one
    // teardown path, mirroring the bone groups' own ownership handoff.
    for (const [slotId, slot] of mesh.attachments) {
      if (slot.boneParented || slot.anchor.children.length === 0) continue;
      container.attach(slot.anchor);
      captured.push({ group: slot.anchor, threePos: slot.anchor.position.clone() });
      mesh.attachments.delete(slotId);
    }
    mesh.crumbling = true;
    if (mesh.nameLabel) mesh.nameLabel.visible = false;

    // Corpse centroid (three-space) — each piece's outward direction is
    // measured from the body's actual mass, not a single root-bone position.
    const centroid = new THREE.Vector3();
    for (const c of captured) centroid.add(c.threePos);
    centroid.divideScalar(captured.length);

    const pieces: CrumblePiece[] = [];
    for (const c of captured) {
      const outThree = c.threePos.clone().sub(centroid);
      if (outThree.lengthSq() < 1e-6) {
        // Centroid-coincident (the root bone) — no meaningful outward
        // direction; pick a random one instead of a fixed axis so every
        // root-bone piece doesn't launch identically.
        outThree.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5);
      }
      outThree.normalize();
      // Blend toward world-up (three-space +Y) so the radiation pattern
      // isn't perfectly flat — a body coming apart throws limbs up and
      // out, not just sideways. Blend weight is a tunable, verified live.
      outThree.y += 0.4;
      outThree.normalize();

      const speed = params.impulseSpeed[0] + Math.random() * (params.impulseSpeed[1] - params.impulseSpeed[0]);
      const vel = coneSample(threeToServer(outThree), params.spreadDeg, speed);
      const spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const spinSpeed = params.spinSpeed[0] + Math.random() * (params.spinSpeed[1] - params.spinSpeed[0]);
      pieces.push({
        group: c.group,
        pos: threeToServer(c.threePos),
        vel,
        spinAxis,
        spinSpeed,
        settled: false,
      });
    }

    const durationSeconds = durationTicks / 20;
    const fadeSeconds = params.fadeTicks / 20;
    this.corpses.set(entityId, {
      container,
      pieces,
      params,
      ageSeconds: 0,
      durationSeconds,
      fadeStartSeconds: Math.max(0, durationSeconds - fadeSeconds),
    });
  }

  /** Advance every tracked corpse one frame: integrate falling pieces,
   *  settle+dust on ground contact, fade near the end of the linger
   *  window, dispose once fully expired. Called once per render frame. */
  update(
    dt: number,
    gravity: number,
    getTerrainHeight: (x: number, y: number) => number,
    spawnParticleBurst: (defId: string, origin: Vec3) => void,
  ): void {
    for (const [entityId, corpse] of this.corpses) {
      corpse.ageSeconds += dt;

      for (const piece of corpse.pieces) {
        if (!piece.settled) {
          const stepped = ballisticStep({ pos: piece.pos, vel: piece.vel }, gravity, corpse.params.gravityScale, dt);
          piece.pos = stepped.pos;
          piece.vel = stepped.vel;
          const groundZ = getTerrainHeight(piece.pos.x, piece.pos.y);
          // Same landing convention ItemPhysicsSystem/particle_system.ts
          // use: crossed the terrain surface while still moving downward.
          if (piece.pos.z <= groundZ && piece.vel.z <= 0) {
            piece.pos = { x: piece.pos.x, y: piece.pos.y, z: groundZ };
            piece.vel = { x: 0, y: 0, z: 0 };
            piece.settled = true;
            spawnParticleBurst(corpse.params.impactParticleId, piece.pos);
          }
          piece.group.rotateOnAxis(piece.spinAxis, piece.spinSpeed * dt);
        }
        const [tx, ty, tz] = toThree(piece.pos);
        piece.group.position.set(tx, ty, tz);
      }

      if (corpse.durationSeconds > corpse.fadeStartSeconds && corpse.ageSeconds >= corpse.fadeStartSeconds) {
        const frac = Math.min(1, (corpse.ageSeconds - corpse.fadeStartSeconds) / (corpse.durationSeconds - corpse.fadeStartSeconds));
        const scale = Math.max(0, 1 - frac);
        // Per-PIECE scale, not the shared container's — scaling the
        // container would translate every piece toward the container's
        // origin as t->0 (visibly wrong); each piece must shrink around
        // its OWN pivot.
        for (const piece of corpse.pieces) piece.group.scale.setScalar(scale);
      }

      if (corpse.ageSeconds >= corpse.durationSeconds) {
        this.disposeCorpse(corpse);
        this.corpses.delete(entityId);
      }
    }
  }

  /** Tear down one corpse early (entity left AoI, natural destroy) — the
   *  ONLY disposal path for a crumble-detached bone subtree;
   *  `clearMeshContent`'s own dispose-traverse correctly no-ops for a
   *  reparented bone group (its parent is this controller's container, not
   *  `mesh.group`), so this must run instead, not in addition. */
  dispose(entityId: string): void {
    const corpse = this.corpses.get(entityId);
    if (!corpse) return;
    this.disposeCorpse(corpse);
    this.corpses.delete(entityId);
  }

  /** Whole-world teardown (tile transition via clearWorld / renderer dispose). */
  disposeAll(): void {
    for (const [, corpse] of this.corpses) this.disposeCorpse(corpse);
    this.corpses.clear();
  }

  private disposeCorpse(corpse: CrumbleCorpse): void {
    // Only DISPOSE, never rebuild — these meshes/geometries were already
    // built once by upgradeToSkeletonModel; mirrors clearMeshContent's own
    // dispose-traversal exactly, just walking the corpse's container.
    corpse.container.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      (obj.material as THREE.Material).dispose();
      obj.geometry.dispose();
    });
    corpse.container.removeFromParent();
  }
}
