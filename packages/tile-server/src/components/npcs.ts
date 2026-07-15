import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

// ---- NpcTag -----------------------------------------------------------------
// { npcType: string; name: string }
// networked: false — server-only marker component.

export interface NpcTagData {
  npcType: string;
  name: string;
}

export const npcTagCodec: Serialiser<NpcTagData> = {
  encode(d: NpcTagData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(d.npcType);
    w.writeStr(d.name);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): NpcTagData {
    const r = new WireReader(bytes);
    return { npcType: r.readStr(), name: r.readStr() };
  },
};

// ---- NpcJobQueue ------------------------------------------------------------
// Complex union-typed server-only AI state.
// networked: false — never leaves the server; codec needed only for persistence.

export type Job =
  | { type: "idle";          expiresAt: number }
  | { type: "wander";        targetX: number; targetY: number; expiresAt: number }
  | { type: "seekFood";      expiresAt: number }
  | { type: "seekWater";     expiresAt: number }
  | { type: "seekBed";       expiresAt: number }
  | { type: "flee";          fromX: number; fromY: number; expiresAt: number }
  | { type: "attackTarget";  targetId: string; expiresAt: number }
  | {
      type: "craftAtWorkbench";
      workbenchType: string;
      inputs: ReadonlyArray<{ itemType: string; quantity: number }>;
      /** Set once the job handler has resolved a specific workstation entity to approach. */
      workbenchId: string | null;
      /** approach → place → hit → (job cleared). */
      phase: "approach" | "place" | "hit";
      expiresAt: number;
    }
  | {
      type: "gatherResource";
      itemType: string;
      /** Acceptable resource-node prefab ids whose yields include itemType. */
      resourceNodeTypes: ReadonlyArray<string>;
      /** Total inventory count of itemType the NPC wants to end with. */
      targetQuantity: number;
      /** Set once the job handler has resolved a specific node entity to approach. */
      nodeId: string | null;
      expiresAt: number;
    }
  | {
      type: "caravanEscort";
      /** Tile the caravan is bound for; matched against a GateLink's destinationTileId. */
      destinationTileId: string;
      expiresAt: number;
    };

export type PlanStep =
  | { kind: "moveTo";   x: number; y: number }
  | { kind: "interact"; targetId: string; verb: string }
  | { kind: "wait";     ticks: number; ticksRemaining: number }
  | { kind: "dropItem"; itemType: string; quantity: number };

export interface NpcPlanData {
  steps: PlanStep[];
  stepIdx: number;
  expiresAt: number;
  lastKnownTargetX?: number;
  lastKnownTargetY?: number;
}

export interface NpcJobQueueData {
  current: Job | null;
  scheduled: Job[];
  plan: NpcPlanData | null;
}

// Job discriminants
const JOB_IDLE        = 0;
const JOB_WANDER      = 1;
const JOB_SEEK_FOOD   = 2;
const JOB_SEEK_WATER  = 3;
const JOB_FLEE        = 4;
const JOB_ATTACK      = 5;
const JOB_CRAFT_AT    = 6;
const JOB_GATHER      = 7;
const JOB_SEEK_BED    = 8;
const JOB_CARAVAN     = 9;

// craftAtWorkbench phase discriminants
const CRAFT_APPROACH = 0;
const CRAFT_PLACE    = 1;
const CRAFT_HIT      = 2;

// Plan step discriminants
const STEP_MOVE_TO  = 0;
const STEP_INTERACT = 1;
const STEP_WAIT     = 2;
const STEP_DROP     = 3;

function writeJob(w: WireWriter, job: Job): void {
  switch (job.type) {
    case "idle":         w.writeU8(JOB_IDLE);   w.writeI32(job.expiresAt); break;
    case "wander":       w.writeU8(JOB_WANDER); w.writeF32(job.targetX); w.writeF32(job.targetY); w.writeI32(job.expiresAt); break;
    case "seekFood":     w.writeU8(JOB_SEEK_FOOD);  w.writeI32(job.expiresAt); break;
    case "seekWater":    w.writeU8(JOB_SEEK_WATER); w.writeI32(job.expiresAt); break;
    case "seekBed":      w.writeU8(JOB_SEEK_BED);   w.writeI32(job.expiresAt); break;
    case "flee":         w.writeU8(JOB_FLEE); w.writeF32(job.fromX); w.writeF32(job.fromY); w.writeI32(job.expiresAt); break;
    case "attackTarget": w.writeU8(JOB_ATTACK); w.writeStr(job.targetId); w.writeI32(job.expiresAt); break;
    case "craftAtWorkbench":
      w.writeU8(JOB_CRAFT_AT);
      w.writeStr(job.workbenchType);
      w.writeU8(job.phase === "approach" ? CRAFT_APPROACH : job.phase === "place" ? CRAFT_PLACE : CRAFT_HIT);
      w.writeStr(job.workbenchId ?? "");
      w.writeU16(job.inputs.length);
      for (const inp of job.inputs) { w.writeStr(inp.itemType); w.writeU16(inp.quantity); }
      w.writeI32(job.expiresAt);
      break;
    case "gatherResource":
      w.writeU8(JOB_GATHER);
      w.writeStr(job.itemType);
      w.writeU16(job.targetQuantity);
      w.writeStr(job.nodeId ?? "");
      w.writeU16(job.resourceNodeTypes.length);
      for (const t of job.resourceNodeTypes) w.writeStr(t);
      w.writeI32(job.expiresAt);
      break;
    case "caravanEscort":
      w.writeU8(JOB_CARAVAN);
      w.writeStr(job.destinationTileId);
      w.writeI32(job.expiresAt);
      break;
  }
}

function readJob(r: WireReader): Job {
  const kind = r.readU8();
  switch (kind) {
    case JOB_IDLE:       return { type: "idle",          expiresAt: r.readI32() };
    case JOB_WANDER:     return { type: "wander",        targetX: r.readF32(), targetY: r.readF32(), expiresAt: r.readI32() };
    case JOB_SEEK_FOOD:  return { type: "seekFood",      expiresAt: r.readI32() };
    case JOB_SEEK_WATER: return { type: "seekWater",     expiresAt: r.readI32() };
    case JOB_SEEK_BED:   return { type: "seekBed",       expiresAt: r.readI32() };
    case JOB_FLEE:       return { type: "flee",          fromX: r.readF32(), fromY: r.readF32(), expiresAt: r.readI32() };
    case JOB_ATTACK:     return { type: "attackTarget",  targetId: r.readStr(), expiresAt: r.readI32() };
    case JOB_CRAFT_AT: {
      const workbenchType = r.readStr();
      const phaseDisc = r.readU8();
      const phase: "approach" | "place" | "hit" =
        phaseDisc === CRAFT_APPROACH ? "approach" :
        phaseDisc === CRAFT_PLACE    ? "place" : "hit";
      const wbid = r.readStr();
      const workbenchId = wbid === "" ? null : wbid;
      const n = r.readU16();
      const inputs: Array<{ itemType: string; quantity: number }> = [];
      for (let i = 0; i < n; i++) inputs.push({ itemType: r.readStr(), quantity: r.readU16() });
      const expiresAt = r.readI32();
      return { type: "craftAtWorkbench", workbenchType, phase, workbenchId, inputs, expiresAt };
    }
    case JOB_GATHER: {
      const itemType = r.readStr();
      const targetQuantity = r.readU16();
      const rawId = r.readStr();
      const nodeId = rawId === "" ? null : rawId;
      const n = r.readU16();
      const resourceNodeTypes: string[] = [];
      for (let i = 0; i < n; i++) resourceNodeTypes.push(r.readStr());
      const expiresAt = r.readI32();
      return { type: "gatherResource", itemType, targetQuantity, nodeId, resourceNodeTypes, expiresAt };
    }
    case JOB_CARAVAN: {
      const destinationTileId = r.readStr();
      const expiresAt = r.readI32();
      return { type: "caravanEscort", destinationTileId, expiresAt };
    }
    default: throw new Error(`Unknown job kind: ${kind}`);
  }
}

function writePlanStep(w: WireWriter, step: PlanStep): void {
  switch (step.kind) {
    case "moveTo":   w.writeU8(STEP_MOVE_TO);  w.writeF32(step.x); w.writeF32(step.y); break;
    case "interact": w.writeU8(STEP_INTERACT); w.writeStr(step.targetId); w.writeStr(step.verb); break;
    case "wait":     w.writeU8(STEP_WAIT);     w.writeI32(step.ticks); w.writeI32(step.ticksRemaining); break;
    case "dropItem": w.writeU8(STEP_DROP);     w.writeStr(step.itemType); w.writeU16(step.quantity); break;
  }
}

function readPlanStep(r: WireReader): PlanStep {
  const kind = r.readU8();
  switch (kind) {
    case STEP_MOVE_TO:  return { kind: "moveTo",   x: r.readF32(), y: r.readF32() };
    case STEP_INTERACT: return { kind: "interact", targetId: r.readStr(), verb: r.readStr() };
    case STEP_WAIT:     return { kind: "wait",     ticks: r.readI32(), ticksRemaining: r.readI32() };
    case STEP_DROP:     return { kind: "dropItem", itemType: r.readStr(), quantity: r.readU16() };
    default: throw new Error(`Unknown plan step kind: ${kind}`);
  }
}

export const npcJobQueueCodec: Serialiser<NpcJobQueueData> = {
  encode(d: NpcJobQueueData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(d.current ? 1 : 0);
    if (d.current) writeJob(w, d.current);
    w.writeU16(d.scheduled.length);
    for (const job of d.scheduled) writeJob(w, job);
    w.writeU8(d.plan ? 1 : 0);
    if (d.plan) {
      w.writeU16(d.plan.steps.length);
      for (const step of d.plan.steps) writePlanStep(w, step);
      w.writeU16(d.plan.stepIdx);
      w.writeI32(d.plan.expiresAt);
      const hasTarget = d.plan.lastKnownTargetX !== undefined;
      w.writeU8(hasTarget ? 1 : 0);
      if (hasTarget) { w.writeF32(d.plan.lastKnownTargetX!); w.writeF32(d.plan.lastKnownTargetY!); }
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): NpcJobQueueData {
    const r = new WireReader(bytes);
    const current   = r.readU8() ? readJob(r) : null;
    const numSched  = r.readU16();
    const scheduled: Job[] = [];
    for (let i = 0; i < numSched; i++) scheduled.push(readJob(r));
    let plan: NpcPlanData | null = null;
    if (r.readU8()) {
      const numSteps = r.readU16();
      const steps: PlanStep[] = [];
      for (let i = 0; i < numSteps; i++) steps.push(readPlanStep(r));
      const stepIdx   = r.readU16();
      const expiresAt = r.readI32();
      const hasTarget = r.readU8() !== 0;
      plan = {
        steps, stepIdx, expiresAt,
        lastKnownTargetX: hasTarget ? r.readF32() : undefined,
        lastKnownTargetY: hasTarget ? r.readF32() : undefined,
      };
    }
    return { current, scheduled, plan };
  },
};

// ---- NpcTag component ----
// Marker component — distinguishes NPCs from player entities.
// PhysicsSystem, CombatSystem etc. treat both identically; NpcAiSystem keys on this.

export const NpcTag = defineComponent({
  name: "npcTag" as const,
  codec: npcTagCodec,
  default: (): NpcTagData => ({ npcType: "villager", name: "Villager" }),
  networked: false,
});

// ---- NpcJobQueue component ----
// Current job and scheduled follow-ups.
// Emergency states (starving, fleeing) write directly to `current`, discarding the queue.

export const NpcJobQueue = defineComponent({
  name: "npcJobQueue" as const,
  codec: npcJobQueueCodec,
  default: (): NpcJobQueueData => ({ current: null, scheduled: [], plan: null }),
  networked: false,
});
