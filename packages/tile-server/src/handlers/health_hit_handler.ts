import type { World, Registry } from "@voxim/engine";
import { ACTION_BLOCK, hasAction, TileEvents } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { Health, Stamina, CombatState, SkillInProgress } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { ActiveEffects } from "../components/lore_loadout.ts";
import { Velocity } from "../components/game.ts";
import type { SkillSystem } from "../systems/skill.ts";
import type { DeathRequestPort } from "../events/death.ts";
import type { OutgoingDamageHook, IncomingDamageHook } from "../effects/damage_hook.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("HealthHitHandler");

/**
 * Handles hits on entities that have a Health component.
 *
 * Combat resolution flow:
 *   block/parry → outgoing damage hooks (attacker effects modify multiplier)
 *   → armor + block reduction → incoming damage hooks (target effects absorb /
 *   reduce) → apply HP change → skill on hit → death request or knockback.
 *
 * Per-effect damage logic (damage_boost consumption, shield absorption) lives
 * in OutgoingDamageHook / IncomingDamageHook implementations registered in
 * `effects/mod.ts`. This handler holds zero `effectStat ===` checks.
 */
export class HealthHitHandler implements HitHandler {
  constructor(
    private readonly content: ContentStore,
    private readonly skillSystem: SkillSystem,
    private readonly deaths: DeathRequestPort,
    private readonly outgoingHooks: Registry<OutgoingDamageHook>,
    private readonly incomingHooks: Registry<IncomingDamageHook>,
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

    const targetCombatState = world.get(ctx.targetId, CombatState);

    // iFrame check — target is momentarily invulnerable
    if (targetCombatState && targetCombatState.iFrameTicksRemaining > 0) return;

    // ── Block / parry ─────────────────────────────────────────────────────────
    const defenderStamina = world.get(ctx.targetId, Stamina);
    const stamGated = defenderStamina?.exhausted ?? false;
    const incomingAngle = Math.atan2(ctx.targetY - ctx.attackerY, ctx.targetX - ctx.attackerX);
    const isBlocking = !stamGated &&
      hasAction(ctx.targetSnapshotActions, ACTION_BLOCK) &&
      angleDiff(incomingAngle, ctx.targetSnapshotFacing) <= combatCfg.blockArcHalfRadians;

    const isParry = ctx.parryAllowed &&
      isBlocking &&
      targetCombatState !== null &&
      targetCombatState!.blockHeldTicks < dodgeCfg.parryWindowTicks;

    if (isParry) {
      const attackerCombatState = world.get(ctx.attackerId, CombatState);
      world.set(ctx.attackerId, CombatState, {
        ...(attackerCombatState ?? defaultCombatState()),
        staggerTicksRemaining: dodgeCfg.staggerTicks,
      });
      world.set(ctx.targetId, CombatState, { ...targetCombatState!, counterReady: true });
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
    const attackerCombatState = world.get(ctx.attackerId, CombatState);
    let damageMult = 1.0;

    if (attackerCombatState?.counterReady) {
      damageMult = combatCfg.counterDamageMultiplier;
      world.set(ctx.attackerId, CombatState, { ...attackerCombatState, counterReady: false });
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
      ? [
          defenderEquipment.head,
          defenderEquipment.chest,
          defenderEquipment.legs,
          defenderEquipment.feet,
          defenderEquipment.back,
        ].reduce(
          (sum, slot) =>
            sum +
            (slot
              ? (this.content.deriveItemStats(slot.itemType, slot.parts).armorReduction ?? 0)
              : 0),
          0,
        )
      : 0;

    const blockMult = isBlocking ? combatCfg.blockDamageMultiplier : 1.0;
    const baseDamage = ctx.weaponStats.damage ?? 0;
    let damage = baseDamage * damageMult * blockMult * (1 - armorReduction);

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

    // ── Skill on hit ("strike" verb) ──────────────────────────────────────────
    const sip = world.get(ctx.attackerId, SkillInProgress);
    if (sip?.pendingSkillVerb.startsWith("strike:")) {
      const slot = parseInt(sip.pendingSkillVerb.slice(7), 10);
      this.skillSystem.resolve(world, events, ctx.attackerId, slot, ctx.targetId);
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

function defaultCombatState() {
  return {
    blockHeldTicks: 0,
    staggerTicksRemaining: 0,
    counterReady: false,
    iFrameTicksRemaining: 0,
    dodgeCooldownTicks: 0,
  };
}
