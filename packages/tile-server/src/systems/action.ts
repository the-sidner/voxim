/**
 * ActionSystem — Layer 1 of the hit architecture.
 *
 * Owns everything up to and including confirming that a blade capsule intersected
 * a target's Hitbox. What happens as a result of that hit is entirely delegated to
 * the HitHandler registry — ActionSystem has no knowledge of health, resources,
 * blueprints, or any other game concept.
 *
 * Adding a new hittable entity type:
 *   1. Give the entity a Hitbox component at spawn.
 *   2. Register a HitHandler in server.ts that checks for the relevant component.
 *   ActionSystem never changes.
 *
 * Single code path for players and NPCs. No isNpc branches.
 */
import type { World } from "@voxim/engine";
import { ACTION_USE_SKILL, hasAction, TileEvents } from "@voxim/protocol";
import type { ContentStore, DerivedItemStats } from "@voxim/content";
import { evaluateSwingPath, deriveTip, localToWorld, segSegDistSq, segSegContactPoint } from "@voxim/content";
import type { Vec3 } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, Facing, Velocity, InputState, Stamina, SkillInProgress, CombatState } from "../components/game.ts";
import type { SkillInProgressData, HitRecord } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { Hitbox } from "../components/hitbox.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import type { StateHistoryBuffer } from "../state_history.ts";
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
    private readonly handlers: HitHandler[],
  ) {}

  prepare(serverTick: number, _ctx: TickContext): void {
    this.serverTick = serverTick;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    const gameCfg = this.content.getGameConfig();
    const combatCfg = gameCfg.combat;

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

      const newHitEntities = sip.phase === "active"
        ? this.resolveHits(world, events, entityId, sip, unarmed)
        : sip.hitEntities;

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

  private resolveHits(
    world: World,
    events: EventEmitter,
    entityId: string,
    sip: SkillInProgressData,
    unarmed: DerivedItemStats,
  ): HitRecord[] {
    const action = this.content.getWeaponAction(sip.weaponActionId);
    if (!action) return sip.hitEntities;

    const equipment = world.get(entityId, Equipment);
    const weapon = equipment?.weapon ?? null;
    const weaponStats = weapon ? this.content.deriveItemStats(weapon.itemType, weapon.parts) : unarmed;
    const bladeRadius = weaponStats.bladeRadius ?? action.swingPath.defaultBladeRadius;
    const bladeLength = weaponStats.bladeLength ?? action.swingPath.defaultBladeLength;

    const totalTicks = action.windupTicks + action.activeTicks + action.winddownTicks;
    const globalTickPrev = action.windupTicks + sip.ticksInPhase - 1;
    const globalTickCurr = action.windupTicks + sip.ticksInPhase;
    const tPrev = Math.max(0, globalTickPrev / totalTicks);
    const tCurr = globalTickCurr / totalTicks;

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

    const attackerSnap = snap.entities.find((e) => e.entityId === entityId);
    const ax = attackerSnap?.x ?? (world.get(entityId, Position)?.x ?? 0);
    const ay = attackerSnap?.y ?? (world.get(entityId, Position)?.y ?? 0);
    const az = attackerSnap?.z ?? (world.get(entityId, Position)?.z ?? 0);
    const inputState = world.get(entityId, InputState);
    const attackFacing = attackerSnap?.facing ?? inputState?.facing ?? 0;

    const attackerOrigin: Vec3 = { x: ax, y: ay, z: az };

    const posePrev = evaluateSwingPath(action.swingPath.keyframes, tPrev);
    const poseCurr = evaluateSwingPath(action.swingPath.keyframes, tCurr);

    const tipLocalPrev = deriveTip(posePrev.hilt, posePrev.bladeDir, bladeLength);
    const tipLocalCurr = deriveTip(poseCurr.hilt, poseCurr.bladeDir, bladeLength);

    const hiltPrev = localToWorld(posePrev.hilt.fwd, posePrev.hilt.right, posePrev.hilt.up, attackerOrigin, attackFacing);
    const tipPrev  = localToWorld(tipLocalPrev.fwd,  tipLocalPrev.right,  tipLocalPrev.up,  attackerOrigin, attackFacing);
    const hiltCurr = localToWorld(poseCurr.hilt.fwd, poseCurr.hilt.right, poseCurr.hilt.up, attackerOrigin, attackFacing);
    const tipCurr  = localToWorld(tipLocalCurr.fwd,  tipLocalCurr.right,  tipLocalCurr.up,  attackerOrigin, attackFacing);

    log.info("resolve: entity=%s pos=(%.1f,%.1f) facing=%.2f t=[%.3f,%.3f] candidates=%d tipFwd=(%.2f→%.2f)",
      entityId, ax, ay, attackFacing, tPrev, tCurr, snap.entities.length,
      tipLocalPrev.fwd, tipLocalCurr.fwd);

    const newHitEntities = [...sip.hitEntities];

    for (const target of snap.entities) {
      if (target.entityId === entityId) continue;
      if (!world.isAlive(target.entityId)) continue;
      if (newHitEntities.some((h) => h.entityId === target.entityId)) continue;

      const bdx = target.x - ax, bdy = target.y - ay, bdz = (target.z ?? 0) - az;
      const broadDist = Math.sqrt(bdx * bdx + bdy * bdy + bdz * bdz);
      if (broadDist > MAX_BLADE_REACH + 0.5) continue;

      // Gate: entity must have a Hitbox component with at least one part
      const hitbox = world.get(target.entityId, Hitbox);
      if (!hitbox || hitbox.parts.length === 0) continue;

      const targetPos: Vec3 = { x: target.x, y: target.y, z: target.z ?? 0 };
      const targetFacing = target.facing ?? 0;

      let hitBodyPart = "";
      let hitContact: Vec3 = targetPos;
      for (const part of hitbox.parts) {
        const partFrom = localToWorld(part.fromFwd, part.fromRight, part.fromUp, targetPos, targetFacing);
        const partTo   = localToWorld(part.toFwd,   part.toRight,   part.toUp,   targetPos, targetFacing);

        const combinedRadiusSq = (bladeRadius + part.radius) ** 2;
        const distSqPrev = segSegDistSq(hiltPrev, tipPrev, partFrom, partTo);
        const distSqCurr = segSegDistSq(hiltCurr, tipCurr, partFrom, partTo);

        if (distSqPrev <= combinedRadiusSq || distSqCurr <= combinedRadiusSq) {
          hitBodyPart = part.id;
          const blade1 = distSqCurr <= combinedRadiusSq ? hiltCurr : hiltPrev;
          const blade2 = distSqCurr <= combinedRadiusSq ? tipCurr  : tipPrev;
          hitContact = segSegContactPoint(blade1, blade2, partFrom, partTo);
          break;
        }
      }

      if (!hitBodyPart) {
        const dists = hitbox.parts.map((p) => {
          const pf = localToWorld(p.fromFwd, p.fromRight, p.fromUp, targetPos, targetFacing);
          const pt = localToWorld(p.toFwd, p.toRight, p.toUp, targetPos, targetFacing);
          const d = Math.min(
            segSegDistSq(hiltCurr, tipCurr, pf, pt),
            segSegDistSq(hiltPrev, tipPrev, pf, pt),
          );
          return `${p.id}:${Math.sqrt(d).toFixed(2)}(r=${(bladeRadius + p.radius).toFixed(2)})`;
        });
        log.info("miss: attacker=%s target=%s dist=%.2f parts=[%s]",
          entityId, target.entityId, broadDist, dists.join(","));
        continue;
      }

      newHitEntities.push({ entityId: target.entityId, bodyPart: hitBodyPart });

      events.publish(TileEvents.HitSpark, { x: hitContact.x, y: hitContact.y, z: hitContact.z });

      const ctx: HitContext = {
        attackerId: entityId,
        targetId: target.entityId,
        weaponStats,
        bodyPart: hitBodyPart,
        targetSnapshotFacing: target.facing ?? 0,
        targetSnapshotActions: target.actions,
        attackerX: ax,
        attackerY: ay,
        targetX: target.x,
        targetY: target.y,
        hitX: hitContact.x,
        hitY: hitContact.y,
        hitZ: hitContact.z,
      };
      for (const handler of this.handlers) {
        handler.onHit(world, events, ctx);
      }
    }

    return newHitEntities;
  }
}
