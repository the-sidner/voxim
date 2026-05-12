/**
 * Character State Machine runtime.
 *
 * `compileStateMachine` pre-parses every transition expression at content
 * load. `smTickAll` advances per-actor layer state one tick against an
 * `SMScope` of variables built from the actor's components.
 *
 * The runtime is animation-agnostic: layers carry an `output` flag declaring
 * what they project to (animation / flag / mode). Animation-typed layers are
 * walked into AnimationLayer[] by `projectAnimationLayers` — a separate
 * projection step so non-animation layers can exist (posture, behaviour
 * mode) without polluting the animation pipeline.
 *
 * # Cross-layer reads
 *
 * Layers can reference each other's nodes via `csm.<layer>` in DSL
 * expressions. The runtime takes a snapshot of all prior layer states at
 * tick-start, so transitions on layer A always see layer B's state from the
 * START of this tick — never partway through. This eliminates ordering
 * dependencies between layers in the JSON.
 *
 * # Self-reads
 *
 * `state.elapsed` and `state.duration` in expressions refer to the current
 * layer's currently-active state. They're rebuilt for each layer when its
 * transitions are evaluated.
 */

import type {
  StateMachineDef,
  SMLayer,
  SMState,
  SMTransition,
} from "./types.ts";
import {
  parseSMExpr,
  evalSMExprBool,
  type ParsedSMExpr,
  type SMScope,
  type SMScopeValue,
} from "./sm_expression.ts";

// ---- compiled forms -------------------------------------------------------

interface CompiledTransition {
  from: ReadonlySet<string> | "any";
  to: string;
  when: ParsedSMExpr;
  priority: number;
  /** Declaration index — secondary sort key for stable ordering. */
  declIndex: number;
}

interface CompiledOverride {
  cond: ParsedSMExpr;
  patch: Partial<SMState>;
}

interface CompiledState {
  raw: SMState;
  overrides: CompiledOverride[];
  /** Frozen tag set; empty when the author declared no tags. */
  tags: ReadonlySet<string>;
}

interface CompiledLayer {
  raw: SMLayer;
  states: Map<string, CompiledState>;
  transitions: CompiledTransition[];
  /**
   * Union of every tag declared by any state in this layer. Used to drive
   * scope-variable emission: each entry becomes a `csm.<layer>.<tag>`
   * boolean every tick. Authoring a transition that references a tag this
   * layer never produces is an authoring bug surfaced by T-194.
   */
  layerTags: ReadonlySet<string>;
}

export interface CompiledStateMachine {
  id: string;
  layers: CompiledLayer[];
  /** All variable names referenced by any transition or override expression. */
  referencedVars: ReadonlySet<string>;
}

/**
 * True iff `node` carries `tag` in the given compiled layer. O(layers).
 */
export function stateHasTag(
  compiled: CompiledStateMachine,
  layerId: string,
  node: string,
  tag: string,
): boolean {
  const layer = compiled.layers.find((l) => l.raw.id === layerId);
  if (!layer) return false;
  const s = layer.states.get(node);
  return s ? s.tags.has(tag) : false;
}

/**
 * Tag-membership lookup from a raw SM def (no compile required). Cheap enough
 * for per-tick reads — gameplay systems that don't already hold a
 * CompiledStateMachine use this with the ContentService-registered def.
 */
export function defStateHasTag(
  def: StateMachineDef,
  layerId: string,
  node: string,
  tag: string,
): boolean {
  const layer = def.layers.find((l) => l.id === layerId);
  if (!layer) return false;
  const s = layer.states[node];
  return !!s?.tags?.includes(tag);
}

// ---- T-194 validators ------------------------------------------------------

/**
 * Throw if any transition references a scope variable absent from `knownVars`.
 *
 * The two built-in namespaces — `csm.*` (cross-layer reads, validated in
 * `compileStateMachine`) and `state.*` (per-layer self-reads built by the
 * tick runner) — are skipped.
 *
 * Run at server boot from the system that owns the contributor list.
 * Catches typos like `healt.current` (missing 'h') before the actor's first
 * tick — without this the misspelled var would silently default to 0 and
 * the transition would never fire.
 */
export function validateStateMachineScope(
  compiled: CompiledStateMachine,
  knownVars: ReadonlySet<string>,
): void {
  const missing = new Set<string>();
  for (const v of compiled.referencedVars) {
    if (v.startsWith("csm.")) continue;
    if (v.startsWith("state.")) continue;
    if (!knownVars.has(v)) missing.add(v);
  }
  if (missing.size > 0) {
    const list = [...missing].sort().join(", ");
    throw new Error(
      `state machine '${compiled.id}': transition references unknown scope variable(s): ${list}. Add a contributor that emits them, or fix the typo.`,
    );
  }
}

/**
 * Collect every `$slotName` clip reference in the SM def — used for prefab
 * cross-validation: a prefab carrying this SM's `stateMachineId` must
 * declare `animationSlots[slotName]` for every slot returned here.
 *
 * Includes refs from `paramOverrides` (e.g. crouch-variant clip slot).
 */
export function collectSlotRefs(def: StateMachineDef): ReadonlySet<string> {
  const out = new Set<string>();
  const collect = (clip: string | null | undefined): void => {
    if (typeof clip === "string" && clip.startsWith("$")) out.add(clip.slice(1));
  };
  for (const layer of def.layers) {
    for (const state of Object.values(layer.states)) {
      collect(state.clip);
      if (state.paramOverrides) {
        for (const patch of Object.values(state.paramOverrides)) collect(patch.clip);
      }
    }
  }
  return out;
}

// ---- runtime state --------------------------------------------------------

/** Per-layer runtime state held on each actor. */
export interface SMLayerState {
  node: string;
  /** Seconds since this node was entered. */
  elapsed: number;
}

/** Runtime state for one actor's CSM. Map keyed by layer id. */
export type SMRuntimeState = Record<string, SMLayerState>;

/** A transition that fired during a tick, surfaced for consumers (e.g. payload lifecycle). */
export interface SMTransitionFired {
  layer: string;
  from: string;
  to: string;
}

// ---- compile --------------------------------------------------------------

export function compileStateMachine(def: StateMachineDef): CompiledStateMachine {
  const layers: CompiledLayer[] = [];
  const referencedVars = new Set<string>();

  for (const layer of def.layers) {
    if (!(layer.initial in layer.states)) {
      throw new Error(
        `state machine '${def.id}': layer '${layer.id}' initial '${layer.initial}' is not a state`,
      );
    }

    const states = new Map<string, CompiledState>();
    const layerTagsMut = new Set<string>();
    for (const [stateId, raw] of Object.entries(layer.states)) {
      const overrides: CompiledOverride[] = [];
      if (raw.paramOverrides) {
        for (const [condSrc, patch] of Object.entries(raw.paramOverrides)) {
          const cond = parseSMExpr(condSrc);
          for (const v of cond.vars) referencedVars.add(v);
          // duration $-ref inside a paramOverride patch is also a scope read.
          if (typeof patch.duration === "string" && patch.duration.startsWith("$")) {
            referencedVars.add(patch.duration.slice(1));
          }
          overrides.push({ cond, patch });
        }
      }
      // Top-level duration $-ref → scope var read at tick time via resolveDuration.
      if (typeof raw.duration === "string" && raw.duration.startsWith("$")) {
        referencedVars.add(raw.duration.slice(1));
      }
      const tags = new Set<string>(raw.tags ?? []);
      for (const t of tags) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) {
          throw new Error(
            `state machine '${def.id}': layer '${layer.id}' state '${stateId}' tag '${t}' is not a valid identifier (use snake_case, no hyphens)`,
          );
        }
        layerTagsMut.add(t);
      }
      states.set(stateId, { raw, overrides, tags });
    }

    const transitions: CompiledTransition[] = [];
    for (let i = 0; i < layer.transitions.length; i++) {
      const t = layer.transitions[i];
      if (!states.has(t.to)) {
        throw new Error(
          `state machine '${def.id}': layer '${layer.id}' transition references unknown target '${t.to}'`,
        );
      }
      const from = compileFrom(t.from, def.id, layer);
      const when = parseSMExpr(t.when);
      for (const v of when.vars) referencedVars.add(v);
      transitions.push({
        from,
        to: t.to,
        when,
        priority: t.priority ?? 0,
        declIndex: i,
      });
    }
    // Higher priority first, declaration order on tie.
    transitions.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.declIndex - b.declIndex;
    });

    layers.push({ raw: layer, states, transitions, layerTags: layerTagsMut });
  }

  // ── csm.* reference validation (T-194) ────────────────────────────────────
  // Every csm.<layer> reference must resolve to a real layer. The tagged form
  // csm.<layer>.<tag> must additionally name a tag declared on some state in
  // that layer — else the bool is permanently false and the typo silently
  // masks broken transitions.
  const layerById = new Map<string, CompiledLayer>();
  for (const l of layers) layerById.set(l.raw.id, l);
  for (const v of referencedVars) {
    if (!v.startsWith("csm.")) continue;
    const rest = v.slice(4);
    const dot = rest.indexOf(".");
    const layerId = dot < 0 ? rest : rest.slice(0, dot);
    const tagId = dot < 0 ? "" : rest.slice(dot + 1);
    const layer = layerById.get(layerId);
    if (!layer) {
      throw new Error(
        `state machine '${def.id}': transition references csm.${layerId} but no such layer exists`,
      );
    }
    if (tagId && !layer.layerTags.has(tagId)) {
      throw new Error(
        `state machine '${def.id}': transition references csm.${layerId}.${tagId} but no state in layer '${layerId}' declares the '${tagId}' tag`,
      );
    }
  }

  return { id: def.id, layers, referencedVars };
}

function compileFrom(from: SMTransition["from"], smId: string, layer: SMLayer): ReadonlySet<string> | "any" {
  if (from === undefined || from === "*") return "any";
  const list = typeof from === "string" ? [from] : from;
  for (const id of list) {
    if (!(id in layer.states)) {
      throw new Error(
        `state machine '${smId}': layer '${layer.id}' transition 'from' references unknown state '${id}'`,
      );
    }
  }
  return new Set(list);
}

// ---- initial state --------------------------------------------------------

export function initialSMState(compiled: CompiledStateMachine): SMRuntimeState {
  const out: SMRuntimeState = {};
  for (const layer of compiled.layers) {
    out[layer.raw.id] = { node: layer.raw.initial, elapsed: 0 };
  }
  return out;
}

// ---- effective state (paramOverrides resolved) ----------------------------

/**
 * Resolve a state's effective fields by applying any matching `paramOverrides`.
 * Used by both the runtime (for `state.duration` checks) and the projector
 * (for `clip` swaps). `csmScope` must include the cross-layer variables for
 * `csm.<layer>` reads (built by `buildCsmVars`).
 */
export function effectiveState(
  layer: CompiledLayer,
  stateId: string,
  baseScope: SMScope,
): SMState {
  const compiled = layer.states.get(stateId);
  if (!compiled) {
    throw new Error(`state machine: layer '${layer.raw.id}' has no state '${stateId}'`);
  }
  let result: SMState = compiled.raw;
  for (const ov of compiled.overrides) {
    if (evalSMExprBool(ov.cond, baseScope)) {
      result = { ...result, ...ov.patch };
    }
  }
  return result;
}

// ---- tick ----------------------------------------------------------------

/**
 * Advance one CSM tick.
 *
 * `prev` is the actor's previous-tick state. `scope` carries all caller-built
 * variables (component reads, event flags). `dtSeconds` advances elapsed.
 *
 * Returns the new state and the list of transitions that fired this tick
 * (consumers like ActionSystem watch these to manage payload-component
 * lifecycle, e.g. removing SwingContext when csm.combat exits swing.*).
 */
export function smTickAll(
  compiled: CompiledStateMachine,
  prev: SMRuntimeState,
  scope: SMScope,
  dtSeconds: number,
): { next: SMRuntimeState; fired: SMTransitionFired[] } {
  // Snapshot prior layer nodes for cross-layer reads. Every layer evaluates
  // its transitions against the SAME csm.* values (the start-of-tick view),
  // so layer order in JSON doesn't matter for correctness.
  const csmVars = buildCsmVars(compiled, prev);
  const baseScope: Record<string, SMScopeValue> = { ...scope, ...csmVars };

  const next: SMRuntimeState = {};
  const fired: SMTransitionFired[] = [];

  for (const layer of compiled.layers) {
    const layerId = layer.raw.id;
    const prevState = prev[layerId] ?? { node: layer.raw.initial, elapsed: 0 };

    // Build per-layer scope by adding state.elapsed / state.duration.
    const eff = effectiveState(layer, prevState.node, baseScope);
    const layerScope: Record<string, SMScopeValue> = {
      ...baseScope,
      "state.elapsed": prevState.elapsed,
      "state.duration": resolveDuration(eff.duration, baseScope),
    };

    // First matching transition wins (transitions are pre-sorted by priority).
    let chosen: CompiledTransition | null = null;
    for (const t of layer.transitions) {
      if (t.from !== "any" && !t.from.has(prevState.node)) continue;
      // Avoid no-op self-transitions when from is "any".
      if (t.to === prevState.node) continue;
      if (evalSMExprBool(t.when, layerScope)) {
        chosen = t;
        break;
      }
    }

    if (chosen) {
      next[layerId] = { node: chosen.to, elapsed: 0 };
      fired.push({ layer: layerId, from: prevState.node, to: chosen.to });
    } else {
      next[layerId] = { node: prevState.node, elapsed: prevState.elapsed + dtSeconds };
    }
  }

  return { next, fired };
}

/**
 * Build cross-layer scope variables from a runtime state.
 *
 * Emits two kinds of entry per layer:
 *   - `csm.<layer>` → current node name (string)
 *   - `csm.<layer>.<tag>` → true iff current node carries `tag`. One entry
 *     per distinct tag declared on any state in the layer, so transitions
 *     can reference them without throwing on the "not currently tagged" tick.
 */
export function buildCsmVars(
  compiled: CompiledStateMachine,
  state: SMRuntimeState,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const layer of compiled.layers) {
    const layerId = layer.raw.id;
    const ls = state[layerId];
    const node = ls?.node ?? layer.raw.initial;
    out[`csm.${layerId}`] = node;
    const stateTags = layer.states.get(node)?.tags ?? new Set<string>();
    for (const tag of layer.layerTags) {
      out[`csm.${layerId}.${tag}`] = stateTags.has(tag);
    }
  }
  return out;
}

/**
 * Resolve an SMState `duration` field to a number for `state.duration` lookups.
 * Numbers pass through; "$var" strings look up `var` in the scope (numeric
 * values only, others fall back to 0). Absent / non-numeric defaults to 0.
 */
export function resolveDuration(
  duration: number | string | undefined,
  scope: SMScope,
): number {
  if (typeof duration === "number") return duration;
  if (typeof duration !== "string") return 0;
  if (!duration.startsWith("$")) return 0;
  const v = scope[duration.slice(1)];
  return typeof v === "number" ? v : 0;
}
