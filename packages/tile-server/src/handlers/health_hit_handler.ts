import type { World, EntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { Health } from "../components/game.ts";
import { staminaValue } from "../combat/helpers.ts";
import { Resource } from "../components/resource.ts";
import { Injury } from "../components/injury.ts";
import { adjustResourceKey, upsertResourceKey } from "../resources/mutate.ts";
import {
  CounterReady,
} from "../components/combat.ts";
import { Blocking, IFrame } from "../components/tags.ts";
import { PendingReaction, ActiveActions } from "../components/action.ts";
import { Velocity } from "../components/game.ts";
import { TrainingDummy } from "../components/training_dummy.ts";
import type { DeathRequestPort } from "../events/death.ts";
import { effective } from "../modifiers/modifier.ts";
import type { ModifierSourceRegistry } from "../modifiers/modifier.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("HealthHitHandler");

/**
 * Handles hits on entities that have a Health component.
 *
 * Combat resolution flow:
 *   block/parry → outgoing damage hooks (attacker effects modify multiplier)
 *   → armor + block reduction → incoming damage hooks (target effects absorb /
 *   reduce) → apply HP change → publish HitLanded (the Trigger primitive's
 *   reified hit fact, T-259) → death request or knockback.
 *
 * Attacker/target damage modifiers (damage_boost, shield) are buff
 * scene-graph children read via the Status/Modifier `effective()` query
 * (`damageDealt` / `damageTaken`), not bespoke hooks (T-239). This handler
 * holds zero `effectStat ===` checks — on-hit riders are content triggers
 * consuming the HitLanded fact (T-259), never handler code.
 */
export class HealthHitHandler implements HitHandler {
  // T-333: dispatch bubbles to the nearest ancestor carrying Health — a hit
  // on a bone entity resolves to the creature that takes the damage.
  readonly requiredComponent = Health;

  constructor(
    private readonly content: ContentService,
    private readonly deaths: DeathRequestPort,
    private readonly modifierSources: ModifierSourceRegistry,
  ) {}

  /**
   * Reaction requests staged this tick, keyed off ctx.serverTick. Two
   * attackers' swings can both be in their active phase in the same
   * dispatcher run, so onHit fires twice against one target in one tick —
   * and PendingReaction writes from separate calls would otherwise be
   * last-write-wins in the op-log (a poise-break stagger silently
   * downgraded to a later light hit's flinch; a parry's punish stagger
   * erased by an unrelated hit on the attacker).
   */
  private stagedTick = -1;
  private readonly stagedReactions = new Map<EntityId, string>();

  /**
   * Post a reaction request, keeping the highest-`interruptPriority`
   * ActionDef when several land on one entity in one tick. Emits a plain
   * `world.set` carrying the merged winner (NOT a mutate): the resolver's
   * one-shot consume is a deferred `world.remove`, and set is the only op
   * that survives it regardless of op order — matching the pre-existing
   * single-writer semantics exactly, with only the winner changed.
   */
  private requestReaction(world: World, entityId: EntityId, actionId: string, serverTick: number): void {
    if (serverTick !== this.stagedTick) {
      this.stagedReactions.clear();
      this.stagedTick = serverTick;
    }
    const staged = this.stagedReactions.get(entityId);
    if (staged !== undefined) {
      const prio = (id: string) => this.content.actions.get(id)?.interruptPriority ?? 0;
      if (prio(staged) > prio(actionId)) return; // staged request outranks this one
    }
    this.stagedReactions.set(entityId, actionId);
    world.set(entityId, PendingReaction, { actionId });
  }

  onHit(world: World, events: EventEmitter, ctx: HitContext): void {
    const health = world.get(ctx.targetId, Health);
    if (!health) return;

    log.debug(
      "hit: attacker=%s target=%s part=%s weapon=%s",
      ctx.attackerId, ctx.targetId, ctx.bodyPart,
      ctx.weaponStats.damage != null ? `dmg=${ctx.weaponStats.damage.toFixed(1)}` : "no-damage",
    );

    const gameCfg = this.content.getGameConfig();
    const combatCfg = gameCfg.combat;
    const dodgeCfg = gameCfg.dodge;

    // iFrame check — target is momentarily invulnerable
    if (world.has(ctx.targetId, IFrame)) return;

    // ── Block / parry ─────────────────────────────────────────────────────────
    // Blocking is the `block` primary-slot action's `Blocking` tag (current
    // tick; lag-comp rewind precision is accepted retune per the
    // structure-over-parity pivot). The damage handler reads the tag rather
    // than re-deriving block from raw input bits.
    // Angle from the target TOWARD the attacker (same convention as
    // frontBackDot below and check_target_flanking.ts's defender-side
    // check): the target's facing has to point AT the attacker to block.
    // Using the attacker→target travel direction here instead would invert
    // the arc — blocking only while facing AWAY from the attacker (T-362).
    const stamGated = staminaValue(world, ctx.targetId) <= 0;
    const incomingAngle = Math.atan2(ctx.attackerY - ctx.targetY, ctx.attackerX - ctx.targetX);
    const isBlocking = !stamGated &&
      world.has(ctx.targetId, Blocking) &&
      angleDiff(incomingAngle, ctx.targetSnapshotFacing) <= combatCfg.blockArcHalfRadians;

    // Parry window = the opening ticks of the held `block` action. The
    // block action is the sole writer of the Blocking tag, so its
    // primary-slot `ticksInPhase` is exactly how long block has been held
    // (replaces the retired BlockHeld counter / CombatTimersSystem, T-233).
    const primary = world.get(ctx.targetId, ActiveActions)?.states["primary"];
    const blockHeldTicks = primary?.actionId === "block"
      ? primary.ticksInPhase
      : Number.MAX_SAFE_INTEGER;
    const isParry = ctx.parryAllowed &&
      isBlocking &&
      blockHeldTicks < dodgeCfg.parryWindowTicks;

    if (isParry) {
      // A parry hard-staggers the attacker: post a stagger_heavy reaction
      // (the action installs the `staggered` tag for its play phase — that
      // window *is* the old Staggered.ticksRemaining). The parrier opens a
      // counter window: the CounterReady flag plus a `counter_window` Resource
      // that expires it (cross@0 → clear_counter_ready) if unconsumed — so the
      // bonus can't latch forever the way it did before T-250.
      this.requestReaction(world, ctx.attackerId, "stagger_heavy", ctx.serverTick);
      world.set(ctx.targetId, CounterReady, {});
      const counterTicks = combatCfg.counterWindowTicks;
      upsertResourceKey(world, ctx.targetId, "counter_window", counterTicks, counterTicks);
      events.publish(TileEvents.DamageDealt, {
        targetId: ctx.targetId,
        sourceId: ctx.attackerId,
        amount: 0,
        blocked: true,
        hitX: ctx.hitX,
        hitY: ctx.hitY,
        hitZ: ctx.hitZ,
      });
      return;
    }

    // Front/back dot product (T-198/T-299): direction from the TARGET TO THE
    // ATTACKER projected on the target's own forward axis. dot >= 0 means the
    // attacker is in front of the target; dot < 0 means the hit came from
    // behind. Computed once here and reused both for the rear damage
    // multiplier below AND the hit_front/hit_back reaction pick further down
    // (previously duplicated at the reaction-pick site).
    const targetToAttackerX = ctx.attackerX - ctx.targetX;
    const targetToAttackerY = ctx.attackerY - ctx.targetY;
    const targetForwardX = Math.cos(ctx.targetSnapshotFacing);
    const targetForwardY = Math.sin(ctx.targetSnapshotFacing);
    const frontBackDot = targetToAttackerX * targetForwardX + targetToAttackerY * targetForwardY;

    // ── Damage multipliers ────────────────────────────────────────────────────
    let damageMult = 1.0;

    if (world.has(ctx.attackerId, CounterReady)) {
      damageMult = combatCfg.counterDamageMultiplier;
      world.remove(ctx.attackerId, CounterReady);
    }

    // Attacker-side damage modifiers (e.g. a damage_boost buff child) —
    // the Status/Modifier query, not bespoke hooks (T-239).
    damageMult *= effective(
      this.modifierSources,
      { world, content: this.content, entityId: ctx.attackerId },
      "damageDealt",
      1,
    );

    // ── Armor reduction (the `equipment` ModifierSource sums it live) ──────────
    const armorReduction = effective(
      this.modifierSources,
      { world, content: this.content, entityId: ctx.targetId },
      "armorReduction",
      0,
    );

    const blockMult = isBlocking ? combatCfg.blockDamageMultiplier : 1.0;
    // T-198: part multipliers — attacker.{tip|mid|haft} × victim.{partId}.
    // Unknown parts fall through to 1.0 so a newly-authored hitbox part
    // doesn't silently break combat tuning.
    const pm = combatCfg.partMultipliers;
    const attackerPartMult = pm.attacker[ctx.attackerPart] ?? 1.0;
    const victimPartMult   = pm.victim[ctx.bodyPart] ?? 1.0;
    // Global rear multiplier (T-299): a hit landing from behind the target's
    // facing deals more damage. Applies to every actor equally — a Shield-
    // Knight's frontal block arc already gives it a flanking weakness for
    // free (an attack outside blockArcHalfRadians disables isBlocking), so
    // this needs no per-archetype override.
    const rearMult = frontBackDot < 0 ? pm.rearMultiplier : 1.0;
    const baseDamage = ctx.weaponStats.damage ?? 0;
    let damage = baseDamage * damageMult * blockMult * attackerPartMult * victimPartMult * rearMult * (1 - armorReduction);

    // ── Target-side mitigation (e.g. a shield buff child) ─────────────────────
    // A `damageTaken` mul ≤ 1 from the Status/Modifier query (T-239).
    damage *= effective(
      this.modifierSources,
      { world, content: this.content, entityId: ctx.targetId },
      "damageTaken",
      1,
    );

    // ── Apply damage ──────────────────────────────────────────────────────────
    // Composing mutate (T-249): two same-tick hits both subtract. The local
    // newHealth (vs committed state) still drives this hit's own death
    // request / reaction decisions; a kill only visible in the composed
    // total is caught by DeathSystem's health≤0 sweep next tick.
    //
    // T-327: a TrainingDummy is floored at 1, never 0 — DeathSystem's
    // composed-lethal sweep queries committed `Health.current <= 0`, so the
    // "never dies" guarantee has to be enforced HERE, at the write, not by
    // skipping the death request below (the sweep would still catch it next
    // tick). TrainingDummySystem separately heals it back to full once
    // healDelayTicks pass with no further hit.
    const floor = world.has(ctx.targetId, TrainingDummy) ? 1 : 0;
    const newHealth = Math.max(floor, health.current - damage);
    const dmg = damage;
    world.mutate(ctx.targetId, Health, (h) => ({ ...h, current: Math.max(floor, h.current - dmg) }));

    // ── Severe-hit injury roll (T-008) ────────────────────────────────────────
    // A single hit over the threshold can inflict a persistent injury whose
    // debuff applies via the `injury` ModifierSource until treated (T-009).
    // Re-injuring the same type deepens it (severity++).
    if (damage >= combatCfg.injuryThreshold && Math.random() < combatCfg.injuryChance) {
      // Only combat-eligible injuries roll here — spawn/scripted-only states
      // (the T-079 `displaced` heir debuff) are excluded so a hit can't inflict them.
      const injuryDefs = this.content.getGameConfig().injuries;
      const types = Object.keys(injuryDefs).filter((id) => injuryDefs[id].combatEligible !== false);
      if (types.length > 0) {
        const typeId = types[Math.floor(Math.random() * types.length)];
        const current = world.get(ctx.targetId, Injury)?.injuries ?? [];
        const has = current.find((i) => i.typeId === typeId);
        const injuries = has
          ? current.map((i) => i.typeId === typeId ? { ...i, severity: Math.min(255, i.severity + 1) } : i)
          : [...current, { typeId, severity: 1 }];
        world.set(ctx.targetId, Injury, { injuries });
        log.info("injury: target=%s type=%s severity=%d (dmg=%.1f)",
          ctx.targetId, typeId, injuries.find((i) => i.typeId === typeId)!.severity, damage);
      }
    }

    events.publish(TileEvents.DamageDealt, {
      targetId: ctx.targetId,
      sourceId: ctx.attackerId,
      amount: damage,
      blocked: isBlocking,
      hitX: ctx.hitX,
      hitY: ctx.hitY,
      hitZ: ctx.hitZ,
    });

    // ── The reified hit fact (T-259) ─────────────────────────────────────────
    // Published after resolution (damage + blocked known) for the
    // TriggerSystem's `hit_landed` collectors — content-defined on-hit
    // triggers (weapon procs etc.) fire off it next tick. Server-side only.
    events.publish(TileEvents.HitLanded, {
      attackerId: ctx.attackerId,
      targetId: ctx.targetId,
      bodyPart: ctx.bodyPart,
      damage,
      blocked: isBlocking,
    });

    // ── Hit-reaction request (T-228) ─────────────────────────────────────────
    // Post a one-shot PendingReaction; ReactionIntentResolver feeds it into
    // the dispatcher's `reaction` slot next tick (interrupt priority lets a
    // stagger preempt a flinch). Blocked hits don't react.
    if (!isBlocking && damage > 0) {
      // Reuses frontBackDot computed above (T-299) — dot >= 0 means the
      // attacker is in front of the target.
      this.requestReaction(
        world, ctx.targetId,
        frontBackDot >= 0 ? "hit_front" : "hit_back",
        ctx.serverTick,
      );

      // ── Poise / stagger (T-197, poise is a Resource since T-238d) ──────────
      // Damage reduces `Resource.values.poise`. When it breaks, the breaking
      // hit's overshoot (damage past remaining poise) picks the tier: small
      // overshoot → stagger.light, large → stagger.heavy. Poise resets to max
      // and ResourceSystem owns the regen back up. (The old 0.5s
      // regen-disabled window is gone: with break resetting to max it only
      // bit on a re-hit within the window — an accepted retune; the dead
      // game_config key is removed in T-238g.)
      const res = world.get(ctx.targetId, Resource);
      const poise = res?.values.poise;
      if (res && poise) {
        const next = poise.value - damage;
        if (next <= 0) {
          const overshoot = -next;
          const poiseCfg = this.content.getGameConfig().combat.poise;
          const heavy = overshoot >= poiseCfg.heavyTierDamageOvershoot;
          // Break: reset to max (absolute, composing-merge — sibling keys
          // and later same-tick contributions stay intact, T-249).
          upsertResourceKey(world, ctx.targetId, "poise", poise.max, poise.max);
          // Outranks the hit_front/back request above via the priority
          // merge — stagger supersedes the flinch, here AND across other
          // same-tick onHit calls against this target.
          this.requestReaction(
            world, ctx.targetId,
            heavy ? "stagger_heavy" : "stagger_light",
            ctx.serverTick,
          );
        } else {
          // Composing subtract: two same-tick hits both chip poise (each
          // hit's break decision still reads committed state — a break only
          // visible in the composed total breaks on the next hit).
          adjustResourceKey(world, ctx.targetId, "poise", -damage);
        }
      }
    }

    // ── Death / knockback ─────────────────────────────────────────────────────
    if (newHealth <= 0) {
      this.deaths.request({ entityId: ctx.targetId, killerId: ctx.attackerId, cause: "damage" });
    } else if (!isBlocking) {
      // Knockback emphasis (T-292): scale the impulse by how hard this hit
      // landed relative to a reference damage value, so a heavy swing shoves
      // noticeably harder than a light poke instead of every hit pushing
      // the same fixed amount.
      const kb = combatCfg.knockback;
      const knockbackMult = Math.max(kb.minMult, Math.min(kb.maxMult, damage / kb.referenceDamage));
      const dx = ctx.targetX - ctx.attackerX;
      const dy = ctx.targetY - ctx.attackerY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const kx = (dx / dist) * combatCfg.knockbackImpulseXY * knockbackMult;
      const ky = (dy / dist) * combatCfg.knockbackImpulseXY * knockbackMult;
      const kz = combatCfg.knockbackImpulseZ * knockbackMult;
      // Composing mutate (T-249): two same-tick hits both shove — each
      // impulse adds onto whatever earlier ops (physics' write, a prior
      // hit's impulse) left behind, instead of a committed-read + set
      // dropping every impulse but the last.
      if (world.has(ctx.targetId, Velocity)) {
        world.mutate(ctx.targetId, Velocity, (v) => ({
          x: v.x + kx,
          y: v.y + ky,
          z: v.z + kz,
        }));
      }
    }
  }
}

function angleDiff(a: number, b: number): number {
  const raw = ((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(raw);
}

