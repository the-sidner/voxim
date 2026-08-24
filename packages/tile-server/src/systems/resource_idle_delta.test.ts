/**
 * ResourceSystem × sparse delta channel (T-363).
 *
 * `ResourceSystem` already skips the `world.mutate` call entirely when a
 * key's integrated value doesn't move (a rested actor at a bound — stamina/
 * poise at max — is a true fixpoint, `nextVal !== prev` is false). But a
 * continuously-drifting vitals key with no bound nearby (hunger/thirst
 * rising toward their thresholds) has no such fixpoint: `nextVal !== prev`
 * is true almost every tick purely from float accumulation, so it re-shipped
 * a delta every tick regardless of whether the drift was big enough for a
 * player to ever notice on the HUD bar. `Resource`'s `wireEquals` (T-363)
 * quantises each key to 0.1% of its `max` (the HUD bar's rendered
 * precision) before comparing — the committed `value` stays exact every
 * tick underneath (thresholds fire off the true integrated value, never the
 * quantised one), only the wire delta waits for a change big enough to see.
 */
import { assertEquals } from "jsr:@std/assert";
import { EventBus, World, newEntityId } from "@voxim/engine";
import { StaticContentStore } from "@voxim/content";
import type { ResourceDef } from "@voxim/content";
import type { ChangesetSet } from "@voxim/engine";
import { Resource } from "../components/resource.ts";
import { ResourceSystem } from "./resource.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
import type { DeathRequestPort } from "../events/death.ts";

const DT = 1 / 20;
const noDeaths: DeathRequestPort = { request: () => {} };

function content(...defs: ResourceDef[]): StaticContentStore {
  const s = new StaticContentStore();
  for (const d of defs) s.registerResource(d);
  return s;
}

function entityWith(world: World, values: Record<string, { value: number; max: number }>): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Resource, { values });
  return id;
}

function resourceSets(sets: ReadonlyArray<ChangesetSet>, entityId: string): ChangesetSet[] {
  return sets.filter((s) => s.entityId === entityId && s.token === Resource);
}

Deno.test("ResourceSystem: a slow, unbounded drift (hunger-shaped) ships nothing while sub-visible, then eventually catches up", () => {
  // Same rate SHAPE as data/resources/hunger.json (rises toward a threshold,
  // never a fixpoint) but a slower rate so the tick counts below stay small:
  // delta/tick = 0.001 → a whole 0.1-wide wire bucket takes ~100 ticks to cross.
  const c = content({ id: "hunger", scope: "entity", bounds: { min: 0, max: 100 }, rate: 0.02 });
  const sys = new ResourceSystem(c, newResourceEffectRegistry(), newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { hunger: { value: 0, max: 100 } });

  for (let t = 1; t <= 20; t++) {
    sys.run(w, new EventBus(), DT);
    const changeset = w.applyChangeset();
    assertEquals(
      resourceSets(changeset.sets, id).length,
      0,
      `tick ${t}: sub-visible hunger drift must not ship a delta`,
    );
  }

  // The committed value kept integrating underneath the whole time (not
  // frozen) — 20 ticks * 0.001/tick = 0.02, nowhere near a 0.1 bucket yet,
  // but genuinely nonzero and NOT the tick-1 value.
  const midValue = w.get(id, Resource)!.values.hunger.value;
  assertEquals(midValue > 0, true, "the true value must keep advancing internally even while silent on the wire");

  // Run far enough that the drift must have crossed at least one 0.1-wide
  // wire bucket — the delta finally ships, carrying the true accumulated
  // value forward (not a quantised approximation).
  let shipped = false;
  for (let t = 21; t <= 400; t++) {
    sys.run(w, new EventBus(), DT);
    const changeset = w.applyChangeset();
    if (resourceSets(changeset.sets, id).length > 0) { shipped = true; break; }
  }
  assertEquals(shipped, true, "sustained drift must eventually reach the wire once it's visible");
  assertEquals(w.get(id, Resource)!.values.hunger.value > midValue, true);
});

Deno.test("ResourceSystem: a resource resting at its bound still ships nothing (pre-existing fixpoint, unaffected by wireEquals)", () => {
  const c = content({ id: "stamina", scope: "entity", bounds: { min: 0, max: 100 }, rate: 8 });
  const sys = new ResourceSystem(c, newResourceEffectRegistry(), newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { stamina: { value: 100, max: 100 } });

  for (let t = 1; t <= 10; t++) {
    sys.run(w, new EventBus(), DT);
    const changeset = w.applyChangeset();
    assertEquals(resourceSets(changeset.sets, id).length, 0, `tick ${t}: a full-stamina actor must ship nothing`);
  }
});

Deno.test("ResourceSystem: a change big enough to matter ships immediately, not after a delay", () => {
  const c = content({ id: "poise", scope: "entity", bounds: { min: 0, max: 100 }, rate: 0 });
  const sys = new ResourceSystem(c, newResourceEffectRegistry(), newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { poise: { value: 50, max: 100 } });

  // No ambient rate — a rested resource with rate 0 is a fixpoint, silent.
  sys.run(w, new EventBus(), DT);
  assertEquals(resourceSets(w.applyChangeset().sets, id).length, 0);

  // A big externally-composed hit (e.g. a poise-damage effect elsewhere)
  // lands via the same mutate path ResourceSystem itself would use —
  // simulate it directly on the component to isolate the wireEquals check.
  w.mutate(id, Resource, (r) => ({ values: { ...r.values, poise: { value: 20, max: r.values.poise.max } } }));
  const changeset = w.applyChangeset();
  assertEquals(resourceSets(changeset.sets, id).length, 1, "a real, visible change ships on the tick it happens");
});
