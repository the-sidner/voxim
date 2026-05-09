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
}

interface CompiledLayer {
  raw: SMLayer;
  states: Map<string, CompiledState>;
  transitions: CompiledTransition[];
}

export interface CompiledStateMachine {
  id: string;
  layers: CompiledLayer[];
  /** All variable names referenced by any transition or override expression. */
  referencedVars: ReadonlySet<string>;
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
    for (const [stateId, raw] of Object.entries(layer.states)) {
      const overrides: CompiledOverride[] = [];
      if (raw.paramOverrides) {
        for (const [condSrc, patch] of Object.entries(raw.paramOverrides)) {
          const cond = parseSMExpr(condSrc);
          for (const v of cond.vars) referencedVars.add(v);
          overrides.push({ cond, patch });
        }
      }
      states.set(stateId, { raw, overrides });
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

    layers.push({ raw: layer, states, transitions });
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
  const csmVars = buildCsmVars(prev);
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

/** Build cross-layer `csm.<layer>` variables from a runtime state. */
export function buildCsmVars(state: SMRuntimeState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [layerId, ls] of Object.entries(state)) {
    out[`csm.${layerId}`] = ls.node;
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
