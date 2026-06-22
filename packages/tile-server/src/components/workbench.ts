/**
 * WorkbenchOwner (T-038) — the dynasty that placed a deployable workbench
 * (currently the hiring job_board).
 *
 * Stamped by the EntityDeployed subscriber in server.ts when a `job_board`
 * prefab is deployed: it reads the placer's Heritage.dynastyId and records it
 * here so downstream systems can answer "whose board is this?" — hiring
 * permission today, base capture later (T-082).
 *
 * Server-only: ownership is a server-side authority fact; the client never
 * needs to decode it (it learns the board's identity from ModelRef like any
 * other workstation).
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface WorkbenchOwnerData {
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
