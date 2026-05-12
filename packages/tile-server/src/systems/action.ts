/**
 * ActionSystem — Layer 1 of the hit architecture.
 *
 * Owns swing initiation, active-phase hit detection (lag-compensated capsule
 * sweep), and projectile spawning for ranged actions. Phase progression is
 * driven by the CSM right_hand layer (swing.windup → swing.active →
 * swing.winddown → idle), not by ActionSystem itself.
 *
 * The mode/payload split (T-182):
 *   - csm.right_hand.node = "swing.windup" / "swing.active" /
 *     "swing.winddown" / "idle" — the authoritative phase. Read by
 *     AnimationSystem (animation), by damage handlers (block check), by
 *     ActionSystem (gating + dispatch).
 *   - SwingContext (this entity's payload component) — weaponActionId,
 *     hitEntities dedup set, rewindTick, weapon prefab + quality. Present
 *     iff csm.right_hand is in any swing.* state.
 *
 * What used to be SkillInProgress is now this split. Phase-tick counters
 * are derived from `csm.right_hand.elapsed * tickRateHz`. Hit handlers,
 * durability, etc. read SwingContext for the gameplay payload.
 *
 * Single code path for players and NPCs. No isNpc branches.
 */
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { ACTION_USE_SKILL, ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4, ACTION_BLOCK, hasAction, TileEvents } from "@voxim/protocol";
import type {
  ContentService, DerivedItemStats, SwingableData, WeaponActionDef,
  AnimationLayer, AnimationClip, BoneMask, BoneDef, SkeletonDef,
} from "@voxim/content";
import { pickChainAction } from "../components/item_behaviours.ts";
import {
  localToWorld, segSegDistSq,
  evaluateAnimationLayers, solveSkeleton, applyQuat,
  defStateHasTag,
} from "@voxim/content";
import type { Vec3 } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, Facing, Velocity, InputState, Stamina, Lifetime, ModelRef } from "../components/game.ts";
import { Staggered, ActionImpulse } from "../components/combat.ts";
import { SwingContext, type SwingContextData, type HitRecord } from "../components/swing_context.ts";
import { SwingChain } from "../components/swing_chain.ts";
import { Maneuver } from "../components/maneuver.ts";
import { ManeuverLoadout } from "../components/maneuver_loadout.ts";
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
   * Reads csm.right_hand.node (set by CharacterStateMachineSystem) for phase
   * detection, and InputState (NpcAi writes via world.write()).
   */
  readonly dependsOn = ["NpcAiSystem", "CharacterStateMachineSystem"];

  private serverTick = 0;

  /**
   * Per-entity windup-elapsed snapshot (ms). Refreshed each tick the
   * actor is in `swing.windup`; read at `swing.stop` to decide light vs
   * heavy variant (release < swingable.heavyChargeMs → light, else
   * heavy). Cleared after the variant pick. Server-authoritative — we
   * don't trust the client's chargeMs for this gate.
   */
  private windupChargeMs = new Map<string, number>();

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

    // ── 0. Initiate maneuvers from skill-slot bits (T-185) ────────────────────
    // ACTION_SKILL_1..4 → ManeuverLoadout.slots[0..3]. Whichever slot the
    // pressed bit selects names the ManeuverDef. First slot pressed wins
    // (priority by index) so simultaneous bits don't double-fire.
    const SKILL_BITS: [number, number][] = [
      [ACTION_SKILL_1, 0],
      [ACTION_SKILL_2, 1],
      [ACTION_SKILL_3, 2],
      [ACTION_SKILL_4, 3],
    ];
    for (const { entityId, inputState } of world.query(InputState)) {
      if (world.has(entityId, Maneuver)) continue;
      if (rightHandHasTag(world, this.content, entityId, "carries_swing_context")) continue;
      if (world.has(entityId, Staggered)) continue;

      const loadout = world.get(entityId, ManeuverLoadout);
      if (!loadout) continue;

      let pickedId = "";
      for (const [bit, slot] of SKILL_BITS) {
        if (!hasAction(inputState.actions, bit)) continue;
        const id = loadout.slots[slot];
        if (id) { pickedId = id; break; }
      }
      if (!pickedId) continue;

      const def = this.content.maneuvers.get(pickedId);
      if (!def) continue;
      const stamina = world.get(entityId, Stamina);
      const cost = def.requirements.stamina ?? 0;
      if (cost > 0 && !deductStamina(world, entityId, stamina, cost)) continue;

      world.write(entityId, Maneuver, {
        maneuverId: def.id,
        elapsed: 0,
        rightClipId: "",
        leftClipId: "",
        activeHitTags: [],
      });
      this.tickEvents.fire(entityId, "event.maneuver_started");
      log.info("maneuver start: entity=%s id=%s", entityId, def.id);
    }

    // ── 1. Initiate new swings (chain step 0) ────────────────────────────────
    // Fires only when the actor is in idle with NO existing SwingContext
    // or SwingChain. The chain-advance pass below (1c) handles "swing N
    // → swing N+1" via SwingContext.queued, so the press loop doesn't
    // need to re-initiate during a chain. Once chain ends naturally
    // (winddown→idle without queue) or is wiped by block, this loop
    // picks up the next press fresh from chain index 0.
    for (const { entityId, inputState } of world.query(InputState)) {
      if (!hasAction(inputState.actions, ACTION_USE_SKILL)) continue;
      if (world.has(entityId, Maneuver)) continue;
      if (rightHandHasTag(world, this.content, entityId, "carries_swing_context")) continue;
      if (world.has(entityId, Staggered)) continue;
      // Mid-chain hand-off frames: SwingContext is the chain's tracker.
      // Skip — pass 1c continues the chain.
      if (world.has(entityId, SwingContext)) continue;
      // Defensive: SwingChain without SwingContext is an inconsistent
      // state (chain ended last tick, residual cleanup). Wipe and start
      // fresh.
      if (world.has(entityId, SwingChain)) world.remove(entityId, SwingChain);

      this.startChainSwing(world, entityId, 0);
    }

    // ── 1b. Track queue intent during the swing ──────────────────────────────
    // The chain only continues if the actor presses LMB at some point
    // during the previous swing's stop/active/winddown phases. swing.windup
    // is excluded because the windup already implies "you're starting to
    // hit something" — holding through it is the variant-pick gesture
    // (light vs heavy), not a queue. Once one tick observes the bit held
    // in any of {stop, active, winddown}, the queue flag sticks for the
    // rest of the swing.
    for (const { entityId, swingContext: sc, inputState } of world.query(SwingContext, InputState)) {
      const queueable = rightHandHasTag(world, this.content, entityId, "chain_queueable");
      if (queueable && hasAction(inputState.actions, ACTION_USE_SKILL)) {
        if (!sc.queued) world.set(entityId, SwingContext, { ...sc, queued: true });
      }
    }

    // ── 1c. On winddown→idle: advance chain or end it ────────────────────────
    // After the right_hand layer leaves its action states, SwingContext is
    // still alive (the CSM is a pure state machine — payload-component
    // lifecycle is owned by the system that authored the payload, i.e.
    // here). This pass is the one place that decides whether to chain
    // forward (overwrite SC with the next step) or end the chain
    // (remove SC + SwingChain).
    for (const { entityId, swingContext: sc } of world.query(SwingContext)) {
      // Still inside any action state → no decision to make this tick.
      if (rightHandHasTag(world, this.content, entityId, "carries_swing_context")) continue;
      if (sc.queued && this.canChainHere(world, entityId)) {
        const chainIdx = (world.get(entityId, SwingChain)?.index ?? 0) + 1;
        world.set(entityId, SwingChain, { index: chainIdx });
        // startChainSwing uses world.write() — installs the next SC immediately.
        this.startChainSwing(world, entityId, chainIdx);
      } else {
        if (world.has(entityId, SwingChain)) world.remove(entityId, SwingChain);
        world.remove(entityId, SwingContext);
      }
    }

    // ── 1d. Windup charge tracking + variant pick at release ─────────────────
    // While the actor is in swing.windup, snapshot the SM elapsed (ms) so
    // we have it at the moment of release. The CSM transitions
    // swing.windup → swing.stop the tick `!input.use_skill` becomes true
    // (priority 60); at that point csm.right_hand.elapsed has already
    // been reset to 0, so we read our snapshot from windupChargeMs to
    // pick the variant.
    for (const { entityId, swingContext: sc } of world.query(SwingContext)) {
      const csm = world.get(entityId, CharacterStateMachine);
      const lstate = csm?.layerStates["right_hand"];
      if (!lstate) continue;

      if (lstate.node === "swing.windup") {
        this.windupChargeMs.set(entityId, lstate.elapsed * 1000);
      } else if (lstate.node === "swing.stop") {
        const ms = this.windupChargeMs.get(entityId);
        if (ms !== undefined) {
          // First tick of swing.stop — pick the chain variant for this
          // step. Held past heavyChargeMs flips to the heavy action;
          // otherwise stay on the light action installed at chain start.
          const chainIdx = world.get(entityId, SwingChain)?.index ?? 0;
          const swingable = sc.weaponPrefabId
            ? this.content.prefabs.get(sc.weaponPrefabId)?.components["swingable"] as SwingableData | undefined
            : undefined;
          if (swingable && swingable.chain.length > 0) {
            const newAction = pickChainAction(swingable, chainIdx, ms / 1000);
            if (newAction && newAction !== sc.weaponActionId) {
              world.set(entityId, SwingContext, { ...sc, weaponActionId: newAction });
              log.debug("variant pick: entity=%s chain=%d charge=%dms action=%s",
                entityId, chainIdx, Math.round(ms), newAction);
            }
          }
          this.windupChargeMs.delete(entityId);
        }
      } else {
        this.windupChargeMs.delete(entityId);
      }
    }

    // ── 1e. Block resets the chain ───────────────────────────────────────────
    // Vermintide-style: even a millisecond block restarts the sequence.
    // Wipe SwingChain whenever input.block is held, regardless of whether
    // the actor is mid-swing. The CSM's swing.windup→idle on input.block
    // transition cancels an uncommitted swing in flight; this loop
    // additionally guarantees the chain index resets so the next press
    // starts at chain[0].
    for (const { entityId, inputState } of world.query(InputState)) {
      if (!hasAction(inputState.actions, ACTION_BLOCK)) continue;
      if (world.has(entityId, SwingChain)) world.remove(entityId, SwingChain);
    }

    // ── 1f. Root-motion impulse on phase entry (T-199) ───────────────────────
    // When the SM enters the WeaponActionDef.rootMotion.phase state (matched
    // by csm.right_hand.node === "swing." + phase AND elapsed === 0 — the
    // first tick of that state), install an ActionImpulse with vx/vy baked
    // from facing × forwardImpulse and ticksRemaining = the phase's tick
    // budget. PhysicsSystem reads it as a Sidestep-style movement override.
    for (const { entityId, swingContext: sc } of world.query(SwingContext)) {
      const action = this.content.weaponActions.get(sc.weaponActionId);
      if (!action?.rootMotion) continue;
      const csm = world.get(entityId, CharacterStateMachine);
      const lstate = csm?.layerStates["right_hand"];
      if (!lstate) continue;
      if (lstate.node !== `swing.${action.rootMotion.phase}`) continue;
      if (lstate.elapsed !== 0) continue;
      const facingAngle = world.get(entityId, Facing)?.angle ?? 0;
      const speed = action.rootMotion.forwardImpulse;
      const phaseTicks =
        action.rootMotion.phase === "windup"   ? action.windupTicks   :
        action.rootMotion.phase === "active"   ? action.activeTicks   :
                                                 action.winddownTicks;
      world.set(entityId, ActionImpulse, {
        vx: Math.cos(facingAngle) * speed,
        vy: Math.sin(facingAngle) * speed,
        ticksRemaining: phaseTicks,
      });
    }

    // ── 2. Active-phase hit / projectile dispatch ────────────────────────────
    // Read csm.right_hand.node to detect active phase. Hit handling and projectile
    // spawn fire only during swing.active. Phase advancement itself is owned
    // by the CSM (state.elapsed >= state.duration transitions); ActionSystem
    // just observes and dispatches.
    for (const { entityId, swingContext: sc } of world.query(SwingContext)) {
      const action = this.content.weaponActions.get(sc.weaponActionId);
      if (!action) continue;

      if (!rightHandHasTag(world, this.content, entityId, "active_hitbox")) continue;

      // Sub-tick within active phase, derived from the CSM elapsed.
      const csm = world.get(entityId, CharacterStateMachine);
      const elapsed = csm?.layerStates["right_hand"]?.elapsed ?? 0;
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

  /**
   * Start a swing at the given chain index. Picks the action id from the
   * weapon's chain (light variant by default — heavy is decided when
   * windup release fires; see startCharge / variant-pick path elsewhere).
   * Installs SwingContext + SwingChain, fires event.swing_started, deducts
   * stamina, and logs.
   */
  private startChainSwing(world: World, entityId: EntityId, chainIndex: number): void {
    const gameCfg = this.content.getGameConfig();
    const combatCfg = gameCfg.combat;
    const unarmedActionId = combatCfg.unarmedWeaponAction ?? "unarmed";
    const unarmed: DerivedItemStats = {
      weight: combatCfg.unarmed.weight,
      damage: combatCfg.unarmed.damage,
      staminaCostPerSwing: combatCfg.unarmed.staminaCostPerSwing,
    };

    const equipment = world.get(entityId, Equipment);
    const weaponSlot = equipment?.weapon ?? null;
    const weaponPrefabId = weaponSlot?.prefabId ?? null;
    const weaponId = weaponSlot?.entityId ?? null;
    const weaponQuality = weaponId ? world.get(weaponId as EntityId, QualityStamped)?.quality ?? 1 : 1;
    const weaponStats = weaponPrefabId ? this.content.deriveItemStats(weaponPrefabId, [], weaponQuality) : unarmed;
    const swingable = weaponPrefabId
      ? this.content.prefabs.get(weaponPrefabId)?.components["swingable"] as SwingableData | undefined
      : undefined;

    const staminaCost = weaponStats.staminaCostPerSwing ?? unarmed.staminaCostPerSwing!;
    const stamina = world.get(entityId, Stamina);
    deductStamina(world, entityId, stamina, staminaCost);

    const loreLoadout = world.get(entityId, LoreLoadout);
    const strikeSlot = loreLoadout?.skills.findIndex((s) => s?.verb === "strike") ?? -1;

    // Initial action id = chain[index].light (variant pick on release
    // promotes to heavy if the player held past heavyChargeMs). When no
    // swingable / empty chain, fall back to the unarmed action.
    let weaponActionId = unarmedActionId;
    if (swingable && swingable.chain.length > 0) {
      weaponActionId = pickChainAction(swingable, chainIndex, 0) ?? unarmedActionId;
    }

    world.write(entityId, SwingContext, {
      weaponActionId,
      rewindTick: -1,
      hitEntities: [],
      pendingSkillVerb: strikeSlot >= 0 ? `strike:${strikeSlot}` : "",
      weaponPrefabId: weaponPrefabId ?? "",
      weaponQuality,
      queued: false,
    });
    world.write(entityId, SwingChain, { index: chainIndex });
    this.tickEvents.fire(entityId, "event.swing_started");

    log.info("swing start: entity=%s weapon=%s chain=%d action=%s stamina=%f",
      entityId, weaponPrefabId ?? "unarmed", chainIndex, weaponActionId, stamina?.current ?? 0);
  }

  /**
   * Allow the queued chain step to fire? Returns false if the actor is
   * staggered, dead, or otherwise gating-prevented from continuing. Block
   * cancellation is handled separately (the SM's input.block→idle
   * transition runs before this, and the chain-end branch above wipes
   * SwingChain when SwingContext.queued is false — which it will be on
   * a block-canceled swing because the windup→idle path skips active and
   * winddown entirely so queued never gets set).
   */
  private canChainHere(world: World, entityId: EntityId): boolean {
    return !world.has(entityId, Staggered) && !world.has(entityId, Maneuver);
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

/**
 * Tag-based check for "is the actor's right_hand layer currently inside any
 * action state (swing.windup / stop / active / winddown today, future cast /
 * channel / throw later)." Replaces string-prefix matching on the node name.
 */
function rightHandHasTag(world: World, content: ContentService, entityId: string, tag: string): boolean {
  const csm = world.get(entityId, CharacterStateMachine);
  if (!csm) return false;
  const node = csm.layerStates["right_hand"]?.node;
  if (!node) return false;
  const def = content.stateMachines.get(csm.stateMachineId);
  if (!def) return false;
  return defStateHasTag(def, "right_hand", node, tag);
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
