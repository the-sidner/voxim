/**
 * ActionSystem — Layer 1 of the skill-based combat architecture.
 *
 * Handles the physical swing: windup → active → winddown phases driven by
 * weapon_actions.json timing.  Hit detection uses swept capsule-vs-capsule
 * intersection: the weapon blade traces a path defined by SwingKeyframe data
 * through entity-local space, and each body part of each candidate target is
 * tested against the blade capsule for that tick's segment.
 *
 * No Lore knowledge here — when a hit connects and pendingSkillVerb is set,
 * ActionSystem delegates to SkillSystem.resolve() for the Lore layer.
 *
 * Single code path for players and NPCs.  No isNpc branches.
 */
import type { World } from "@voxim/engine";
import { ACTION_USE_SKILL, ACTION_BLOCK, hasAction, TileEvents } from "@voxim/protocol";
import type { ContentStore, DerivedItemStats } from "@voxim/content";
import { evaluateSwingPath, deriveTip, localToWorld, segSegDistSq } from "@voxim/content";
import type { Vec3 } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, Velocity, Facing, InputState, Health, Stamina, SkillInProgress, CombatState, ModelRef } from "../components/game.ts";
import type { SkillInProgressData, HitRecord } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { ActiveEffects, LoreLoadout } from "../components/lore_loadout.ts";
import type { StateHistoryBuffer } from "../state_history.ts";
import { SkillSystem } from "./skill.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ActionSystem");

/** Conservative max reach used for broad-phase culling (world units). */
const MAX_BLADE_REACH = 3.5;

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
      // world.write (immediate) so AnimationSystem sees SkillInProgress this same tick
      // and outputs mode=attack without a 1-tick idle gap.
      world.write(entityId, SkillInProgress, {
        weaponActionId,
        phase: "windup",
        ticksInPhase: 0,
        hitEntities: [],
        inputTimestamp: inputState.timestamp,
        pendingSkillVerb: strikeSlot >= 0 ? `strike:${strikeSlot}` : "",
      });

      log.info("swing start: entity=%s weapon=%s action=%s stamina=%f", entityId, weapon?.itemType ?? "unarmed", weaponActionId, stamina?.current ?? 0);
    }

    // ── 2. Advance phase + resolve hits ──────────────────────────────────────
    for (const { entityId, skillInProgress: sip } of world.query(SkillInProgress)) {
      const action = this.content.getWeaponAction(sip.weaponActionId);
      if (!action) {
        world.remove(entityId, SkillInProgress);
        continue;
      }

      // Hit resolution happens during active phase before advancing ticks.
      // Returns the updated hitEntities list so the outer write includes it —
      // resolveHits must not write SkillInProgress itself (last-write-wins would
      // overwrite the phase-advance write below and discard the updated hit list).
      const newHitEntities = sip.phase === "active"
        ? this.resolveHits(world, events, entityId, sip, combatCfg, dodgeCfg, unarmed)
        : sip.hitEntities;

      // Advance tick counter and transition phases
      const nextTicks = sip.ticksInPhase + 1;
      let next: SkillInProgressData = { ...sip, ticksInPhase: nextTicks, hitEntities: newHitEntities };

      if (sip.phase === "windup" && nextTicks >= action.windupTicks) {
        next = { ...next, phase: "active", ticksInPhase: 0 };
        log.info("swing active: entity=%s action=%s", entityId, sip.weaponActionId);
      } else if (sip.phase === "active" && nextTicks >= action.activeTicks) {
        next = { ...next, phase: "winddown", ticksInPhase: 0 };
        log.info("swing winddown: entity=%s action=%s hits=%d", entityId, sip.weaponActionId, newHitEntities.length);
      } else if (sip.phase === "winddown" && nextTicks >= action.winddownTicks) {
        log.info("swing done: entity=%s action=%s", entityId, sip.weaponActionId);
        world.remove(entityId, SkillInProgress);
        continue;
      }

      world.set(entityId, SkillInProgress, next);
    }

    const _unused = [Facing, Velocity];
    void _unused;
  }

  /** Resolve hits for one active-phase tick. Returns the updated hitEntities list. */
  private resolveHits(
    world: World,
    events: EventEmitter,
    entityId: string,
    sip: SkillInProgressData,
    combatCfg: ReturnType<ContentStore["getGameConfig"]>["combat"],
    dodgeCfg: ReturnType<ContentStore["getGameConfig"]>["dodge"],
    unarmed: DerivedItemStats,
  ): HitRecord[] {
    const action = this.content.getWeaponAction(sip.weaponActionId);
    if (!action) return sip.hitEntities;

    const equipment = world.get(entityId, Equipment);
    const weapon = equipment?.weapon ?? null;
    const weaponStats = weapon ? this.content.deriveItemStats(weapon.itemType, weapon.parts) : unarmed;
    const baseDamage = weaponStats.damage ?? unarmed.damage!;
    const bladeRadius = weaponStats.bladeRadius ?? action.swingPath.defaultBladeRadius;
    const bladeLength = weaponStats.bladeLength ?? action.swingPath.defaultBladeLength;

    // Compute normalised t for start and end of this active tick within the full action.
    const totalTicks = action.windupTicks + action.activeTicks + action.winddownTicks;
    // ticksInPhase is 0-based within active phase; this is called before advancing.
    const globalTickPrev = action.windupTicks + sip.ticksInPhase - 1;
    const globalTickCurr = action.windupTicks + sip.ticksInPhase;
    const tPrev = Math.max(0, globalTickPrev / totalTicks);
    const tCurr = globalTickCurr / totalTicks;

    // Determine which snapshot to use for attacker + target positions (lag compensation).
    // Only rewind for real client inputs (timestamp > 0). NPCs use current tick.
    let rewindTick: number;
    if (sip.ticksInPhase === 0 && sip.inputTimestamp > 0) {
      const rttMs = Math.max(0, Date.now() - sip.inputTimestamp);
      const rttTicks = Math.round(rttMs / (1000 / this.tickRateHz));
      rewindTick = Math.max(0, this.serverTick - rttTicks);
    } else {
      rewindTick = this.serverTick;
    }
    const snap = this.stateHistory.getAt(rewindTick);
    if (!snap) {
      log.warn("resolveHits: no snapshot for rewindTick=%d serverTick=%d", rewindTick, this.serverTick);
      return sip.hitEntities;
    }

    // Attacker world position and facing.
    const attackerSnap = snap.entities.find((e) => e.entityId === entityId);
    const ax = attackerSnap?.x ?? (world.get(entityId, Position)?.x ?? 0);
    const ay = attackerSnap?.y ?? (world.get(entityId, Position)?.y ?? 0);
    const az = attackerSnap?.z ?? (world.get(entityId, Position)?.z ?? 0);
    const inputState = world.get(entityId, InputState);
    const attackFacing = attackerSnap?.facing ?? inputState?.facing ?? 0;

    const attackerOrigin: Vec3 = { x: ax, y: ay, z: az };

    // Evaluate blade capsule at tPrev and tCurr in world space.
    const posePrev = evaluateSwingPath(action.swingPath.keyframes, tPrev);
    const poseCurr = evaluateSwingPath(action.swingPath.keyframes, tCurr);

    // Derive tip from hilt + bladeDir × bladeLength
    const tipLocalPrev = deriveTip(posePrev.hilt, posePrev.bladeDir, bladeLength);
    const tipLocalCurr = deriveTip(poseCurr.hilt, poseCurr.bladeDir, bladeLength);

    const hiltPrev = localToWorld(posePrev.hilt.fwd, posePrev.hilt.right, posePrev.hilt.up, attackerOrigin, attackFacing);
    const tipPrev  = localToWorld(tipLocalPrev.fwd,  tipLocalPrev.right,  tipLocalPrev.up,  attackerOrigin, attackFacing);
    const hiltCurr = localToWorld(poseCurr.hilt.fwd, poseCurr.hilt.right, poseCurr.hilt.up, attackerOrigin, attackFacing);
    const tipCurr  = localToWorld(tipLocalCurr.fwd,  tipLocalCurr.right,  tipLocalCurr.up,  attackerOrigin, attackFacing);

    log.info("resolve: entity=%s pos=(%.1f,%.1f) facing=%.2f t=[%.3f,%.3f] candidates=%d tipFwd=(%.2f→%.2f)",
      entityId, ax, ay, attackFacing, tPrev, tCurr, snap.entities.length,
      tipLocalPrev.fwd, tipLocalCurr.fwd);

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

    const newHitEntities = [...sip.hitEntities];

    for (const target of snap.entities) {
      if (target.entityId === entityId) continue;
      if (!world.isAlive(target.entityId)) continue;
      if (newHitEntities.some((h) => h.entityId === target.entityId)) continue;

      // Broad-phase: 3D distance from attacker to target.
      const bdx = target.x - ax, bdy = target.y - ay, bdz = (target.z ?? 0) - az;
      const broadDist = Math.sqrt(bdx*bdx + bdy*bdy + bdz*bdz);
      if (broadDist > MAX_BLADE_REACH + 0.5) continue;

      const targetCombatState = world.get(target.entityId, CombatState);
      if (targetCombatState && targetCombatState.iFrameTicksRemaining > 0) continue;

      // Get model hitbox definition — skip targets with no body part data.
      const targetModelRef = world.get(target.entityId, ModelRef);
      if (!targetModelRef) continue;
      const hitboxDef = this.content.getModelHitboxDef(targetModelRef.modelId);
      if (!hitboxDef) continue;

      const targetPos: Vec3 = { x: target.x, y: target.y, z: target.z ?? 0 };
      const targetFacing = target.facing ?? 0;

      // Narrow-phase: test blade capsule against each body part capsule.
      let hitBodyPart = "";
      for (const part of hitboxDef.parts) {
        const partFrom = localToWorld(part.fromFwd, part.fromRight, part.fromUp, targetPos, targetFacing);
        const partTo   = localToWorld(part.toFwd,   part.toRight,   part.toUp,   targetPos, targetFacing);

        const combinedRadiusSq = (bladeRadius + part.radius) ** 2;

        const distSqPrev = segSegDistSq(hiltPrev, tipPrev, partFrom, partTo);
        const distSqCurr = segSegDistSq(hiltCurr, tipCurr, partFrom, partTo);

        if (distSqPrev <= combinedRadiusSq || distSqCurr <= combinedRadiusSq) {
          hitBodyPart = part.id;
          break;
        }
      }

      if (!hitBodyPart) {
        // Log narrow-phase miss for debugging — shows closest part distances
        const dists = hitboxDef.parts.map((p) => {
          const pf = localToWorld(p.fromFwd, p.fromRight, p.fromUp, targetPos, targetFacing);
          const pt = localToWorld(p.toFwd, p.toRight, p.toUp, targetPos, targetFacing);
          const d = Math.min(segSegDistSq(hiltCurr, tipCurr, pf, pt), segSegDistSq(hiltPrev, tipPrev, pf, pt));
          return `${p.id}:${Math.sqrt(d).toFixed(2)}(r=${(bladeRadius + p.radius).toFixed(2)})`;
        });
        log.info("miss: attacker=%s target=%s dist=%.2f parts=[%s]",
          entityId, target.entityId, broadDist, dists.join(","));
        continue;
      }

      // Block / parry check (2D facing comparison — unchanged from original design).
      // Use snapshot actions for lag-compensated block check.
      const incomingAngle = Math.atan2(target.y - ay, target.x - ax);
      const defenderStamina = world.get(target.entityId, Stamina);
      const stamGated = defenderStamina?.exhausted ?? false;
      const isBlocking = !stamGated &&
        hasAction(target.actions, ACTION_BLOCK) &&
        angleDiff(incomingAngle, target.facing) <= combatCfg.blockArcHalfRadians;

      const isParry = isBlocking &&
        targetCombatState !== null &&
        targetCombatState!.blockHeldTicks < dodgeCfg.parryWindowTicks;

      if (isParry) {
        world.set(entityId, CombatState, {
          ...(attackerCombatState ?? defaultCombatState()),
          staggerTicksRemaining: dodgeCfg.staggerTicks,
        });
        world.set(target.entityId, CombatState, { ...targetCombatState!, counterReady: true });
        events.publish(TileEvents.DamageDealt, { targetId: target.entityId, sourceId: entityId, amount: 0, blocked: true, bodyPart: "" });
        newHitEntities.push({ entityId: target.entityId, bodyPart: "" });
        continue;
      }

      const defenderEquipment = world.get(target.entityId, Equipment);
      const armorReduction = defenderEquipment
        ? [defenderEquipment.head, defenderEquipment.chest, defenderEquipment.legs, defenderEquipment.feet, defenderEquipment.back]
            .reduce((sum, slot) => sum + (slot ? (this.content.deriveItemStats(slot.itemType, slot.parts).armorReduction ?? 0) : 0), 0)
        : 0;
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
      log.info("hit: attacker=%s target=%s bodyPart=%s dmg=%.1f blocked=%s hp %.1f→%.1f",
        entityId, target.entityId, hitBodyPart, damage, isBlocking, health.current, newHealth);
      newHitEntities.push({ entityId: target.entityId, bodyPart: hitBodyPart });

      events.publish(TileEvents.DamageDealt, { targetId: target.entityId, sourceId: entityId, amount: damage, blocked: isBlocking, bodyPart: hitBodyPart });

      // Fire "strike" skill on connect
      if (sip.pendingSkillVerb.startsWith("strike:")) {
        const slot = parseInt(sip.pendingSkillVerb.slice(7), 10);
        this.skillSystem.resolve(world, events, entityId, slot, target.entityId);
      }

      if (newHealth <= 0) {
        world.destroy(target.entityId);
        events.publish(TileEvents.EntityDied, { entityId: target.entityId, killerId: entityId });
      } else if (!isBlocking) {
        const dist = broadDist > 0 ? broadDist : 1;
        const kx = (bdx / dist) * combatCfg.knockbackImpulseXY;
        const ky = (bdy / dist) * combatCfg.knockbackImpulseXY;
        const vel = world.get(target.entityId, Velocity);
        if (vel) world.set(target.entityId, Velocity, { x: vel.x + kx, y: vel.y + ky, z: vel.z + combatCfg.knockbackImpulseZ });
      }
    }

    return newHitEntities;
  }
}

function angleDiff(a: number, b: number): number {
  const raw = ((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(raw);
}

function defaultCombatState() {
  return { blockHeldTicks: 0, staggerTicksRemaining: 0, counterReady: false, iFrameTicksRemaining: 0, dodgeCooldownTicks: 0 };
}
