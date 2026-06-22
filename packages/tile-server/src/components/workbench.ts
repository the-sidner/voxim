/**
 * WorkbenchOwner (T-082) — the dynasty that controls a workstation entity.
 *
 * Stamped on any deployed entity carrying a `WorkstationTag` with the placer's
 * `Heritage.dynastyId` (see `stampOwnershipAndCapture` in ownership.ts). It is
 * the management-layer ownership marker: NPCs pull work only from boards their
 * dynasty owns, and base capture re-stamps it.
 *
 * Capture: placing your own workstation inside an enemy base re-stamps nearby
 * enemy-owned workstations to your dynasty — destroying-and-replacing the
 * workbench transfers control of the surrounding owned structures (T-082).
 *
 * Server-only: ownership is a management-layer fact the client never renders
 * directly (the workstation panel reads `WorkstationTag`); it joins buff /
 * modifier / resource state as not-yet-networked.
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface WorkbenchOwnerData {
  /** Heritage dynasty id of the controlling player. */
  dynastyId: string;
}

const workbenchOwnerCodec: Serialiser<WorkbenchOwnerData> = {
  encode(v) {
    const w = new WireWriter();
    w.writeStr(v.dynastyId);
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    return { dynastyId: r.readStr() };
  },
};

export const WorkbenchOwner = defineComponent({
  name: "workbenchOwner" as const,
  networked: false,
  codec: workbenchOwnerCodec,
  default: (): WorkbenchOwnerData => ({ dynastyId: "" }),
});

/**
 * BuiltBy (T-083) — the dynasty that ORIGINALLY built a workstation. Unlike
 * `WorkbenchOwner` (the current controller, which `base capture` re-stamps),
 * this is stamped once at deploy and never overwritten — so a captured base
 * still carries its founders' mark. It is the persistent provenance behind the
 * grievance/reputation mechanics (T-080): "this used to be ours". Server-only.
 */
export interface BuiltByData {
  /** Heritage dynasty id of the founder who first placed this structure. */
  dynastyId: string;
}

const builtByCodec: Serialiser<BuiltByData> = {
  encode(v) {
    const w = new WireWriter();
    w.writeStr(v.dynastyId);
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    return { dynastyId: r.readStr() };
  },
};

export const BuiltBy = defineComponent({
  name: "builtBy" as const,
  networked: false,
  codec: builtByCodec,
  default: (): BuiltByData => ({ dynastyId: "" }),
});
