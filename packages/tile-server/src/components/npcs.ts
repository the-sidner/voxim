import { defineComponent } from "@voxim/engine";
import { npcTagCodec, npcJobQueueCodec } from "@voxim/codecs";
import type { NpcTagData, NpcJobQueueData } from "@voxim/codecs";

// Re-export types for callers that previously imported them from here
export type { NpcTagData, NpcJobQueueData };
export type { Job, PlanStep, NpcPlanData } from "@voxim/codecs";

// ---- NpcTag ----
// Marker component — distinguishes NPCs from player entities.
// PhysicsSystem, CombatSystem etc. treat both identically; NpcAiSystem keys on this.

export const NpcTag = defineComponent({
  name: "npcTag" as const,
  codec: npcTagCodec,
  default: (): NpcTagData => ({ npcType: "villager", name: "Villager" }),
  networked: false,
});

// ---- NpcJobQueue ----
// Current job and scheduled follow-ups.
// Emergency states (starving, fleeing) write directly to `current`, discarding the queue.

export const NpcJobQueue = defineComponent({
  name: "npcJobQueue" as const,
  codec: npcJobQueueCodec,
  default: (): NpcJobQueueData => ({ current: null, scheduled: [], plan: null }),
  networked: false,
});
