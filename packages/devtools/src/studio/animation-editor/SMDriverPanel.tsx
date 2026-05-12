/// <reference lib="dom" />
/**
 * State machine driver — Layer B. Picks a StateMachineDef, lets the
 * user toggle input bits + fire one-tick events, runs the engine's
 * compileStateMachine + smTickAll loop at 20Hz, and surfaces the live
 * layer node + elapsed per layer.
 *
 * `onState` bubbles the current layer-state map up to the editor so
 * it can drive the skeleton pose from the active animation-output
 * layer.
 *
 * Imports compile/tick from @voxim/content — pure data evaluator,
 * fine for Layer B.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  compileStateMachine,
  smTickAll,
  initialSMState,
  type CompiledStateMachine,
  type SMRuntimeState,
  type SMScopeValue,
} from "@voxim/content";
import type { StateMachineDef } from "../shell/content_loader.ts";

const TICK_HZ = 20;
const TICK_DT = 1 / TICK_HZ;

// Subset of scope vars users will commonly want to toggle / fire.
// Anything else the SM transitions reference defaults to false / 0.
const INPUT_KEYS = [
  "input.use_skill",
  "input.block",
  "input.jump",
  "input.dodge",
  "input.crouch",
  "input.aim",
  "input.skill_1",
  "input.skill_2",
] as const;

const EVENT_KEYS = [
  "event.swing_started",
  "event.shoot_fired",
  "event.left_ground",
  "event.landed",
  "event.hit",
  "event.hit.from_front",
  "event.hit.from_back",
  "event.stagger.light",
  "event.stagger.heavy",
  "event.maneuver_started",
  "event.maneuver_ended",
] as const;

export interface SMDriverHandle {
  state: SMRuntimeState;
}

export function SMDriverPanel({
  def,
  onTick,
  active,
}: {
  def: StateMachineDef | null;
  /** Called every SM tick with the latest layer-state map. */
  onTick: (state: SMRuntimeState, def: StateMachineDef) => void;
  /** Only drive the actor when this pane is active. */
  active: boolean;
}) {
  const compiled = useMemo<CompiledStateMachine | null>(() => {
    if (!def) return null;
    try {
      return compileStateMachine(def as unknown as Parameters<typeof compileStateMachine>[0]);
    } catch (e) {
      console.warn("sm driver: compile failed:", e);
      return null;
    }
  }, [def]);

  const [held, setHeld]     = useState<Set<string>>(new Set());
  const [oneshot, setOneshot] = useState<Set<string>>(new Set());
  const [state, setState]   = useState<SMRuntimeState>({});
  const [running, setRunning] = useState(true);

  // Reset SM state on def / compile change.
  useEffect(() => {
    if (!compiled) return;
    const init = initialSMState(compiled);
    setState(init);
  }, [compiled]);

  // Tick loop — only when pane is active and running.
  useEffect(() => {
    if (!active || !running || !compiled || !def) return;
    let cancelled = false;
    const tickOnce = () => {
      if (cancelled) return;
      setState((prev) => {
        const scope = buildScope(held, oneshot);
        const { next } = smTickAll(compiled, prev, scope, TICK_DT);
        onTick(next, def);
        return next;
      });
      // Drain one-shot events after one tick.
      if (oneshot.size > 0) setOneshot(new Set());
    };
    const id = setInterval(tickOnce, 1000 / TICK_HZ);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, running, compiled, def, held, oneshot, onTick]);

  const toggleHeld = (key: string) => {
    setHeld((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };
  const fireOneshot = (key: string) => {
    setOneshot((s) => new Set(s).add(key));
  };

  const reset = () => {
    if (!compiled) return;
    setState(initialSMState(compiled));
    setHeld(new Set());
    setOneshot(new Set());
  };

  if (!def) {
    return (
      <div style={{ padding: 12, color: "#888", fontSize: 11 }}>
        Pick a state machine from <code>state_machines/</code> in the asset browser.
      </div>
    );
  }

  return (
    <div style={{ padding: 12, fontSize: 11 }}>
      <div style={{ color: "#9fcfff", fontWeight: 600, marginBottom: 8 }}>{def.id}</div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <button onClick={() => setRunning((r) => !r)} style={btn(running ? "#2a5a8a" : undefined)}>
          {running ? "Pause" : "Run"}
        </button>
        <button onClick={reset} style={btn()}>Reset</button>
      </div>

      <div style={{ color: "#888", marginBottom: 4 }}>Layer states</div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "1px 8px",
        marginBottom: 12,
        background: "#0e0e12",
        padding: "6px 8px",
        borderRadius: 3,
      }}>
        {def.layers.map((layer) => {
          const s = state[layer.id];
          return (
            <>
              <span style={{ color: "#cfd0e0" }}>{layer.id}</span>
              <span style={{ color: "#88cc88" }}>
                {s?.node ?? layer.initial}
                <span style={{ color: "#666", marginLeft: 6 }}>{s ? `${s.elapsed.toFixed(2)}s` : "0.00s"}</span>
              </span>
            </>
          );
        })}
      </div>

      <div style={{ color: "#888", marginBottom: 4 }}>Inputs (held while pressed)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
        {INPUT_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => toggleHeld(key)}
            style={chip(held.has(key))}
          >{key.slice(6)}</button>
        ))}
      </div>

      <div style={{ color: "#888", marginBottom: 4 }}>Events (fire once → consumed next tick)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {EVENT_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => fireOneshot(key)}
            style={chip(oneshot.has(key))}
          >{key.slice(6)}</button>
        ))}
      </div>
    </div>
  );
}

function buildScope(held: Set<string>, oneshot: Set<string>): Record<string, SMScopeValue> {
  const scope: Record<string, SMScopeValue> = {};
  for (const key of INPUT_KEYS)  scope[key] = held.has(key);
  for (const key of EVENT_KEYS)  scope[key] = oneshot.has(key);
  // Sensible defaults so transitions reading these vars don't throw.
  scope["vel.mag"] = 0;
  scope["vel.forward"] = 0;
  scope["vel.strafe"] = 0;
  scope["vel.forward_abs"] = 0;
  scope["vel.strafe_abs"] = 0;
  scope["health.current"] = 100;
  scope["health.max"] = 100;
  scope["health.frac"] = 1;
  scope["physics.airborne"] = false;
  scope["weapon.has_block"] = true;
  scope["weapon.has_aim"]   = false;
  scope["equipped.weapon"]  = true;
  scope["action.windup_seconds"]   = 0.1;
  scope["action.active_seconds"]   = 0.1;
  scope["action.winddown_seconds"] = 0.2;
  return scope;
}

function btn(bg?: string) {
  return {
    padding: "4px 10px",
    background: bg ?? "#222226",
    color: "#fff",
    border: "1px solid #3a3a42",
    borderRadius: 3,
    cursor: "pointer",
    fontSize: 11,
  } as const;
}
function chip(active: boolean) {
  return {
    padding: "3px 8px",
    background: active ? "#2a5a8a" : "#222226",
    color: active ? "#fff" : "#aaa",
    border: `1px solid ${active ? "#4080c0" : "#3a3a42"}`,
    borderRadius: 3,
    cursor: "pointer",
    fontSize: 10,
  } as const;
}
