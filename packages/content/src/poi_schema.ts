/**
 * Runtime validation for POI definitions loaded from
 * `packages/content/data/pois/{id}.json`.
 *
 * The TypeScript shapes in `types.ts` describe the static contract; this
 * module is the runtime gatekeeper that rejects malformed authoring at
 * load time. Without it, an unknown `type` value or a misspelled gate
 * `kind` would silently slip through and only surface inside the
 * generator (T-209) as a confusing "no matching POI runner" error.
 *
 * Cross-field rules enforced here (beyond per-field shape):
 *   - `activity` shape must match the parent `type` discriminator.
 *   - `gate.kind: "open"` may NOT carry a `flavorAccept` array (that
 *     field is meaningless without a key to match).
 *   - `gate.kind: "item"` MUST have `trinketRef: null` at author time
 *     (the generator fills it; authored bindings would couple POIs).
 *   - `difficulty` ∈ [1, 5]; `quotaWeight` ≥ 0; `schema === 1`.
 */
import * as v from "valibot";
import type { PoiDef } from "./types.ts";

// ---- enums ----

const POI_TYPES = ["encounter", "bossfight", "wave", "puzzle", "action", "exploration"] as const;
const ZONE_ROLES = ["plaza", "pocket", "deadend", "corridor", "crossroads", "lobby", "arena"] as const;
const POI_ROLES  = ["entry", "midchain", "terminal", "optional"] as const;

// ---- shared sub-schemas ----

const enclosureSchema = v.object({
  min: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  max: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
});

const fitSchema = v.object({
  preferredTopology: v.array(v.picklist(ZONE_ROLES)),
  minArea: v.pipe(v.number(), v.minValue(0)),
  maxArea: v.pipe(v.number(), v.minValue(0)),
  enclosure: v.optional(enclosureSchema),
  requiredKind: v.optional(v.array(v.string())),
  requiredBiome: v.optional(v.array(v.string())),
});

const trinketThemeSchema = v.object({
  themes: v.pipe(v.array(v.string()), v.minLength(1)),
  flavorTags: v.array(v.string()),
  visualHint: v.optional(v.string()),
});

const extraDropSchema = v.object({
  kind: v.picklist(["lore", "stack", "unique"]),
  id: v.string(),
  qty: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  chance: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
});

const rewardSchema = v.object({
  trinketTheme: trinketThemeSchema,
  extras: v.array(extraDropSchema),
});

// ---- activity schemas (per type) ----

const activityEncounterSchema = v.object({
  spawnTable: v.string(),
  spawnTriggerRadius: v.pipe(v.number(), v.minValue(0)),
  minClearKills: v.union([v.literal("all"), v.pipe(v.number(), v.integer(), v.minValue(1))]),
  regenAfterTicks: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const activityBossfightSchema = v.object({
  bossNpcId: v.string(),
  arenaRules: v.object({
    lockEntry: v.boolean(),
    phaseTriggers: v.array(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
    addsTable: v.nullable(v.string()),
  }),
});

const waveEntrySchema = v.object({
  spawn: v.string(),
  count: v.pipe(v.number(), v.integer(), v.minValue(1)),
  interval: v.pipe(v.number(), v.minValue(0)),
});

const activityWaveSchema = v.object({
  waves: v.pipe(v.array(waveEntrySchema), v.minLength(1)),
  interWaveSeconds: v.pipe(v.number(), v.minValue(0)),
  playerSafeZoneRadius: v.pipe(v.number(), v.minValue(0)),
});

const activityPuzzleSchema = v.object({
  puzzleId: v.string(),
  params: v.record(v.string(), v.unknown()),
  failurePenalty: v.picklist(["reset", "damage", "none"]),
});

const activityActionSchema = v.object({
  interactionPrefab: v.string(),
  verb: v.string(),
  consumable: v.boolean(),
  preconditionTags: v.array(v.string()),
});

const activityExplorationSchema = v.object({
  triggerKind: v.picklist(["proximity", "look-at", "destroy-prop"]),
  triggerRadius: v.pipe(v.number(), v.minValue(0)),
  loreId: v.string(),
});

const ACTIVITY_SCHEMA_BY_TYPE: Record<typeof POI_TYPES[number], v.GenericSchema> = {
  encounter:   activityEncounterSchema,
  bossfight:   activityBossfightSchema,
  wave:        activityWaveSchema,
  puzzle:      activityPuzzleSchema,
  action:      activityActionSchema,
  exploration: activityExplorationSchema,
};

// ---- gate schemas (discriminated on kind) ----

const gateOpenSchema = v.object({
  kind: v.literal("open"),
});
const gateItemSchema = v.object({
  kind: v.literal("item"),
  trinketRef: v.null(),
  flavorAccept: v.pipe(v.array(v.string()), v.minLength(1)),
});
const gateMultiSchema = v.object({
  kind: v.literal("multi"),
  count: v.pipe(v.number(), v.integer(), v.minValue(2)),
  flavorAccept: v.pipe(v.array(v.string()), v.minLength(1)),
});
const gateChoiceSchema = v.object({
  kind: v.literal("choice"),
  count: v.pipe(v.number(), v.integer(), v.minValue(1)),
  flavorAccept: v.pipe(v.array(v.string()), v.minLength(1)),
});
const gateSchema = v.variant("kind", [
  gateOpenSchema, gateItemSchema, gateMultiSchema, gateChoiceSchema,
]);

// ---- POI top-level ----

const poiBaseSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  schema: v.literal(1),
  displayName: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(POI_TYPES),
  activity: v.unknown(),  // re-validated per-type below
  fit: fitSchema,
  gate: gateSchema,
  reward: rewardSchema,
  tags: v.array(v.string()),
  difficulty: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
  quotaWeight: v.pipe(v.number(), v.minValue(0)),
  roles: v.array(v.picklist(POI_ROLES)),
});

/**
 * Parse a raw JSON object into a typed `PoiDef`. Throws with the POI's id
 * (when readable) and a list of valibot issues on validation failure.
 *
 * Re-validates `activity` separately against the per-type schema after the
 * top-level parse confirms `type` is in the closed set. This two-pass shape
 * is simpler than encoding the cross-field rule inside one valibot schema
 * (which would require a discriminated union mirroring the type field).
 */
export function parsePoiDef(raw: unknown): PoiDef {
  const idHint = (raw && typeof raw === "object" && "id" in raw && typeof (raw as { id: unknown }).id === "string")
    ? (raw as { id: string }).id
    : "<unknown>";

  const baseResult = v.safeParse(poiBaseSchema, raw);
  if (!baseResult.success) {
    throw new Error(
      `[poi_schema] '${idHint}': ${baseResult.issues.map(i => `${i.path?.map(p => p.key).join(".") ?? "<root>"}: ${i.message}`).join("; ")}`,
    );
  }
  const base = baseResult.output;

  const activitySchema = ACTIVITY_SCHEMA_BY_TYPE[base.type];
  const actResult = v.safeParse(activitySchema, base.activity);
  if (!actResult.success) {
    throw new Error(
      `[poi_schema] '${idHint}' (type=${base.type}): activity mismatch — ${actResult.issues.map(i => `${i.path?.map(p => p.key).join(".") ?? "<root>"}: ${i.message}`).join("; ")}`,
    );
  }

  // Cast — base + actResult together cover every PoiDef field.
  return { ...base, activity: actResult.output } as unknown as PoiDef;
}
