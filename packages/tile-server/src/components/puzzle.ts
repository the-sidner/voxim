/**
 * Puzzle POI runtime components (T-212 v2, `lever_sequence` template).
 *
 * `PuzzleState` lives on the `PoiTrigger` entity (joined by `poiInstanceId`,
 * same convention `WaveState`/`ArenaLock` use): the content-defined
 * `correctOrder` (a deterministic permutation derived from the POI
 * instance id, so re-solving the same POI on a reload — mid-tile-lifetime,
 * no save persistence — reproduces the same sequence) and `nextIndex`, the
 * next lever the player must pull to progress.
 *
 * `Lever` tags each spawned lever prop entity with its own index within
 * the sequence (0-based) — the `UseEntity` handler resolves which lever
 * was pulled by reading this off the clicked entity, not by parsing verbs.
 *
 * Both server-only: the client only ever sees `PoiInteractable` (the
 * generic "this is clickable" marker every lever also carries).
 */

import { defineComponent } from "@voxim/engine";
import { WireReader, WireWriter } from "@voxim/codecs";

export interface PuzzleStateData {
  poiInstanceId: string;
  /** Deterministic permutation of [0, leverCount) — the order levers must
   * be pulled in. */
  correctOrder: number[];
  /** Index into `correctOrder` the player must pull next. Equal to
   * `correctOrder.length` once solved. */
  nextIndex: number;
  solved: boolean;
}

export const PuzzleState = defineComponent({
  name: "puzzleState" as const,
  networked: false,
  codec: {
    encode(v: PuzzleStateData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.poiInstanceId);
      w.writeU8(v.correctOrder.length);
      for (const i of v.correctOrder) w.writeU8(i);
      w.writeU8(v.nextIndex);
      w.writeU8(v.solved ? 1 : 0);
      return w.toBytes();
    },
    decode(b: Uint8Array): PuzzleStateData {
      const r = new WireReader(b);
      const poiInstanceId = r.readStr();
      const n = r.readU8();
      const correctOrder: number[] = [];
      for (let i = 0; i < n; i++) correctOrder.push(r.readU8());
      const nextIndex = r.readU8();
      const solved = r.readU8() === 1;
      return { poiInstanceId, correctOrder, nextIndex, solved };
    },
  },
  default: (): PuzzleStateData => ({ poiInstanceId: "", correctOrder: [], nextIndex: 0, solved: false }),
});

export interface LeverData {
  poiInstanceId: string;
  /** This lever's own index (0-based) within the sequence — NOT the
   * position in `correctOrder`. */
  leverIndex: number;
}

export const Lever = defineComponent({
  name: "lever" as const,
  networked: false,
  codec: {
    encode(v: LeverData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.poiInstanceId);
      w.writeU8(v.leverIndex);
      return w.toBytes();
    },
    decode(b: Uint8Array): LeverData {
      const r = new WireReader(b);
      return { poiInstanceId: r.readStr(), leverIndex: r.readU8() };
    },
  },
  default: (): LeverData => ({ poiInstanceId: "", leverIndex: 0 }),
});
