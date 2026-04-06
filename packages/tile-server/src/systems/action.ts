/**
 * ActionSystem — Layer 1 of the skill-based combat architecture.
 *
 * Handles the physical swing: windup → active → winddown phases driven by
 * weapon_actions.json timing.  No Lore knowledge here — when a hit connects
 * and pendingSkillVerb is set, ActionSystem delegates to SkillSystem.resolve()
 * for the Lore layer.
 *
 * Single code path for players and NPCs.  No isNpc branches.
 */
import type { World } from "@voxim/engine";
import { ACTION_USE_SKILL, ACTION_BLOCK, hasAction, TileEvents } from "@voxim/protocol";
import type { ContentStore, DerivedItemStats } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, Velocity, Facing, InputState, Health, Stamina, SkillInProgress, CombatState } from "../components/game.ts";
import type { SkillInProgressData } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { ActiveEffects, LoreLoadout } from "../components/lore_loadout.ts";
import type { StateHistoryBuffer } from "../state_history.ts";
import { SkillSystem } from "./skill.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ActionSystem");

function angleDiff(a: number, b: number): number {
  const raw = ((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(raw);
}

export class ActionSystem implements System {
  private serverTick = 0;

  constructor(
    private readonly stateHistory: StateHistoryBuffer,
    private readonly tickRateHz: number,
    private readonly content: ContentStore,
    private readonly skillSystem: SkillSystem,
  ) {}

  prepare(serverTick: number, _ctx: TickContext): void {
    this.serverTick = serverTick;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    const gameCfg = this.content.getGameConfig();
    const combatCfg = gameCfg.combat;
    const dodgeCfg = gameCfg.dodge;

    const unarmedActionId = combatCfg.unarmedWeaponAction ?? "unarmed";
    const unarmed: DerivedItemStats = {
      weight: combatCfg.unarmed.weight,
      damage: combatCfg.unarmed.damage,
      attackRange: combatCfg.unarmed.attackRange,
      attackArcHalf: combatCfg.unarmed.attackArcHalf,
      staminaCostPerSwing: combatCfg.unarmed.staminaCostPerSwing,
    };

    // ── 1. Initiate new actions ───────────────────────────────────────────────
    for (const { entityId, inputState } of world.query(InputState)) {
      if (!hasAction(inputState.actions, ACTION_USE_SKILL)) continue;
      const existing = world.get(entityId, SkillInProgress);
      if (existing) continue;

      const combatState = world.get(entityId, CombatState);
      if (combatState && combatState.staggerTicksRemaining > 0) continue;

      const equipment = world.get(entityId, Equipment);
      const weapon = equipment?.weapon ?? null;
      const weaponStats = weapon ? this.content.deriveItemStats(weapon.itemType, weapon.parts) : unarmed;

      const staminaCost = weaponStats.staminaCostPerSwing ?? unarmed.staminaCostPerSwing!;
      const stamina = world.get(entityId, Stamina);
      if (stamina) {
        const next = Math.max(0, stamina.current - staminaCost);
        world.set(entityId, Stamina, { ...stamina, current: next, exhausted: next <= 0 });
      }

      // Find which skill slot (if any) has verb "strike" to fire on connect
      const loreLoadout = world.get(entityId, LoreLoadout);
      const strikeSlot = loreLoadout?.skills.findIndex((s) => s?.verb === "strike") ?? -1;

      const weaponActionId = weaponStats.weaponAction ?? unarmedActionId;
      world.set(entityId, SkillInProgress, {
        weaponActionId,
        phase: "windup",
        ticksInPhase: 0,
        hitEntities: [],
        inputTimestamp: inputState.timestamp,
        pendingSkillVerb: strikeSlot >= 0 ? `strike:${strikeSlot}` : "",
      });

      log.debug("action initiated: entity=%s weaponAction=%s strikeSlot=%d", entityId, weaponActionId, strikeSlot);
    }

    // ── 2. Advance phase + resolve hits ──────────────────────────────────────
    for (const { entityId, skillInProgress: sip } of world.query(SkillInProgress)) {
      const action = this.content.getWeaponAction(sip.weaponActionId);
      if (!action) {
        world.remove(entityId, SkillInProgress);
        continue;
      }

      // Hit resolution happens during active phase before advancing ticks
      if (sip.phase === "active") {
        this.resolveHits(world, events, entityId, sip, combatCfg, dodgeCfg, unarmed, action);
      }

      // Advance tick counter and transition phases
      const nextTicks = sip.ticksInPhase + 1;
      let next: SkillInProgressData = { ...sip, ticksInPhase: nextTicks };

      if (sip.phase === "windup" && nextTicks >= action.windupTicks) {
        next = { ...next, phase: "active", ticksInPhase: 0 };
        log.debug("action active: entity=%s weapon=%s", entityId, sip.weaponActionId);
      } else if (sip.phase === "active" && nextTicks >= action.activeTicks) {
        next = { ...next, phase: "winddown", ticksInPhase: 0 };
      } else if (sip.phase === "winddown" && nextTicks >= action.winddownTicks) {
        world.remove(entityId, SkillInProgress);
        continue;
      }

      world.set(entityId, SkillInProgress, next);
    }

    const _unused = [Facing, Velocity];
    void _unused;
  }

  private resolveHits(
    world: World,
    events: EventEmitter,
    entityId: string,
    sip: SkillInProgressData,
    combatCfg: ReturnType<ContentStore["getGameConfig"]>["combat"],
    dodgeCfg: ReturnType<ContentStore["getGameConfig"]>["dodge"],
    unarmed: DerivedItemStats,
    action: NonNullable<ReturnType<ContentStore["getWeaponAction"]>>,
  ): void {
    const equipment = world.get(entityId, Equipment);
    const weapon = equipment?.weapon ?? null;
    const weaponStats = weapon ? this.content.deriveItemStats(weapon.itemType, weapon.parts) : unarmed;
    const baseDamage = weaponStats.damage ?? unarmed.damage!;

    const attackRange = action.hitbox.range;
    const arcHalf = action.hitbox.arcHalf;

    let rewindTick: number;
    // Only rewind for real client inputs (timestamp > 0). NPCs use current tick.
    if (sip.ticksInPhase === 0 && sip.inputTimestamp > 0) {
      const rttMs = Math.max(0, Date.now() - sip.inputTimestamp);
      const rttTicks = Math.round(rttMs / (1000 / this.tickRateHz));
      rewindTick = Math.max(0, this.serverTick - rttTicks);
    } else {
      rewindTick = this.serverTick;
    }
    const snap = this.stateHistory.getAt(rewindTick);
    if (!snap) return;

    const attackerSnap = snap.entities.find((e) => e.entityId === entityId);
    const ax = attackerSnap?.x ?? (world.get(entityId, Position)?.x ?? 0);
    const ay = attackerSnap?.y ?? (world.get(entityId, Position)?.y ?? 0);
    const inputState = world.get(entityId, InputState);
    const attackFacing = attackerSnap?.facing ?? inputState?.facing ?? 0;

    const attackerCombatState = world.get(entityId, CombatState);
    let damageMult = 1.0;
    if (attackerCombatState?.counterReady) {
      damageMult = combatCfg.counterDamageMultiplier;
      world.set(entityId, CombatState, { ...attackerCombatState, counterReady: false });
    }

    const attackerEffects = world.get(entityId, ActiveEffects);
    if (attackerEffects) {
      const boostIdx = attackerEffects.effects.findIndex((e) => e.effectStat === "damage_boost");
      if (boostIdx !== -1) {
        damageMult *= 1 + attackerEffects.effects[boostIdx].magnitude;
        const updated = attackerEffects.effects.map((e, i) => i === boostIdx ? { ...e, ticksRemaining: 0 } : e);
        world.set(entityId, ActiveEffects, { effects: updated });
      }
    }

    let hitCount = 0;
    const newHitEntities = [...sip.hitEntities];

    for (const target of snap.entities) {
      if (target.entityId === entityId) continue;
      if (!world.isAlive(target.entityId)) continue;
      if (newHitEntities.includes(target.entityId)) continue;

      const dx = target.x - ax;
      const dy = target.y - ay;
      const distSq = dx * dx + dy * dy;
      if (distSq > attackRange * attackRange) continue;

      const dist = Math.sqrt(distSq);
      const toTargetAngle = Math.atan2(dy, dx);
      if (angleDiff(toTargetAngle, attackFacing) > arcHalf) continue;

      const targetCombatState = world.get(target.entityId, CombatState);
      if (targetCombatState && targetCombatState.iFrameTicksRemaining > 0) continue;

      const incomingAngle = Math.atan2(target.y - ay, target.x - ax);
      const defenderStamina = world.get(target.entityId, Stamina);
      const stamGated = defenderStamina?.exhausted ?? false;
      const isBlocking = !stamGated &&
        hasAction(target.actions, ACTION_BLOCK) &&
        angleDiff(incomingAngle, target.facing) <= combatCfg.blockArcHalfRadians;

      const isParry = isBlocking &&
        targetCombatState !== null &&
        targetCombatState.blockHeldTicks < dodgeCfg.parryWindowTicks;

      if (isParry) {
        world.set(entityId, CombatState, {
          ...(attackerCombatState ?? defaultCombatState()),
          staggerTicksRemaining: dodgeCfg.staggerTicks,
        });
        world.set(target.entityId, CombatState, { ...targetCombatState, counterReady: true });
        events.publish(TileEvents.DamageDealt, { targetId: target.entityId, sourceId: entityId, amount: 0, blocked: true });
        newHitEntities.push(target.entityId);
        continue;
      }

      const defenderEquipment = world.get(target.entityId, Equipment);
      const defenderArmor = defenderEquipment?.armor ?? null;
      const armorStats = defenderArmor ? this.content.deriveItemStats(defenderArmor.itemType, defenderArmor.parts) : null;
      const armorReduction = armorStats?.armorReduction ?? 0;
      const blockMult = isBlocking ? combatCfg.blockDamageMultiplier : 1.0;

      let damage = baseDamage * damageMult * blockMult * (1 - armorReduction);

      const targetEffects = world.get(target.entityId, ActiveEffects);
      if (targetEffects) {
        const shieldIdx = targetEffects.effects.findIndex((e) => e.effectStat === "shield");
        if (shieldIdx !== -1) {
          const shield = targetEffects.effects[shieldIdx];
          const absorbed = Math.min(shield.magnitude, damage);
          damage -= absorbed;
          const remaining = shield.magnitude - absorbed;
          const updated = remaining > 0
            ? targetEffects.effects.map((e, i) => i === shieldIdx ? { ...e, magnitude: remaining } : e)
            : targetEffects.effects.map((e, i) => i === shieldIdx ? { ...e, ticksRemaining: 0 } : e);
          world.set(target.entityId, ActiveEffects, { effects: updated });
        }
      }

      const health = world.get(target.entityId, Health);
      if (!health) continue;

      const newHealth = Math.max(0, health.current - damage);
      world.set(target.entityId, Health, { ...health, current: newHealth });
      log.info("hit: attacker=%s target=%s dmg=%.1f blocked=%s hp %.1f→%.1f",
        entityId, target.entityId, damage, isBlocking, health.current, newHealth);
      hitCount++;
      newHitEntities.push(target.entityId);

      events.publish(TileEvents.DamageDealt, { targetId: target.entityId, sourceId: entityId, amount: damage, blocked: isBlocking });

      // Fire "strike" skill on connect
      if (sip.pendingSkillVerb.startsWith("strike:")) {
        const slot = parseInt(sip.pendingSkillVerb.slice(7), 10);
        this.skillSystem.resolve(world, events, entityId, slot, target.entityId);
      }

      if (newHealth <= 0) {
        world.destroy(target.entityId);
        events.publish(TileEvents.EntityDied, { entityId: target.entityId, killerId: entityId });
      } else if (!isBlocking) {
        const kx = dist > 0 ? (dx / dist) * combatCfg.knockbackImpulseXY : combatCfg.knockbackImpulseXY;
        const ky = dist > 0 ? (dy / dist) * combatCfg.knockbackImpulseXY : 0;
        const vel = world.get(target.entityId, Velocity);
        if (vel) world.set(target.entityId, Velocity, { x: vel.x + kx, y: vel.y + ky, z: vel.z + combatCfg.knockbackImpulseZ });
      }
    }

    if (hitCount === 0 && sip.ticksInPhase === 0) {
      log.debug("first active tick, no hits yet: entity=%s", entityId);
    }

    // Persist updated hit list
    if (newHitEntities.length > sip.hitEntities.length) {
      const current = world.get(entityId, SkillInProgress);
      if (current) {
        world.set(entityId, SkillInProgress, { ...current, hitEntities: newHitEntities });
      }
    }
  }
}

function defaultCombatState() {
  return { blockHeldTicks: 0, staggerTicksRemaining: 0, counterReady: false, iFrameTicksRemaining: 0, dodgeCooldownTicks: 0 };
}
