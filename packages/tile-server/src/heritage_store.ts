import type { EntityId } from "@voxim/engine";
import type { HeritageData, HeritageTrait } from "./components/heritage.ts";
import { heritageHealthBonus } from "./components/heritage.ts";

const MAX_HEALTH_BONUS = 50; // cap so characters don't become unkillable
const HEALTH_BONUS_PER_GEN = 5; // +5 max health per past death

/**
 * HeritageStore — dynasty persistence across permadeath cycles.
 *
 * Indexed by dynastyId (assigned once per player, persists across deaths).
 * In-memory for the vertical slice; file-backed persistence is the next step.
 */
export class HeritageStore {
  private store = new Map<string, HeritageData>();

  /**
   * Retrieve the heritage to apply when a new character spawns for this dynasty.
   * If no record exists, returns a fresh first-generation heritage.
   */
  get(dynastyId: string): HeritageData {
    return this.store.get(dynastyId) ?? {
      dynastyId,
      generation: 0,
      traits: [],
    };
  }

  /**
   * Called when a character dies. Advances the dynasty to the next generation and
   * accumulates traits for the next character.
   *
   * @param dynastyId   — The dying character's dynasty.
   * @param finalHealth — Health at time of death (unused now; for future lore).
   * @param killedBy    — Entity that dealt the killing blow (for lore generation).
   */
  recordDeath(dynastyId: string, finalHealth: number, killedBy?: EntityId): void {
    void finalHealth;
    void killedBy;

    const current = this.get(dynastyId);
    const newGen = current.generation + 1;

    // Accumulate health bonus, capped
    const existingBonus = heritageHealthBonus(current);
    const newTrait: HeritageTrait | null = existingBonus < MAX_HEALTH_BONUS
      ? { type: "health_bonus", value: HEALTH_BONUS_PER_GEN, fromGeneration: current.generation }
      : null;

    this.store.set(dynastyId, {
      dynastyId,
      generation: newGen,
      traits: newTrait ? [...current.traits, newTrait] : current.traits,
    });

    console.log(
      `[Heritage] dynasty ${dynastyId} generation ${newGen} — ` +
        `health bonus: ${existingBonus + (newTrait?.value ?? 0)}`,
    );
  }

  /** Return max health for a new character in this dynasty. */
  maxHealthFor(dynastyId: string): number {
    return 100 + heritageHealthBonus(this.get(dynastyId));
  }
}
