/**
 * Tile-gate pillar markers (extracted from VoximRenderer, T-282). Owns the
 * per-gate THREE.Group meshes and the scene layer they live on; the renderer
 * forwards `updateGateMarker` / `removeGateMarker` and the world overlay reads
 * `screenPos` to anchor destination labels above each pillar.
 *
 * Accent color comes from the single palette (`gate` token).
 */
import * as THREE from "three";
import { paletteToken } from "./palette.ts";

/** A glowing-capped pillar standing at a tile edge where a gate exits the world. */
function buildGateMarker(_edge: string): THREE.Group {
  const group = new THREE.Group();
  const accent = paletteToken("gate");

  const pillarHeight = 8;
  const pillarRadius = 0.6;
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(pillarRadius, pillarRadius, pillarHeight, 8),
    new THREE.MeshStandardMaterial({ color: 0x6a6a72, roughness: 0.85 }),
  );
  pillar.position.y = pillarHeight / 2;
  group.add(pillar);

  const capHeight = 1.2;
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(pillarRadius * 1.4, pillarRadius * 1.4, capHeight, 8),
    new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.6,
      roughness: 0.4,
    }),
  );
  cap.position.y = pillarHeight + capHeight / 2;
  group.add(cap);

  return group;
}

export class GateMarkerRenderer {
  private readonly meshes = new Map<string, THREE.Group>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly domElement: HTMLCanvasElement,
  ) {}

  /**
   * Place (or move) a gate pillar. Server convention: x/y horizontal, z vertical.
   * Three convention: x/z horizontal, y vertical → map server (x, y, z) to three
   * (x, z, y). Caller passes z = local terrain height so the pillar sits on the ground.
   */
  update(entityId: string, x: number, y: number, z: number, edge: string): void {
    let group = this.meshes.get(entityId);
    if (!group) {
      group = buildGateMarker(edge);
      group.name = "gate";
      this.scene.add(group);
      this.meshes.set(entityId, group);
    }
    group.position.set(x, z, y);
  }

  /** Tear down a gate marker (gate left AoI / world cleared). */
  remove(entityId: string): void {
    const group = this.meshes.get(entityId);
    if (!group) return;
    this.scene.remove(group);
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else (m as THREE.Material).dispose();
      }
    });
    this.meshes.delete(entityId);
  }

  /**
   * Project a gate's world position to screen space. WorldOverlay calls this
   * each frame to anchor the destination label above the pillar.
   */
  screenPos(entityId: string): { x: number; y: number } | null {
    const group = this.meshes.get(entityId);
    if (!group) return null;
    const top = group.position.clone();
    top.y += 8; // top of the pillar in renderer coords
    top.project(this.camera);
    if (top.z > 1) return null; // behind camera
    const w = this.domElement.clientWidth;
    const h = this.domElement.clientHeight;
    return {
      x: (top.x * 0.5 + 0.5) * w,
      y: (-top.y * 0.5 + 0.5) * h,
    };
  }

  /** All live gate entity ids (the renderer iterates these on clearWorld/dispose). */
  ids(): string[] {
    return [...this.meshes.keys()];
  }

  dispose(): void {
    for (const id of this.ids()) this.remove(id);
  }
}
