/**
 * Treat step (T-009) — a swing at the alchemist_bench with a treat recipe and a
 * poultice heals one severity off the crafter's first injury, consuming the
 * poultice; the injury (and ultimately the whole component) clears as severity
 * reaches 0. Runs against real content (data/recipes/treat_injury.json).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Injury } from "../../components/injury.ts";
import type { InjuryEntry } from "../../components/injury.ts";
import { WorkstationTag, WorkstationBuffer } from "../../components/building.ts";
import type { WorkstationBufferData } from "@voxim/codecs";
import { treatStep } from "./treat_step.ts";
import type { RecipeHitContext } from "../step_handler.ts";

const content = await JsonSource.load();
const PATIENT = "patient-1";

function setup(injuries: InjuryEntry[] | null, fiber: number) {
  const w = new World();
  const patient = newEntityId();
  w.create(patient);
  if (injuries) w.write(patient, Injury, { injuries });

  const bench = newEntityId();
  w.create(bench);
  w.write(bench, WorkstationTag, { stationType: "alchemist_bench", qualityTier: 1 });
  const slots: WorkstationBufferData["slots"] = [];
  if (fiber > 0) slots.push({ kind: "stack", itemType: "plant_fiber", quantity: fiber });
  const buffer: WorkstationBufferData = { capacity: 4, activeRecipeId: "treat_injury", slots };
  w.write(bench, WorkstationBuffer, buffer);
  return { w, patient, bench, buffer };
}

function hit(w: World, bench: string, buffer: WorkstationBufferData, attackerId = PATIENT): RecipeHitContext {
  return {
    world: w, events: new EventBus(), content,
    stationId: bench, stationType: "alchemist_bench", buffer,
    hit: { attackerId, weaponStats: { toolType: null } },
  } as unknown as RecipeHitContext;
}

const hasFiber = (w: World, bench: string) =>
  (w.get(bench, WorkstationBuffer)!.slots.filter(Boolean) as Array<{ kind: string; itemType?: string }>)
    .some((s) => s.kind === "stack" && s.itemType === "plant_fiber");

Deno.test("treat: reduces injury severity by one and consumes the poultice", () => {
  const { w, patient, bench, buffer } = setup([{ typeId: "broken_leg", severity: 2 }], 2);
  treatStep.onHit!(hit(w, bench, buffer, patient));
  w.applyChangeset();

  assertEquals(w.get(patient, Injury)!.injuries, [{ typeId: "broken_leg", severity: 1 }]);
  assert(!hasFiber(w, bench), "the poultice was consumed");
});

Deno.test("treat: healing the last severity removes the Injury component", () => {
  const { w, patient, bench, buffer } = setup([{ typeId: "broken_leg", severity: 1 }], 2);
  treatStep.onHit!(hit(w, bench, buffer, patient));
  w.applyChangeset();

  assertEquals(w.get(patient, Injury), null, "no injuries left → component cleared");
});

Deno.test("treat: nothing to treat → no-op, poultice kept", () => {
  const { w, patient, bench, buffer } = setup(null, 2);
  treatStep.onHit!(hit(w, bench, buffer, patient));
  w.applyChangeset();
  assertEquals(w.get(patient, Injury), null);
  assert(hasFiber(w, bench), "no injury → materials not wasted");
});

Deno.test("treat: no poultice → injury unchanged", () => {
  const { w, patient, bench, buffer } = setup([{ typeId: "deep_gash", severity: 1 }], 0);
  treatStep.onHit!(hit(w, bench, buffer, patient));
  w.applyChangeset();
  assertEquals(w.get(patient, Injury)!.injuries, [{ typeId: "deep_gash", severity: 1 }]);
});
