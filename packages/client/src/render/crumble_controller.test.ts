/**
 * CrumbleController tests (T-339). Pure THREE.js Object3D/Group math under
 * `deno test`, headless — same precedent as camera_rig.test.ts/
 * light_manager.test.ts (no canvas/WebGL context needed for transform math).
 * A minimal fake EntityMeshGroup implements only the fields
 * CrumbleController actually reads/writes (boneGroups/attachments/crumbling/
 * nameLabel) — same partial-object-cast precedent entity_mesh_dissolve.test.ts
 * uses for a fake SkeletonDef.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import * as THREE from "three";
import type { DeathStyleDef } from "@voxim/content";
import type { AttachmentSlot, EntityMeshGroup } from "./entity_mesh.ts";
import type { DeathStyleContext } from "./death_style_registry.ts";
import { CrumbleController } from "./crumble_controller.ts";

const CRUMBLE_DEF: DeathStyleDef = {
  id: "test_crumble",
  style: "crumble",
  resourceKey: "crumble_timer",
  crumble: {
    impulseSpeed: [0, 0], // zero launch speed — isolates pure-gravity fall, deterministic
    spreadDeg: 0,
    gravityScale: 1,
    spinSpeed: [0, 0],
    durationTicks: 100, // unused by onDeath (durationTicks is passed separately, wire-sourced)
    fadeTicks: 20,
    impactParticleId: "test_crumble_impact",
  },
};

function newFakeMesh(): { mesh: EntityMeshGroup; boneA: THREE.Group; boneB: THREE.Group; root: THREE.Group } {
  const root = new THREE.Group();
  const boneA = new THREE.Group();
  boneA.position.set(0, 5, 0); // three-space up=y → world height 5
  root.add(boneA);
  const boneB = new THREE.Group();
  boneB.position.set(2, 1, 0); // nested child — world position (2, 6, 0)
  boneA.add(boneB);

  const mesh = {
    group: root,
    boneGroups: new Map<string, THREE.Group>([["a", boneA], ["b", boneB]]),
    attachments: new Map<string, AttachmentSlot>(),
    crumbling: false,
    nameLabel: null,
  } as unknown as EntityMeshGroup;

  return { mesh, boneA, boneB, root };
}

/** Attach a fake held-item slot to the mesh (entity-root unless boneParented). */
function addAttachment(
  mesh: EntityMeshGroup,
  slotId: string,
  parent: THREE.Group,
  boneParented: boolean,
  withModel = true,
): THREE.Group {
  const anchor = new THREE.Group();
  anchor.name = `attachment:${slotId}`;
  anchor.position.set(0.5, 4, 0);
  parent.add(anchor);
  if (withModel) anchor.add(new THREE.Group()); // stands in for the item's voxel meshes
  mesh.attachments.set(slotId, {
    anchor, modelId: withModel ? "test_item" : null, boneParented, bladeAttach: null, restBoneId: null,
  });
  return anchor;
}

function newCtx(scene: THREE.Scene, spawnBurst: (defId: string, origin: { x: number; y: number; z: number }) => void): DeathStyleContext {
  return {
    scene,
    getTerrainHeight: () => 0, // flat ground at server z=0
    spawnParticleBurst: spawnBurst,
    gravity: 20,
  };
}

Deno.test("onDeath: detaches EVERY bone group directly into a per-corpse container (flattening the hierarchy) and flips mesh.crumbling", () => {
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh, boneA, boneB, root } = newFakeMesh();
  assertEquals(scene.children.length, 0);

  controller.onDeath("e1", mesh, CRUMBLE_DEF, 100, newCtx(scene, () => {}));

  assertEquals(mesh.crumbling, true, "onDeath must flip mesh.crumbling");
  assertEquals(scene.children.length, 1, "exactly one new container Group added to the scene — no other new Object3D");
  const container = scene.children[0];
  // Every bone — including boneB, which was a CHILD of boneA before death —
  // becomes an independent piece parented directly to the container. This
  // flattening IS the crumble effect (the body comes apart into its bone
  // parts, not just detaches as one rigid rig).
  assertEquals(boneA.parent, container, "boneA reparents directly under the corpse container");
  assertEquals(boneB.parent, container, "boneB (formerly a child of boneA) ALSO reparents directly under the container");
  assertEquals(root.children.length, 0, "the original skeleton root is left with no bone children");
});

Deno.test("onDeath: a populated entity-root attachment anchor (held weapon/shield) becomes a falling piece — never left hanging frozen on the dead mesh", () => {
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh, root } = newFakeMesh();
  const heldAnchor = addAttachment(mesh, "main_hand", root, false);

  controller.onDeath("e1", mesh, CRUMBLE_DEF, 100, newCtx(scene, () => {}));

  const container = scene.children[0];
  assertEquals(heldAnchor.parent, container, "the held-item anchor reparents into the corpse container");
  assertEquals(mesh.attachments.has("main_hand"), false, "ownership transfers to the corpse — the slot leaves mesh.attachments");

  // And it FALLS with the body (it is a real piece, not just reparented).
  const heightBefore = heldAnchor.position.y;
  controller.update(0.05, 20, () => -100, () => {});
  controller.update(0.05, 20, () => -100, () => {});
  assert(heldAnchor.position.y < heightBefore, "the held item must fall under gravity like every other piece");
});

Deno.test("onDeath: bone-parented and empty entity-root anchors are left alone (bone-parented ones ride their bone group for free)", () => {
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh, boneA, root } = newFakeMesh();
  const armorAnchor = addAttachment(mesh, "chest", boneA, true);
  const emptyAnchor = addAttachment(mesh, "off_hand", root, false, false);

  controller.onDeath("e1", mesh, CRUMBLE_DEF, 100, newCtx(scene, () => {}));

  assertEquals(armorAnchor.parent, boneA, "a bone-parented anchor stays on its bone group (which is itself now a piece)");
  assert(mesh.attachments.has("chest"), "bone-parented slots keep their attachments entry");
  assertEquals(emptyAnchor.parent, root, "an empty entity-root anchor renders nothing — not worth a piece");
  assert(mesh.attachments.has("off_hand"), "empty slots keep their attachments entry (clearMeshContent still owns them)");
});

Deno.test("onDeath: is idempotent — a second call for an already-tracked entity does not re-detach or add a second container", () => {
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh } = newFakeMesh();

  controller.onDeath("e1", mesh, CRUMBLE_DEF, 100, newCtx(scene, () => {}));
  controller.onDeath("e1", mesh, CRUMBLE_DEF, 100, newCtx(scene, () => {}));

  assertEquals(scene.children.length, 1, "re-delivering EntityDied for the same entity must not add a second container");
});

Deno.test("update: pieces fall under gravity (world height decreases) before landing", () => {
  // ballisticStep integrates position from the PRE-step velocity (explicit
  // Euler) — with zero initial velocity (impulseSpeed [0,0]) the very
  // first tick only changes velocity, not position yet. Two ticks in,
  // position must have started dropping.
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh, boneA } = newFakeMesh();
  controller.onDeath("e1", mesh, CRUMBLE_DEF, 100, newCtx(scene, () => {}));

  const heightBefore = boneA.position.y;
  controller.update(0.05, 20, () => 0, () => {});
  controller.update(0.05, 20, () => 0, () => {});
  const heightAfter = boneA.position.y;

  assert(heightAfter < heightBefore, `piece must fall: ${heightAfter} should be < ${heightBefore}`);
});

Deno.test("update: a piece settles at terrain height, zeroes velocity, and stays put", () => {
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh, boneA } = newFakeMesh();
  controller.onDeath("e1", mesh, CRUMBLE_DEF, 100, newCtx(scene, () => {}));

  // Run enough ticks (starting height 5, zero initial velocity, gravity 20)
  // to guarantee landing at terrain height 0.
  for (let i = 0; i < 60; i++) controller.update(1 / 20, 20, () => 0, () => {});

  assertEquals(boneA.position.y, 0, "settled piece sits exactly at terrain height (three-space up = server z)");
  const heightAtSettle = boneA.position.y;
  controller.update(1 / 20, 20, () => 0, () => {});
  assertEquals(boneA.position.y, heightAtSettle, "a settled piece does not keep moving on further ticks");
});

Deno.test("update: the impact particle fires exactly once per piece, on the settle transition", () => {
  // spawnParticleBurst is a per-FRAME callback passed to update() (mirrors
  // renderer.ts's real per-frame call) — NOT part of the onDeath ctx, which
  // only wires the one-time detach (see DeathStyleContext's shape).
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh } = newFakeMesh();
  const bursts: string[] = [];
  controller.onDeath("e1", mesh, CRUMBLE_DEF, 100, newCtx(scene, () => {}));

  for (let i = 0; i < 60; i++) controller.update(1 / 20, 20, () => 0, (defId) => bursts.push(defId));
  // Extra ticks after everyone has settled must not re-fire.
  for (let i = 0; i < 10; i++) controller.update(1 / 20, 20, () => 0, (defId) => bursts.push(defId));

  assertEquals(bursts.length, 2, "exactly one impact burst per piece (2 bones), never re-fired once settled");
  assert(bursts.every((id) => id === "test_crumble_impact"));
});

Deno.test("update: once age crosses durationTicks/20, the corpse's container is disposed and removed from the scene", () => {
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh } = newFakeMesh();
  const durationTicks = 20; // 1 second
  controller.onDeath("e1", mesh, CRUMBLE_DEF, durationTicks, newCtx(scene, () => {}));
  assertEquals(scene.children.length, 1);

  // Advance well past durationTicks/20 = 1.0s.
  for (let i = 0; i < 30; i++) controller.update(0.1, 20, () => 0, () => {});

  assertEquals(scene.children.length, 0, "the corpse container must be removed from the scene once its linger window ends");
});

Deno.test("dispose: tears down a still-lingering corpse early (AoI exit / tile transition) without waiting for its timer", () => {
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh } = newFakeMesh();
  controller.onDeath("e1", mesh, CRUMBLE_DEF, 200, newCtx(scene, () => {}));
  assertEquals(scene.children.length, 1);

  controller.dispose("e1");

  assertEquals(scene.children.length, 0, "dispose() removes the container immediately");
  // Idempotent — disposing an untracked id is a no-op, never a throw.
  controller.dispose("e1");
  controller.dispose("never-tracked");
});

Deno.test("disposeAll: tears down every tracked corpse (renderer shutdown)", () => {
  const controller = new CrumbleController();
  const scene = new THREE.Scene();
  const { mesh: meshA } = newFakeMesh();
  const { mesh: meshB } = newFakeMesh();
  controller.onDeath("e1", meshA, CRUMBLE_DEF, 200, newCtx(scene, () => {}));
  controller.onDeath("e2", meshB, CRUMBLE_DEF, 200, newCtx(scene, () => {}));
  assertEquals(scene.children.length, 2);

  controller.disposeAll();

  assertEquals(scene.children.length, 0);
});
