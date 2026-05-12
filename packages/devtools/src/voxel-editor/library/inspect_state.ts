/**
 * Inspect tab state — Preact signals.
 *
 * The inspect tab is a Browser | Preview | Inspector layout.  The Browser
 * shows the data hierarchy (skeletons, models, prefabs, library, weapon
 * actions); the Preview is a 3D scene of one prefab playing a clip with
 * an optional held weapon and an optional weapon-action swing; the
 * Inspector shows details for the selected tree node.
 */
import { signal, computed } from "@preact/signals";

/** A node in the Browser tree. */
export type TreeNodeKind =
  | { kind: "section"; id: string; label: string }
  | { kind: "skeleton"; id: string }
  | { kind: "skel-clip"; skeletonId: string; clipId: string; fromLibrary: boolean }
  | { kind: "skel-bone"; skeletonId: string; boneId: string }
  | { kind: "model"; id: string }
  | { kind: "prefab"; id: string }
  | { kind: "weapon-action"; id: string }
  | { kind: "library-clip"; id: string };

/** Identifier for the selected tree node — opaque string built from kind+id. */
export const selectedTreeNode = signal<string | null>(null);

/** Set of expanded tree node ids. */
export const expandedTreeNodes = signal<ReadonlySet<string>>(new Set([
  "section:skeletons", "section:prefabs",
]));

// ---- preview scene state ----

/**
 * Prefab being previewed.  Drives which model attaches to which skeleton and
 * provides the `animationSlots` map the locomotion picker reads from.
 */
export const previewPrefabId = signal<string | null>(null);

/** Held-weapon prefab id, or null for unarmed. */
export const previewWeaponPrefabId = signal<string | null>(null);

/** Currently-playing locomotion clip slot. */
export type Locomotion = "idle" | "walk" | "crouch" | "crouch_walk";
export const previewLocomotion = signal<Locomotion>("idle");

/** Multiplier on top of the clip's natural rate (1.0 = real time). */
export const previewSpeed = signal<number>(1.0);

/**
 * Active weapon-action swing.  Set when the user clicks "Trigger"; cleared
 * automatically when ticksIntoAction reaches the action's total duration.
 */
export interface ActiveSwing {
  weaponActionId: string;
  ticksIntoAction: number;
  totalTicks: number;
}
export const activeSwing = signal<ActiveSwing | null>(null);

/** True when the preview should advance animation each frame. */
export const previewPlaying = signal<boolean>(true);

// ---- derived ----

/** Resolves the current locomotion's clip id via the prefab's slot map. */
export const currentLocomotionClipId = computed<string>(() => {
  // The actual lookup with prefab.animationSlots happens in the scene code
  // — this computed exists so UI can show the resolved name.
  return previewLocomotion.value;
});
