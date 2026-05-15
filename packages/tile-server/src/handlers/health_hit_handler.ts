import type { World, Registry, EntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { Health } from "../components/game.ts";
import { staminaValue } from "../combat/helpers.ts";
import { Resource } from "../components/resource.ts";
import {
  CounterReady,
} from "../components/combat.ts";
import { Blocking, IFrame } from "../components/tags.ts";
import { PendingReaction, ActiveActions } from "../components/action.ts";
import { Equipment } from "../components/equipment.ts";
import { QualityStamped } from "../components/instance.ts";
import { ActiveEffects } from "../components/lore_loadout.ts";
import { Velocity } from "../components/game.ts";
import type { DeathRequestPort } from "../events/death.ts";
import type { OutgoingDamageHook, IncomingDamageHook } from "../effects/damage_hook.ts";
import { TickEventBuffer } from "../tick_events.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("HealthHitHandler");

/**
 * Handles hits on entities that have a Health component.
 *
 * Combat resolution flow:
 *   block/parry → outgoing damage hooks (attacker effects modify multiplier)
 *   → armor + block reduction → incoming damage hooks (target effects absorb /
 *   reduce) → apply HP change → publish StrikeLanded (if pendingSkillVerb
 *   starts with "strike:") → death request or knockback.
 *
 * Per-effect damage logic (damage_boost consumption, shield absorption) lives
 * in OutgoingDamageHook / IncomingDamageHook implementations registered in
 * `effects/mod.ts`. This handler holds zero `effectStat ===` checks and no
 * direct references to SkillSystem — strike resolution is event-driven.
 */
export class HealthHitHandler implements HitHandler {
  constructor(
    private readonly content: ContentService,
    private readonly deaths: DeathRequestPort,
    private readonly outgoingHooks: Registry<OutgoingDamageHook>,
    private readonly incomingHooks: Registry<IncomingDamageHook>,
    private readonly tickEvents: TickEventBuffer,
  ) {}

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
    const stamGated = staminaValue(world, ctx.targetId) <= 0;
    const incomingAngle = Math.atan2(ctx.targetY - ctx.attackerY, ctx.targetX - ctx.attackerX);
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
      // counter window.
      world.set(ctx.attackerId, PendingReaction, { actionId: "stagger_heavy" });
      world.set(ctx.targetId, CounterReady, {});
      events.publish(TileEvents.DamageDealt, {
        targetId: ctx.targetId,
        sourceId: ctx.attackerId,
        amount: 0,
        blocked: true,
        bodyPart: "",
      });
      return;
    }

    // ── Damage multipliers ────────────────────────────────────────────────────
    let damageMult = 1.0;

    if (world.has(ctx.attackerId, CounterReady)) {
      damageMult = combatCfg.counterDamageMultiplier;
      world.remove(ctx.attackerId, CounterReady);
    }

    // Outgoing damage hooks — attacker-side effect modifiers (e.g. damage_boost).
    const attackerEffects = world.get(ctx.attackerId, ActiveEffects);
    if (attackerEffects) {
      for (const id of this.outgoingHooks.ids()) {
        damageMult *= this.outgoingHooks.get(id).apply({
          world, attackerId: ctx.attackerId, attackerEffects, hit: ctx,
        });
      }
    }

    // ── Armor reduction ───────────────────────────────────────────────────────
    const defenderEquipment = world.get(ctx.targetId, Equipment);
    const armorReduction = defenderEquipment
      ? [defenderEquipment.head, defenderEquipment.chest, defenderEquipment.legs, defenderEquipment.feet, defenderEquipment.back]
          .reduce((sum, slot) => {
            if (!slot) return sum;
            const quality = world.get(slot.entityId as EntityId, QualityStamped)?.quality ?? 1;
            return sum + (this.content.deriveItemStats(slot.prefabId, [], quality).armorReduction ?? 0);
          }, 0)
      : 0;

    const blockMult = isBlocking ? combatCfg.blockDamageMultiplier : 1.0;
    // T-198: part multipliers — attacker.{tip|mid|haft} × victim.{partId}.
    // Unknown parts fall through to 1.0 so a newly-authored hitbox part
    // doesn't silently break combat tuning.
    const pm = combatCfg.partMultipliers;
    const attackerPartMult = pm.attacker[ctx.attackerPart] ?? 1.0;
    const victimPartMult   = pm.victim[ctx.bodyPart] ?? 1.0;
    const baseDamage = ctx.weaponStats.damage ?? 0;
    let damage = baseDamage * damageMult * blockMult * attackerPartMult * victimPartMult * (1 - armorReduction);

    // ── Incoming damage hooks (shield absorption, etc.) ───────────────────────
    const targetEffects = world.get(ctx.targetId, ActiveEffects);
    if (targetEffects) {
      for (const id of this.incomingHooks.ids()) {
        damage = this.incomingHooks.get(id).apply({
          world, targetId: ctx.targetId, targetEffects, incomingDamage: damage, hit: ctx,
        });
      }
    }

    // ── Apply damage ──────────────────────────────────────────────────────────
    const newHealth = Math.max(0, health.current - damage);
    world.set(ctx.targetId, Health, { ...health, current: newHealth });

    events.publish(TileEvents.DamageDealt, {
      targetId: ctx.targetId,
      sourceId: ctx.attackerId,
      amount: damage,
      blocked: isBlocking,
      bodyPart: ctx.bodyPart,
      hitX: ctx.hitX,
      hitY: ctx.hitY,
      hitZ: ctx.hitZ,
    });

    // ── Hit-reaction request (T-228) ─────────────────────────────────────────
    // Post a one-shot PendingReaction; ReactionIntentResolver feeds it into
    // the dispatcher's `reaction` slot next tick (interrupt priority lets a
    // stagger preempt a flinch). Blocked hits don't react.
    if (!isBlocking && damage > 0) {
      // Direction from the TARGET TO THE ATTACKER. dot > 0 with target's
      // forward axis means the attacker is in the half-space the target is
      // looking at = hit came from the front.
      const targetToAttackerX = ctx.attackerX - ctx.targetX;
      const targetToAttackerY = ctx.attackerY - ctx.targetY;
      const targetForwardX = Math.cos(ctx.targetSnapshotFacing);
      const targetForwardY = Math.sin(ctx.targetSnapshotFacing);
      const dot = targetToAttackerX * targetForwardX + targetToAttackerY * targetForwardY;
      world.set(ctx.targetId, PendingReaction, {
        actionId: dot >= 0 ? "hit_front" : "hit_back",
      });

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
          world.set(ctx.targetId, Resource, {
            values: { ...res.values, poise: { value: poise.max, max: poise.max } },
          });
          // Overwrites the hit_front/back request set above — stagger
          // supersedes the flinch (and the dispatcher's interrupt
          // priority would anyway).
          world.set(ctx.targetId, PendingReaction, {
            actionId: heavy ? "stagger_heavy" : "stagger_light",
          });
        } else {
          world.set(ctx.targetId, Resource, {
            values: { ...res.values, poise: { value: next, max: poise.max } },
          });
        }
      }
    }

    // ── Skill on hit ("strike" verb) ──────────────────────────────────────────
    // The verb is derived by the weapon_trace resolver from the attacker's
    // LoreLoadout and carried on ctx.skillVerb (T-227 — replaces reading the
    // retired SwingContext). Publish-only: SkillSystem subscribes to
    // StrikeLanded on the real bus and applies stamina / cooldown / effect
    // via world.set during the post-changeset flush.
    if (ctx.skillVerb?.startsWith("strike:")) {
      const slot = parseInt(ctx.skillVerb.slice(7), 10);
      events.publish(TileEvents.StrikeLanded, {
        casterId: ctx.attackerId,
        slot,
        targetId: ctx.targetId,
      });
    }

    // ── Death / knockback ─────────────────────────────────────────────────────
    if (newHealth <= 0) {
      this.deaths.request({ entityId: ctx.targetId, killerId: ctx.attackerId, cause: "damage" });
    } else if (!isBlocking) {
      const dx = ctx.targetX - ctx.attackerX;
      const dy = ctx.targetY - ctx.attackerY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const kx = (dx / dist) * combatCfg.knockbackImpulseXY;
      const ky = (dy / dist) * combatCfg.knockbackImpulseXY;
      const vel = world.get(ctx.targetId, Velocity);
      if (vel) {
        world.set(ctx.targetId, Velocity, {
          x: vel.x + kx,
          y: vel.y + ky,
          z: vel.z + combatCfg.knockbackImpulseZ,
        });
      }
    }
  }
}

function angleDiff(a: number, b: number): number {
  const raw = ((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(raw);
}

