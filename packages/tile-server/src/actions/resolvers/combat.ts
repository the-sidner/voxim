/**
 * weapon_trace + projectile_spawn effect resolvers (T-227).
 *
 * Structural lift of `ActionSystem.resolveHits` / `spawnProjectile` /
 * `computeBladeWorld` into the action-runtime pattern. The swing FSM is now
 * the dispatcher's phases (windup/active/winddown on the swing ActionDef);
 * these resolvers are the active-phase payload:
 *
 *   weapon_trace      — fires on active:enter and every active:tick. Reads
 *                       the wielder's equipped weapon for blade geometry
 *                       (the WeaponActionDef stays the geometric source —
 *                       universal swing actions supply only timing), sweeps
 *                       a lag-compensated capsule, dispatches hit handlers,
 *                       publishes HitSpark, and derives the strike verb from
 *                       LoreLoadout (no SwingContext).
 *   projectile_spawn  — fires on active:enter for ranged actions; spawns the
 *                       projectile entity.
 *
 * Per-swing state (rewindTick, hit dedup) lives in `ctx.state.scratch`
 * (replicated). Behaviour is structurally faithful, not byte-identical —
 * timing/feel is retuned later (the arc explicitly trades parity for
 * structure here).
 */

import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import {
  localToWorld,
  evaluateAnimationLayers, solveSkeleton, applyQuat,
} from "@voxim/content";
import type {
  ContentService, DerivedItemStats, SwingableData,
  AnimationLayer, AnimationClip, BoneMask, BoneDef, SkeletonDef, Vec3,
} from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Position, Facing, Velocity, InputState, ModelRef } from "../../components/game.ts";
import { Resource } from "../../components/resource.ts";
import { Equipment } from "../../components/equipment.ts";
import { QualityStamped, Durability } from "../../components/instance.ts";
import { ItemData } from "../../components/items.ts";
import { LoreLoadout } from "../../components/lore_loadout.ts";
import { Hitbox } from "../../components/hitbox.ts";
import { ProjectileData } from "../../components/projectile.ts";
import type { HitHandler, HitContext } from "../../hit_handler.ts";
import type { StateHistoryBuffer, TickSnapshot, EntitySnapshot } from "../../state_history.ts";
import { testHitboxIntersection } from "../../combat/hit_resolver.ts";
import type { EffectResolver, ResolveContext } from "../effect.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("weapon_trace");

interface TraceScratch {
  rewindTick: number;
  hits: { entityId: string; bodyPart: string }[];
}

/** Equipped-weapon geometry + stats for the wielder, or unarmed defaults. */
function weaponContext(world: World, entityId: EntityId, content: ContentService) {
  const cfg = content.getGameConfig().combat;
  const unarmed: DerivedItemStats = {
    weight: cfg.unarmed.weight,
    damage: cfg.unarmed.damage,
    staminaCostPerSwing: cfg.unarmed.staminaCostPerSwing,
  };
  const slot = world.get(entityId, Equipment)?.weapon ?? null;
  const prefabId = slot?.prefabId ?? null;
  const weaponEnt = slot?.entityId ?? null;
  const quality = weaponEnt ? world.get(weaponEnt as EntityId, QualityStamped)?.quality ?? 1 : 1;
  const stats = prefabId ? content.deriveItemStats(prefabId, [], quality) : unarmed;
  const swingable = prefabId
    ? content.prefabs.get(prefabId)?.components["swingable"] as SwingableData | undefined
    : undefined;
  // Universal swing actions carry timing; the weapon supplies geometry via
  // its swingable chain (step 0's light variant for now — chain-step
  // selection is a later refinement). Unarmed falls back to config.
  const weaponActionId = (swingable && swingable.chain.length > 0)
    ? swingable.chain[0].light
    : (cfg.unarmedWeaponAction ?? "unarmed");
  return { stats, prefabId, weaponActionId };
}

function strikeVerb(world: World, entityId: EntityId): string | undefined {
  const loadout = world.get(entityId, LoreLoadout);
  const slot = loadout?.skills.findIndex((s) => s?.verb === "strike") ?? -1;
  return slot >= 0 ? `strike:${slot}` : undefined;
}

export class WeaponTraceResolver implements EffectResolver {
  readonly id = "weapon_trace";

  constructor(
    private readonly stateHistory: StateHistoryBuffer,
    private readonly tickRateHz: number,
    private readonly handlers: readonly HitHandler[],
  ) {}

  resolve(ctx: ResolveContext): void {
    if (ctx.edge === "exit") return;
    const { world, events, entityId, content } = ctx;

    const { stats, weaponActionId } = weaponContext(world, entityId, content);
    const action = content.weaponActions.get(weaponActionId);
    if (!action || !action.clipId || !action.blade) {
      log.warn("weapon action %s missing clip/blade — no trace", weaponActionId);
      return;
    }

    const scratch = (ctx.state.scratch ?? {}) as unknown as TraceScratch;
    if (ctx.edge === "enter" || scratch.rewindTick === undefined) {
      const rttMs = world.get(entityId, InputState)?.rttMs ?? 0;
      const rttTicks = Math.round(rttMs / (1000 / this.tickRateHz));
      scratch.rewindTick = Math.max(0, ctx.serverTick - rttTicks);
      scratch.hits = [];
      // Durability: one point per swing, charged on the first active tick
      // (folds in the retired DurabilitySystem). Broken weapon entity is
      // destroyed; StaleSlotCleanupSystem clears the dangling slot ref.
      const wEnt = world.get(entityId, Equipment)?.weapon?.entityId as EntityId | undefined;
      const dur = wEnt ? world.get(wEnt, Durability) : null;
      if (wEnt && dur && dur.remaining > 0) {
        const remaining = dur.remaining - 1;
        if (remaining > 0) world.set(wEnt, Durability, { ...dur, remaining });
        else {
          log.info("weapon broke: %s", world.get(wEnt, ItemData)?.prefabId ?? wEnt);
          world.destroy(wEnt);
        }
      }
    }
    const ticksInPhase = ctx.state.ticksInPhase;

    const modelRef = world.get(entityId, ModelRef);
    if (!modelRef) return;
    const skeleton = content.getSkeletonForModel(modelRef.modelId);
    if (!skeleton) return;

    const clipIndex = content.getClipIndex(skeleton.id);
    const maskIndex = content.getMaskIndex(skeleton.id);
    const boneIndex = content.getBoneIndex(skeleton.id);
    const handBone = action.holdHand ?? "hand_r";
    const bladeRadius = action.blade.radius;

    const totalTicks = action.windupTicks + action.activeTicks + action.winddownTicks;
    const tCurr = Math.min((action.windupTicks + ticksInPhase) / totalTicks, 1);
    const tPrev = Math.max((action.windupTicks + ticksInPhase - 1) / totalTicks, 0);

    let snap = this.stateHistory.getAt(scratch.rewindTick);
    if (!snap) snap = this.buildCurrentSnapshot(world, ctx.serverTick);
    if (!snap) return;

    const attackerSnap = snap.entities.find((e) => e.entityId === entityId);
    const ax = attackerSnap?.x ?? world.get(entityId, Position)?.x ?? 0;
    const ay = attackerSnap?.y ?? world.get(entityId, Position)?.y ?? 0;
    const az = attackerSnap?.z ?? world.get(entityId, Position)?.z ?? 0;
    const attackFacing = attackerSnap?.facing ?? world.get(entityId, InputState)?.facing ?? 0;
    const origin: Vec3 = { x: ax, y: ay, z: az };

    const bladeCurr = computeBladeWorld(action.clipId, action.blade.baseLocal, action.blade.tipLocal, handBone, skeleton, clipIndex, maskIndex, boneIndex, tCurr, modelRef.scaleX, modelRef.morphValues, origin, attackFacing);
    const bladePrev = computeBladeWorld(action.clipId, action.blade.baseLocal, action.blade.tipLocal, handBone, skeleton, clipIndex, maskIndex, boneIndex, tPrev, modelRef.scaleX, modelRef.morphValues, origin, attackFacing);
    if (!bladeCurr || !bladePrev) return;

    const tipDist = Math.sqrt((bladeCurr.tip.x - ax) ** 2 + (bladeCurr.tip.y - ay) ** 2 + (bladeCurr.tip.z - az) ** 2);
    const broadReach = tipDist + bladeRadius + 0.5;
    const verb = strikeVerb(world, entityId);

    for (const target of snap.entities) {
      if (target.entityId === entityId) continue;
      if (!world.isAlive(target.entityId)) continue;
      if (scratch.hits.some((h) => h.entityId === target.entityId)) continue;

      const bdx = target.x - ax, bdy = target.y - ay, bdz = (target.z ?? 0) - az;
      if (Math.sqrt(bdx * bdx + bdy * bdy + bdz * bdz) > broadReach) continue;

      const hitbox = world.get(target.entityId, Hitbox);
      if (!hitbox || hitbox.parts.length === 0) continue;

      const targetPos: Vec3 = { x: target.x, y: target.y, z: target.z ?? 0 };
      const hit = testHitboxIntersection(
        hitbox, targetPos, target.facing ?? 0, bladeRadius,
        [{ from: bladePrev.base, to: bladePrev.tip }, { from: bladeCurr.base, to: bladeCurr.tip }],
      );
      if (!hit) continue;

      const attackerPart = hit.attackerT < 1 / 3 ? "haft" : hit.attackerT < 2 / 3 ? "mid" : "tip";
      scratch.hits.push({ entityId: target.entityId, bodyPart: hit.partId });
      events.publish(TileEvents.HitSpark, {
        x: hit.contact.x, y: hit.contact.y, z: hit.contact.z,
        attackerPart, victimPart: hit.partId,
      });

      const hitCtx: HitContext = {
        attackerId: entityId,
        targetId: target.entityId,
        weaponStats: stats,
        bodyPart: hit.partId,
        attackerPart,
        targetSnapshotFacing: target.facing ?? 0,
        attackerX: ax, attackerY: ay,
        targetX: target.x, targetY: target.y,
        hitX: hit.contact.x, hitY: hit.contact.y, hitZ: hit.contact.z,
        parryAllowed: true,
        skillVerb: verb,
      };
      for (const h of this.handlers) h.onHit(world, events, hitCtx);
    }

    ctx.state.scratch = scratch as unknown as Record<string, unknown>;
  }

  private buildCurrentSnapshot(world: World, serverTick: number): TickSnapshot {
    const entities: EntitySnapshot[] = [];
    for (const { entityId, position } of world.query(Position)) {
      const vel = world.get(entityId, Velocity);
      entities.push({
        entityId,
        x: position.x, y: position.y, z: position.z,
        facing: world.get(entityId, Facing)?.angle ?? 0,
        velocityX: vel?.x ?? 0, velocityY: vel?.y ?? 0, velocityZ: vel?.z ?? 0,
      });
    }
    return { serverTick, timestamp: Date.now(), entities };
  }
}

export class ProjectileSpawnResolver implements EffectResolver {
  readonly id = "projectile_spawn";

  resolve(ctx: ResolveContext): void {
    if (ctx.edge !== "enter") return;
    const { world, entityId, content } = ctx;
    const { stats, weaponActionId } = weaponContext(world, entityId, content);
    const action = content.weaponActions.get(weaponActionId);
    if (!action?.projectile) return;

    const pos = world.get(entityId, Position);
    const input = world.get(entityId, InputState);
    if (!pos || !input) return;

    const facing = input.facing;
    const { speed, gravityScale, radius, maxHits, lifetimeTicks } = action.projectile;
    const combatCfg = content.getGameConfig().combat;
    const worldCfg = content.getGameConfig().world;
    const muzzle = action.projectile.spawnOffset ?? combatCfg.projectileDefaults.spawnOffset;
    const spawn = localToWorld(muzzle.fwd, muzzle.right, muzzle.up, { x: pos.x, y: pos.y, z: pos.z }, facing);

    const projId = newEntityId();
    world.create(projId);
    world.write(projId, Position, { x: spawn.x, y: spawn.y, z: spawn.z });
    world.write(projId, Velocity, {
      x: Math.cos(facing) * speed,
      y: Math.sin(facing) * speed,
      z: gravityScale > 0 ? speed * combatCfg.projectileDefaults.arcFactor : 0,
    });
    // T-241: lifetime is a Resource (cross@0 → destroy_self), not a
    // bespoke Lifetime countdown. Per-entity max seeded here.
    world.write(projId, Resource, {
      values: { lifetime: { value: lifetimeTicks, max: lifetimeTicks } },
    });
    world.write(projId, ProjectileData, {
      ownerId: entityId,
      damage: stats.damage ?? 0,
      toolType: stats.toolType ?? "",
      harvestPower: stats.harvestPower ?? 1,
      buildPower: stats.buildPower ?? 0,
      armorReduction: stats.armorReduction ?? 0,
      gravityScale, radius, hitEntities: [], maxHits,
    });
    if (action.projectile.modelId) {
      const s = worldCfg.defaultEntityScale;
      world.write(projId, ModelRef, { modelId: action.projectile.modelId, scaleX: s, scaleY: s, scaleZ: s, seed: 0 });
    }
  }
}

/**
 * World-space blade endpoints from a hand-bone-local blade def + a clip
 * sampled at `clipTime`. Verbatim port of ActionSystem.computeBladeWorld —
 * the geometry is unchanged; only its caller moved.
 */
function computeBladeWorld(
  clipId: string,
  baseLocal: readonly [number, number, number],
  tipLocal: readonly [number, number, number],
  handBone: string,
  skeleton: SkeletonDef,
  clipIndex: ReadonlyMap<string, AnimationClip>,
  maskIndex: ReadonlyMap<string, BoneMask>,
  boneIndex: ReadonlyMap<string, BoneDef>,
  clipTime: number,
  entityScale: number,
  morphValues: Record<string, number> | undefined,
  attackerOrigin: Vec3,
  attackFacing: number,
): { base: Vec3; tip: Vec3 } | null {
  const layers: AnimationLayer[] = [{ clipId, maskId: "", time: clipTime, weight: 1, blend: "override", speedScale: 1 }];
  const rotations = evaluateAnimationLayers(skeleton, clipIndex, maskIndex, layers);
  const transforms = solveSkeleton(skeleton, boneIndex, rotations, entityScale, morphValues);
  const hand = transforms.get(handBone);
  if (!hand) return null;
  const baseRot = applyQuat({ x: baseLocal[0] * entityScale, y: baseLocal[1] * entityScale, z: baseLocal[2] * entityScale }, hand.rot);
  const tipRot = applyQuat({ x: tipLocal[0] * entityScale, y: tipLocal[1] * entityScale, z: tipLocal[2] * entityScale }, hand.rot);
  const baseSolver = { x: hand.pos.x + baseRot.x, y: hand.pos.y + baseRot.y, z: hand.pos.z + baseRot.z };
  const tipSolver = { x: hand.pos.x + tipRot.x, y: hand.pos.y + tipRot.y, z: hand.pos.z + tipRot.z };
  const base = localToWorld(-baseSolver.z, baseSolver.x, baseSolver.y, attackerOrigin, attackFacing);
  const tip = localToWorld(-tipSolver.z, tipSolver.x, tipSolver.y, attackerOrigin, attackFacing);
  return { base, tip };
}
