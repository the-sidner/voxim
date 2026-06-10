/**
 * TriggerSystem (T-259) — the fourth primitive's runtime: the SINGLE
 * event→effect bridge. See TRIGGER_PRIMITIVE_PLAN.md.
 *
 * Two halves:
 *
 *   COLLECT — `registerSubscribers` hangs one collector per catalog kind on
 *   the real bus. Collectors run during the (notify-only, T-249) post-
 *   changeset flush and only push `(kind, payload)` into a buffer — no
 *   world writes at flush time.
 *
 *   DRAIN — at the top of the next `run`, per buffered event: resolve the
 *   event's role→entity map (catalog binding), collect each involved
 *   entity's trigger ids from the TriggerSource registry (live reads —
 *   equipment etc.), match `on` + `as`, test `conditions` (the action gate
 *   registry, owner-scoped), check the internal cooldown, then fire the
 *   trigger's `effects` through the one action-effect registry (T-246)
 *   with the owner as `entityId` and the event's other party merged into
 *   params as `overrideTargetId`. Effects write via `world.mutate`, so
 *   concurrent procs compose. Net latency: one tick after the event — the
 *   timing the retired strike path always had ("invisible at 20 Hz").
 *
 * No proc chains (v1): effects fired here get a wrapping EventEmitter that
 * tags published payloads `viaTrigger: true` (clients still see the
 * DamageDealt/HitSpark); the collectors skip tagged events. A lifesteal
 * trigger cannot proc itself across ticks. Proc chains become a design
 * decision later, not an accident now.
 */

import type { World, EntityId, EventBus } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { TriggerCooldowns } from "../components/trigger_cooldowns.ts";
import type { ActiveActionState } from "../components/action.ts";
import type { TriggerCatalog, TriggerEventBinding } from "../triggers/catalog.ts";
import type { TriggerSourceRegistry } from "../triggers/source.ts";
import type { GateRegistry, GateContext } from "../actions/gate.ts";
import type { EffectRegistry } from "../actions/effect.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("TriggerSystem");

// Triggers fire effects outside the phase machine — same synthetic
// dispatch shape SkillSystem uses (the resolvers read entityId + params).
const TRIGGER_STATE: ActiveActionState = { actionId: "", phase: "", ticksInPhase: 0, initiator: "event" };

interface BufferedEvent {
  binding: TriggerEventBinding;
  payload: unknown;
}

export class TriggerSystem implements System {
  private buffer: BufferedEvent[] = [];
  private serverTick = 0;

  constructor(
    private readonly content: ContentService,
    private readonly catalog: TriggerCatalog,
    private readonly sources: TriggerSourceRegistry,
    private readonly gates: GateRegistry,
    private readonly effects: EffectRegistry,
  ) {}

  /**
   * Hang the collectors on the real tile event bus. Called once from
   * TileServer after world + bus are constructed (the SkillSystem
   * registerSubscribers pattern).
   */
  registerSubscribers(bus: EventBus): void {
    for (const kind of this.catalog.ids()) {
      const binding = this.catalog.get(kind);
      bus.subscribe(binding.event, (payload: unknown) => {
        // No proc chains (v1): skip events published by trigger-fired
        // effects (tagged by the wrapping emitter below).
        if ((payload as { viaTrigger?: boolean } | null)?.viaTrigger) return;
        this.buffer.push({ binding, payload });
      });
    }
  }

  prepare(serverTick: number, _ctx: TickContext): void {
    this.serverTick = serverTick;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    // ── ICD tick-down (single writer; spent keys dropped) ─────────────────
    for (const { entityId, triggerCooldowns } of world.query(TriggerCooldowns)) {
      if (Object.keys(triggerCooldowns.remaining).length === 0) continue;
      world.mutate(entityId, TriggerCooldowns, (tc) => {
        const remaining: Record<string, number> = {};
        for (const [id, ticks] of Object.entries(tc.remaining)) {
          if (ticks > 1) remaining[id] = ticks - 1;
        }
        return { remaining };
      });
    }

    // ── Drain the buffer ───────────────────────────────────────────────────
    if (this.buffer.length === 0) return;
    const drained = this.buffer;
    this.buffer = [];

    // Effects fired here publish through a tagging emitter — see header.
    const wrapped: EventEmitter = {
      publish: (type, payload) =>
        events.publish(type, { ...(payload as Record<string, unknown>), viaTrigger: true }),
    };

    // ICD stamps from this drain, visible within the same drain (the
    // deferred component write isn't committed yet).
    const stampedThisRun = new Map<EntityId, Set<string>>();

    for (const ev of drained) {
      const roles = ev.binding.roles(ev.payload);
      for (const [role, ownerId] of Object.entries(roles)) {
        if (!ownerId || !world.isAlive(ownerId)) continue;

        const ids = new Set<string>();
        for (const sourceId of this.sources.ids()) {
          for (const t of this.sources.get(sourceId).collect({ world, content: this.content, entityId: ownerId })) {
            ids.add(t);
          }
        }
        if (ids.size === 0) continue;

        const counterpart = Object.entries(roles)
          .find(([r, id]) => r !== role && id !== undefined)?.[1] ?? null;

        for (const triggerId of ids) {
          const def = this.content.triggers.get(triggerId);
          if (!def) {
            // Content triggers are boot-cross-checked; this guards future
            // procedural sources handing out stale ids.
            log.warn("source granted unknown trigger '%s' (owner=%s)", triggerId, ownerId);
            continue;
          }
          if (def.on !== ev.binding.id || def.as !== role) continue;

          // Internal cooldown — committed view + this drain's stamps.
          const icd = def.internalCooldownTicks ?? 0;
          if (icd > 0) {
            if ((world.get(ownerId, TriggerCooldowns)?.remaining[triggerId] ?? 0) > 0) continue;
            if (stampedThisRun.get(ownerId)?.has(triggerId)) continue;
          }

          if (!this.conditionsPass(world, ownerId, def.conditions ?? [])) continue;

          log.debug("trigger fired: %s owner=%s on=%s as=%s target=%s",
            triggerId, ownerId, def.on, role, counterpart ?? "none");

          for (const eff of def.effects) {
            this.effects.get(eff.kind).resolve({
              world,
              events: wrapped,
              entityId: ownerId,
              slot: "trigger",
              state: TRIGGER_STATE,
              content: this.content,
              params: { ...(eff.params ?? {}), overrideTargetId: counterpart },
              edge: "enter",
              serverTick: this.serverTick,
            });
          }

          if (icd > 0) {
            this.stampIcd(world, ownerId, triggerId, icd);
            let set = stampedThisRun.get(ownerId);
            if (!set) {
              set = new Set();
              stampedThisRun.set(ownerId, set);
            }
            set.add(triggerId);
          }
        }
      }
    }
  }

  private conditionsPass(
    world: World,
    entityId: EntityId,
    conditions: ReadonlyArray<{ gate: string; params?: Record<string, unknown> }>,
  ): boolean {
    for (const c of conditions) {
      const ctx: GateContext = { world, entityId, content: this.content, params: c.params ?? {} };
      if (!this.gates.get(c.gate).test(ctx)) return false;
    }
    return true;
  }

  private stampIcd(world: World, ownerId: EntityId, triggerId: string, ticks: number): void {
    if (world.has(ownerId, TriggerCooldowns)) {
      world.mutate(ownerId, TriggerCooldowns, (tc) => ({
        remaining: { ...tc.remaining, [triggerId]: ticks },
      }));
    } else {
      world.set(ownerId, TriggerCooldowns, { remaining: { [triggerId]: ticks } });
    }
  }
}
