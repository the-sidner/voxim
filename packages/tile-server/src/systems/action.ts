/**
 * ActionSystem — Layer 1 of the hit architecture.
 *
 * Owns swing initiation, active-phase hit detection (lag-compensated capsule
 * sweep), and projectile spawning for ranged actions. Phase progression is
 * driven by the CSM combat layer (swing.windup → swing.active → swing.winddown
 * → idle), not by ActionSystem itself.
 *
 * The mode/payload split (T-182):
 *   - csm.combat.node = "swing.windup" / "swing.active" / "swing.winddown" /
 *     "idle" — the authoritative phase. Read by AnimationSystem (animation),
 *     by damage handlers (block check), by ActionSystem (gating + dispatch).
 *   - SwingContext (this entity's payload component) — weaponActionId,
 *     hitEntities dedup set, rewindTick, weapon prefab + quality. Present
 *     iff csm.combat is in any swing.* state.
 *
 * What used to be SkillInProgress is now this split. Phase-tick counters
 * are derived from `csm.combat.elapsed * tickRateHz`. Hit handlers,
 * durability, etc. read SwingContext for the gameplay payload.
 *
 * Single code path for players and NPCs. No isNpc branches.
 */
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { ACTION_USE_SKILL, hasAction, TileEvents } from "@voxim/protocol";
import type {
  ContentService, DerivedItemStats, SwingableData, WeaponActionDef,
  AnimationLayer, AnimationClip, BoneMask, BoneDef, SkeletonDef,
} from "@voxim/content";
import { pickWeaponAction } from "../components/item_behaviours.ts";
import {
  localToWorld, segSegDistSq,
  evaluateAnimationLayers, solveSkeleton, applyQuat,
} from "@voxim/content";
import type { Vec3 } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, Facing, Velocity, InputState, Stamina, Lifetime, ModelRef } from "../components/game.ts";
import { Staggered } from "../components/combat.ts";
import { SwingContext, type SwingContextData, type HitRecord } from "../components/swing_context.ts";
import { CharacterStateMachine } from "../components/character_state_machine.ts";
import { Equipment } from "../components/equipment.ts";
import { QualityStamped } from "../components/instance.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { Hitbox } from "../components/hitbox.ts";
import { ProjectileData } from "../components/projectile.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import type { StateHistoryBuffer, TickSnapshot, EntitySnapshot } from "../state_history.ts";
import { TickEventBuffer } from "../tick_events.ts";
import { deductStamina } from "../combat/helpers.ts";
import { testHitboxIntersection } from "../combat/hit_resolver.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ActionSystem");

const SECONDS_PER_TICK = 1 / 20;

export class ActionSystem implements System {
  /**
   * Reads csm.combat.node (set by CharacterStateMachineSystem) for phase
   * detection, and InputState (NpcAi writes via world.write()).
   */
  readonly dependsOn = ["NpcAiSystem", "CharacterStateMachineSystem"];

  private serverTick = 0;

  constructor(
    private readonly stateHistory: StateHistoryBuffer,
    private readonly tickRateHz: number,
    private readonly content: ContentService,
    private readonly handlers: HitHandler[],
    private readonly tickEvents: TickEventBuffer,
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

    // ── 1. Initiate new swings ────────────────────────────────────────────────
    for (const { entityId, inputState } of world.query(InputState)) {
      if (!hasAction(inputState.actions, ACTION_USE_SKILL)) continue;
      // Already swinging? CSM combat node tells us.
      if (isSwingingNode(combatNode(world, entityId))) continue;
      if (world.has(entityId, Staggered)) continue;

      const equipment = world.get(entityId, Equipment);
      const weaponSlot = equipment?.weapon ?? null;
      const weaponPrefabId = weaponSlot?.prefabId ?? null;
      const weaponId = weaponSlot?.entityId ?? null;
      const weaponQuality = weaponId ? world.get(weaponId as EntityId, QualityStamped)?.quality ?? 1 : 1;
      const weaponStats = weaponPrefabId ? this.content.deriveItemStats(weaponPrefabId, [], weaponQuality) : unarmed;

      const staminaCost = weaponStats.staminaCostPerSwing ?? unarmed.staminaCostPerSwing!;
      const stamina = world.get(entityId, Stamina);
      deductStamina(world, entityId, stamina, staminaCost);

      const loreLoadout = world.get(entityId, LoreLoadout);
      const strikeSlot = loreLoadout?.skills.findIndex((s) => s?.verb === "strike") ?? -1;

      const swingable = weaponPrefabId
        ? this.content.prefabs.get(weaponPrefabId)?.components["swingable"] as SwingableData | undefined
        : undefined;
      const picked = swingable ? pickWeaponAction(swingable, inputState.chargeMs ?? 0) : null;
      const weaponActionId = picked?.actionId ?? unarmedActionId;

      // Install SwingContext payload, fire event for the SM. CSM transitions
      // combat → swing.windup next tick.
      world.write(entityId, SwingContext, {
        weaponActionId,
        rewindTick: -1,
        hitEntities: [],
        pendingSkillVerb: strikeSlot >= 0 ? `strike:${strikeSlot}` : "",
        weaponPrefabId: weaponPrefabId ?? "",
        weaponQuality,
      });
      this.tickEvents.fire(entityId, "event.swing_started");

      log.info("swing start: entity=%s weapon=%s action=%s charge=%dms stamina=%f",
        entityId, weaponPrefabId ?? "unarmed", weaponActionId, inputState.chargeMs ?? 0, stamina?.current ?? 0);
    }

    // ── 2. Active-phase hit / projectile dispatch ────────────────────────────
    // Read csm.combat.node to detect active phase. Hit handling and projectile
    // spawn fire only during swing.active. Phase advancement itself is owned
    // by the CSM (state.elapsed >= state.duration transitions); ActionSystem
    // just observes and dispatches.
    for (const { entityId, swingContext: sc } of world.query(SwingContext)) {
      const action = this.content.weaponActions.get(sc.weaponActionId);
      if (!action) continue;

      const node = combatNode(world, entityId);
      if (node !== "swing.active") continue;

      // Sub-tick within active phase, derived from the CSM elapsed.
      const csm = world.get(entityId, CharacterStateMachine);
      const elapsed = csm?.layerStates["combat"]?.elapsed ?? 0;
      const ticksInPhase = Math.round(elapsed / SECONDS_PER_TICK);

      if ((action.actionType ?? "melee") === "ranged") {
        // Ranged: spawn projectile on first active tick (rewindTick is the marker).
        if (sc.rewindTick < 0) {
          this.spawnProjectile(world, entityId, sc, action, unarmed);
          // Mark "spawned" by setting rewindTick to a non-negative sentinel.
          world.set(entityId, SwingContext, { ...sc, rewindTick: 0 });
        }
        continue;
      }

      // Melee: lag-compensated blade sweep.
      let rewindTick = sc.rewindTick;
      if (rewindTick < 0) {
        const inputState = world.get(entityId, InputState);
        const rttMs = inputState?.rttMs ?? 0;
        const rttTicks = Math.round(rttMs / (1000 / this.tickRateHz));
        rewindTick = Math.max(0, this.serverTick - rttTicks);
      }
      const newHitEntities = this.resolveHits(world, events, entityId, sc, action, unarmed, rewindTick, ticksInPhase);
      if (newHitEntities !== sc.hitEntities || rewindTick !== sc.rewindTick) {
        world.set(entityId, SwingContext, { ...sc, rewindTick, hitEntities: newHitEntities });
      }
    }
  }

  private resolveHits(
    world: World,
    events: EventEmitter,
    entityId: string,
    sc: SwingContextData,
    action: WeaponActionDef,
    unarmed: DerivedItemStats,
    rewindTick: number,
    ticksInPhase: number,
  ): HitRecord[] {
    if (!action.clipId || !action.blade) {
      log.warn("melee action %s missing clipId/blade — cannot resolve hits", action.id);
      return sc.hitEntities;
    }

    const weaponPrefabId2 = sc.weaponPrefabId || null;
    const weaponStats = weaponPrefabId2 ? this.content.deriveItemStats(weaponPrefabId2, [], sc.weaponQuality) : unarmed;

    const modelRef = world.get(entityId, ModelRef);
    if (!modelRef) return sc.hitEntities;
    const skeleton = this.content.getSkeletonForModel(modelRef.modelId);
    if (!skeleton) return sc.hitEntities;

    const clipIndex = this.content.getClipIndex(skeleton.id);
    const maskIndex = this.content.getMaskIndex(skeleton.id);
    const boneIndex = this.content.getBoneIndex(skeleton.id);
    const entityScale = modelRef.scaleX;
    const morphValues = modelRef.morphValues;
    const handBone = action.holdHand ?? "hand_r";
    const bladeRadius = action.blade.radius;

    // Clip times for the swing's prev and curr ticks. windupTicks ↔ tStart of
    // active phase in clip-time units. Each tick advances the clip by 1/total.
    const totalTicks = action.windupTicks + action.activeTicks + action.winddownTicks;
    const tCurr = Math.min((action.windupTicks + ticksInPhase) / totalTicks, 1);
    const tPrev = Math.max((action.windupTicks + ticksInPhase - 1) / totalTicks, 0);

    let snap = this.stateHistory.getAt(rewindTick);
    if (!snap) {
      const oldest = this.stateHistory.oldestTick();
      const newest = this.stateHistory.newestTick();
      log.debug("rewind out of window: entity=%s rewindTick=%d window=[%s,%s] — using current state",
        entityId, rewindTick, oldest ?? "?", newest ?? "?");
      snap = this.buildCurrentSnapshot(world);
    }
    if (!snap) return sc.hitEntities;

    const attackerSnap = snap.entities.find((e) => e.entityId === entityId);
    const ax = attackerSnap?.x ?? (world.get(entityId, Position)?.x ?? 0);
    const ay = attackerSnap?.y ?? (world.get(entityId, Position)?.y ?? 0);
    const az = attackerSnap?.z ?? (world.get(entityId, Position)?.z ?? 0);
    const inputState = world.get(entityId, InputState);
    const attackFacing = attackerSnap?.facing ?? inputState?.facing ?? 0;
    const attackerOrigin: Vec3 = { x: ax, y: ay, z: az };

    const bladeCurr = computeBladeWorld(
      action.clipId, action.blade.baseLocal, action.blade.tipLocal, handBone,
      skeleton, clipIndex, maskIndex, boneIndex, tCurr, entityScale, morphValues,
      attackerOrigin, attackFacing,
    );
    const bladePrev = computeBladeWorld(
      action.clipId, action.blade.baseLocal, action.blade.tipLocal, handBone,
      skeleton, clipIndex, maskIndex, boneIndex, tPrev, entityScale, morphValues,
      attackerOrigin, attackFacing,
    );
    if (!bladeCurr || !bladePrev) return sc.hitEntities;

    // Effective blade reach for broad-phase culling — distance from attacker
    // origin to the current tip, plus the capsule radius and a small margin.
    const tipDist = Math.sqrt(
      (bladeCurr.tip.x - ax) ** 2 +
      (bladeCurr.tip.y - ay) ** 2 +
      (bladeCurr.tip.z - az) ** 2,
    );
    const broadReach = tipDist + bladeRadius + 0.5;

    const newHitEntities: HitRecord[] = [...sc.hitEntities];

    for (const target of snap.entities) {
      if (target.entityId === entityId) continue;
      if (!world.isAlive(target.entityId)) continue;
      if (newHitEntities.some((h) => h.entityId === target.entityId)) continue;

      const bdx = target.x - ax, bdy = target.y - ay, bdz = (target.z ?? 0) - az;
      const broadDist = Math.sqrt(bdx * bdx + bdy * bdy + bdz * bdz);
      if (broadDist > broadReach) continue;

      const hitbox = world.get(target.entityId, Hitbox);
      if (!hitbox || hitbox.parts.length === 0) continue;

      const targetPos: Vec3 = { x: target.x, y: target.y, z: target.z ?? 0 };
      const targetFacing = target.facing ?? 0;

      const hit = testHitboxIntersection(
        hitbox,
        targetPos,
        targetFacing,
        bladeRadius,
        [{ from: bladePrev.base, to: bladePrev.tip }, { from: bladeCurr.base, to: bladeCurr.tip }],
      );

      if (!hit) {
        const dists = hitbox.parts.map((p) => {
          const pf = localToWorld(p.fromFwd, p.fromRight, p.fromUp, targetPos, targetFacing);
          const pt = localToWorld(p.toFwd, p.toRight, p.toUp, targetPos, targetFacing);
          const d = Math.min(
            segSegDistSq(bladeCurr.base, bladeCurr.tip, pf, pt),
            segSegDistSq(bladePrev.base, bladePrev.tip, pf, pt),
          );
          return `${p.id}:${Math.sqrt(d).toFixed(2)}(r=${(bladeRadius + p.radius).toFixed(2)})`;
        });
        log.info("miss: attacker=%s target=%s dist=%.2f parts=[%s]",
          entityId, target.entityId, broadDist, dists.join(","));
        continue;
      }

      const hitBodyPart = hit.partId;
      const hitContact = hit.contact;
      newHitEntities.push({ entityId: target.entityId, bodyPart: hitBodyPart });

      events.publish(TileEvents.HitSpark, { x: hitContact.x, y: hitContact.y, z: hitContact.z });

      const ctx: HitContext = {
        attackerId: entityId,
        targetId: target.entityId,
        weaponStats,
        bodyPart: hitBodyPart,
        targetSnapshotFacing: target.facing ?? 0,
        targetSnapshotActions: target.actions,
        targetSnapshotCsmNodes: target.csmLayerNodes,
        attackerX: ax,
        attackerY: ay,
        targetX: target.x,
        targetY: target.y,
        hitX: hitContact.x,
        hitY: hitContact.y,
        hitZ: hitContact.z,
        parryAllowed: true,
      };
      log.info("dispatching hit: attacker=%s target=%s bodyPart=%s weapon=%s",
        entityId, target.entityId, hitBodyPart, ctx.weaponStats.toolType ?? "weapon");
      for (const handler of this.handlers) {
        handler.onHit(world, events, ctx);
      }
    }

    return newHitEntities;
  }

  private spawnProjectile(
    world: World,
    entityId: string,
    sc: SwingContextData,
    action: WeaponActionDef | undefined,
    unarmed: DerivedItemStats,
  ): void {
    if (!action?.projectile) return;

    const weaponPrefabId3 = sc.weaponPrefabId || null;
    const weaponStats = weaponPrefabId3 ? this.content.deriveItemStats(weaponPrefabId3, [], sc.weaponQuality) : unarmed;

    const pos = world.get(entityId, Position);
    const inputState = world.get(entityId, InputState);
    if (!pos || !inputState) return;

    const facing = inputState.facing;
    const { speed, gravityScale, radius, maxHits, lifetimeTicks } = action.projectile;

    const combatCfg = this.content.getGameConfig().combat;
    const worldCfg = this.content.getGameConfig().world;

    const localMuzzle = action.projectile.spawnOffset ?? combatCfg.projectileDefaults.spawnOffset;

    const attackerOrigin = { x: pos.x, y: pos.y, z: pos.z };
    const spawn = localToWorld(localMuzzle.fwd, localMuzzle.right, localMuzzle.up, attackerOrigin, facing);

    const vx = Math.cos(facing) * speed;
    const vy = Math.sin(facing) * speed;
    const vz = gravityScale > 0 ? speed * combatCfg.projectileDefaults.arcFactor : 0;

    const projId = newEntityId();
    world.create(projId);
    world.write(projId, Position, { x: spawn.x, y: spawn.y, z: spawn.z });
    world.write(projId, Velocity, { x: vx, y: vy, z: vz });
    world.write(projId, Lifetime, { ticks: lifetimeTicks });
    world.write(projId, ProjectileData, {
      ownerId: entityId,
      damage: weaponStats.damage ?? 0,
      toolType: weaponStats.toolType ?? "",
      harvestPower: weaponStats.harvestPower ?? 1,
      buildPower: weaponStats.buildPower ?? 0,
      armorReduction: weaponStats.armorReduction ?? 0,
      gravityScale,
      radius,
      hitEntities: [],
      maxHits,
    });

    if (action.projectile.modelId) {
      const s = worldCfg.defaultEntityScale;
      world.write(projId, ModelRef, { modelId: action.projectile.modelId, scaleX: s, scaleY: s, scaleZ: s, seed: 0 });
    }

    log.info("projectile spawned: entity=%s owner=%s weapon=%s speed=%.1f facing=%.2f",
      projId, entityId, weaponPrefabId3 ?? "unarmed", speed, facing);
  }

  private buildCurrentSnapshot(world: World): TickSnapshot {
    const entities: EntitySnapshot[] = [];
    for (const { entityId, position } of world.query(Position)) {
      const facing = world.get(entityId, Facing)?.angle ?? 0;
      const vel = world.get(entityId, Velocity);
      const inputState = world.get(entityId, InputState);
      entities.push({
        entityId,
        x: position.x,
        y: position.y,
        z: position.z,
        facing,
        velocityX: vel?.x ?? 0,
        velocityY: vel?.y ?? 0,
        velocityZ: vel?.z ?? 0,
        actions: inputState?.actions ?? 0,
      });
    }
    return { serverTick: this.serverTick, timestamp: Date.now(), entities };
  }
}

function combatNode(world: World, entityId: string): string {
  const csm = world.get(entityId, CharacterStateMachine);
  return csm?.layerStates["combat"]?.node ?? "idle";
}

function isSwingingNode(node: string): boolean {
  return node === "swing.windup" || node === "swing.active" || node === "swing.winddown";
}

/**
 * Compute world-space blade endpoints (base, tip) from a hand-bone-local
 * blade definition + an animation clip sampled at `clipTime`.
 *
 * Pipeline per call:
 *   1. evaluateAnimationLayers → bone Euler rotations (solver space)
 *   2. solveSkeleton → bone world transforms (entity-local solver space)
 *   3. Look up holdHand transform; rotate+offset blade.baseLocal/tipLocal
 *   4. Convert solver (x=right, y=up, z=-fwd) → entity-local (right, up, fwd)
 *   5. localToWorld with attacker origin + facing
 *
 * Used for the prev and curr ticks of an active-phase swing so the capsule
 * sweep covers the actual hand path through the clip — no parametric
 * swingPath, no IK overlay.
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
  const layers: AnimationLayer[] = [{
    clipId,
    maskId: "",
    time: clipTime,
    weight: 1,
    blend: "override",
    speedScale: 1,
  }];
  const rotations = evaluateAnimationLayers(skeleton, clipIndex, maskIndex, layers);
  const transforms = solveSkeleton(skeleton, boneIndex, rotations, entityScale, morphValues);

  const hand = transforms.get(handBone);
  if (!hand) return null;

  // Rotate hand-local blade endpoints into entity-local solver space, then
  // offset by hand position. baseLocal/tipLocal scale with the entity scale
  // because they're authored in voxel-rest units (matching bone restX/Y/Z).
  const baseRot = applyQuat(
    { x: baseLocal[0] * entityScale, y: baseLocal[1] * entityScale, z: baseLocal[2] * entityScale },
    hand.rot,
  );
  const tipRot = applyQuat(
    { x: tipLocal[0] * entityScale, y: tipLocal[1] * entityScale, z: tipLocal[2] * entityScale },
    hand.rot,
  );
  const baseSolver = { x: hand.pos.x + baseRot.x, y: hand.pos.y + baseRot.y, z: hand.pos.z + baseRot.z };
  const tipSolver  = { x: hand.pos.x + tipRot.x,  y: hand.pos.y + tipRot.y,  z: hand.pos.z + tipRot.z  };

  // Solver space → entity-local (fwd, right, up). solver: x=right, y=up, z=-fwd.
  const base = localToWorld(-baseSolver.z, baseSolver.x, baseSolver.y, attackerOrigin, attackFacing);
  const tip  = localToWorld(-tipSolver.z,  tipSolver.x,  tipSolver.y,  attackerOrigin, attackFacing);
  return { base, tip };
}
