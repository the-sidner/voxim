/**
 * City macro-sim (T-142) — utility-AI fallback that lets cities evolve even
 * without an LLM. Pure functions: input is the current CityState + tick,
 * output is the next state, an array of TileCommands to dispatch, and event
 * log entries to append. The coordinator persists the result.
 *
 * The shape lives here (not in @voxim/db) because the database column is
 * untyped jsonb — only the coordinator interprets it. Future migrations may
 * version the shape; for now it's a single revision.
 */

export const CITY_EVENT_LOG_LIMIT = 200;

export type CityPersonality = "stern" | "industrious" | "wary" | "ambitious";

export interface CityState {
  /** Bias on goal weighting + caravan dispatch threshold. */
  personality: CityPersonality;
  /** Coarse priorities used when ranking competing utilities. 0..1. */
  goals: { food: number; safety: number; trade: number };
  /** cityId → -1..1 affinity with another city. */
  relationships: Record<string, number>;
  /** Stockpile counters per resource. Coarse, integer-ish. */
  inventory: { grain: number; lumber: number; ore: number };
  populationCount: number;
  farmerCount: number;
  guardCount: number;
  /** Coordinator tick of the last caravan dispatch — throttle window. */
  lastCaravanTick: number;
}

/** TileCommand variants the utility AI can request. */
export type UtilityCommand =
  | { kind: "spawn_role"; role: "farmer" | "guard"; count: number }
  | {
      kind: "dispatch_caravan";
      toTileId: string;
      cargo: { itemType: string; quantity: number }[];
    };

export interface CityEvent {
  /** Coordinator tick at which the event happened. */
  tick: number;
  /** Free-text kind: utility AI uses these labels. */
  kind: string;
  /** Optional structured detail. Kept loose so future fields don't churn the schema. */
  detail?: Record<string, unknown>;
}

export interface UtilityResult {
  next: CityState;
  commands: UtilityCommand[];
  events: CityEvent[];
}

const PERSONALITIES: readonly CityPersonality[] = [
  "stern", "industrious", "wary", "ambitious",
];

/** Tiny LCG so name + personality picks are deterministic per (seed, tileId). */
function lcgFor(seed: number, tileId: string): () => number {
  let s = seed >>> 0;
  for (let i = 0; i < tileId.length; i++) s = ((s * 31) >>> 0) ^ tileId.charCodeAt(i);
  if (s === 0) s = 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const NAME_SYLLABLES_A = ["Bran", "Cor", "Dun", "El", "Far", "Gor", "Hael", "Ir", "Khar", "Lin", "Mor", "Nor", "Os", "Per", "Quin", "Ral", "Sar", "Tav", "Ul", "Var"];
const NAME_SYLLABLES_B = ["dell", "ford", "garde", "haven", "keep", "march", "rest", "stead", "thain", "vale"];

export function pickCityName(seed: number, tileId: string): string {
  const r = lcgFor(seed, tileId);
  const a = NAME_SYLLABLES_A[Math.floor(r() * NAME_SYLLABLES_A.length)];
  const b = NAME_SYLLABLES_B[Math.floor(r() * NAME_SYLLABLES_B.length)];
  return `${a}${b}`;
}

export function defaultCityState(seed: number, tileId: string): CityState {
  const r = lcgFor(seed ^ 0x9e3779b9, tileId);
  const personality = PERSONALITIES[Math.floor(r() * PERSONALITIES.length)];
  return {
    personality,
    goals: { food: 1.0, safety: 0.8, trade: 0.5 },
    relationships: {},
    inventory: { grain: 30, lumber: 10, ore: 0 },
    populationCount: 12,
    farmerCount: 4,
    guardCount: 2,
    lastCaravanTick: 0,
  };
}

/** Per-cycle production/consumption tuning. Each cycle == CITY_AI_INTERVAL_TICKS coordinator ticks. */
const PRODUCTION = {
  grainPerFarmer: 2,
  grainPerCitizen: 1,
  lumberPerCycle: 1,
};

/** Heuristic thresholds. Personality scales them — see below. */
const TARGETS = {
  guardsPerCitizen: 0.2,
  caravanGrainSurplus: 50,
  caravanCooldownTicks: 60,
};

/**
 * Advance one city by one utility-AI cycle. Pure: returns the next state +
 * commands + events. Caller persists.
 *
 * Heuristics intentionally simple; this is a fallback so the world keeps
 * moving even when no LLM is wired up (T-143). Adding a new heuristic is
 * one branch + one command kind.
 */
export function runUtilityAI(prev: CityState, tick: number): UtilityResult {
  const next: CityState = {
    ...prev,
    inventory: { ...prev.inventory },
    goals: { ...prev.goals },
    relationships: { ...prev.relationships },
  };
  const commands: UtilityCommand[] = [];
  const events: CityEvent[] = [];

  // Production / consumption baseline.
  const produced = next.farmerCount * PRODUCTION.grainPerFarmer;
  const consumed = next.populationCount * PRODUCTION.grainPerCitizen;
  next.inventory.grain = Math.max(0, next.inventory.grain + produced - consumed);
  next.inventory.lumber = next.inventory.lumber + PRODUCTION.lumberPerCycle;

  // Personality scales the various thresholds — keeps the four flavours
  // observably different in the event log without a real strategy layer.
  const personalityScale: Record<CityPersonality, { food: number; guards: number; trade: number }> = {
    stern:       { food: 1.0, guards: 1.4, trade: 0.7 },
    industrious: { food: 1.2, guards: 0.9, trade: 1.2 },
    wary:        { food: 1.1, guards: 1.6, trade: 0.5 },
    ambitious:   { food: 1.0, guards: 1.0, trade: 1.5 },
  };
  const scale = personalityScale[next.personality];

  // 1) Food shortfall — not enough grain to feed the next cycle's citizens.
  const grainTarget = next.populationCount * PRODUCTION.grainPerCitizen * scale.food;
  if (next.inventory.grain < grainTarget) {
    commands.push({ kind: "spawn_role", role: "farmer", count: 1 });
    next.farmerCount += 1;
    events.push({
      tick,
      kind: "food_shortfall",
      detail: { grain: next.inventory.grain, target: Math.round(grainTarget) },
    });
  }

  // 2) Guard understaffing — keep a flat baseline plus a per-citizen rate.
  const guardTarget = Math.ceil(2 + next.populationCount * TARGETS.guardsPerCitizen * scale.guards);
  if (next.guardCount < guardTarget) {
    commands.push({ kind: "spawn_role", role: "guard", count: 1 });
    next.guardCount += 1;
    events.push({
      tick,
      kind: "guard_understaffed",
      detail: { guards: next.guardCount, target: guardTarget },
    });
  }

  // 3) Caravan dispatch — meaningful surplus, cooldown elapsed, has a
  // declared partner. For now there's no relationship graph yet (built up
  // by T-049), so we no-op trade dispatch unless the city already has a
  // recorded relationship.
  const surplusThreshold = TARGETS.caravanGrainSurplus * scale.trade;
  const cooldownReady = (tick - next.lastCaravanTick) >= TARGETS.caravanCooldownTicks;
  if (next.inventory.grain > surplusThreshold && cooldownReady) {
    const partnerTileId = pickPartnerTileId(next.relationships);
    if (partnerTileId) {
      const cargoQty = Math.floor((next.inventory.grain - surplusThreshold) * 0.5);
      commands.push({
        kind: "dispatch_caravan",
        toTileId: partnerTileId,
        cargo: [{ itemType: "grain", quantity: cargoQty }],
      });
      next.inventory.grain -= cargoQty;
      next.lastCaravanTick = tick;
      events.push({
        tick,
        kind: "caravan_dispatched",
        detail: { to: partnerTileId, grain: cargoQty },
      });
    }
  }

  // 4) Slow population growth when food's surplus and safety's met.
  if (next.inventory.grain > grainTarget * 1.5 && next.guardCount >= guardTarget) {
    next.populationCount += 1;
    events.push({ tick, kind: "population_growth", detail: { population: next.populationCount } });
  }

  return { next, commands, events };
}

/** Pick the highest-affinity partner tile id, or null if no relationships exist. */
function pickPartnerTileId(rels: Record<string, number>): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [tileId, score] of Object.entries(rels)) {
    if (score > bestScore) {
      bestScore = score;
      best = tileId;
    }
  }
  return best;
}
