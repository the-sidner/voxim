/**
 * The wireId→codec cross-check (T-349) runs as a top-level throw the moment
 * component_registry.ts loads — importing NETWORKED_DEFS here already
 * exercises it against the live registries. These tests additionally pin the
 * T-349 de-networking decision so a future change can't silently re-add
 * ActorSlots/Inscribed/QualityStamped to the wire (or drop them from ALL_DEFS
 * and break save/load) without touching this file.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { CODEC_BY_WIREID, PRESENCE_ONLY_WIRE_IDS } from "@voxim/protocol";
import { ALL_DEFS, NETWORKED_DEFS } from "./component_registry.ts";
import { ActorSlots } from "./components/action.ts";
import { Inscribed, QualityStamped } from "./components/instance.ts";

Deno.test("T-349: every networked def has a client decoder or a presence-only opt-out", () => {
  for (const def of NETWORKED_DEFS) {
    assert(
      CODEC_BY_WIREID.has(def.wireId) || PRESENCE_ONLY_WIRE_IDS.has(def.wireId),
      `"${def.name}" (wire id ${def.wireId}) is networked but undecodable on the client`,
    );
  }
});

Deno.test("T-349: ActorSlots/Inscribed/QualityStamped are server-only, not networked", () => {
  for (const def of [ActorSlots, Inscribed, QualityStamped]) {
    assertEquals(def.networked, false, `${def.name} must be networked: false`);
    assert(
      !(NETWORKED_DEFS as ReadonlyArray<unknown>).includes(def),
      `${def.name} must not be in NETWORKED_DEFS`,
    );
    assert(
      ALL_DEFS.includes(def),
      `${def.name} must still be in ALL_DEFS (save/load and prefabs key off DEF_BY_NAME)`,
    );
  }
});
