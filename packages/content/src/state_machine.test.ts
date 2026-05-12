import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  parseSMExpr,
  evalSMExpr,
  evalSMExprBool,
  checkSMVars,
} from "./sm_expression.ts";
import {
  compileStateMachine,
  initialSMState,
  smTickAll,
  buildCsmVars,
  effectiveState,
  validateStateMachineScope,
  collectSlotRefs,
} from "./state_machine.ts";
import type { StateMachineDef } from "./types.ts";

// ============================================================================
// sm_expression
// ============================================================================

Deno.test("sm_expression: numeric literals + arithmetic", () => {
  assertEquals(evalSMExpr(parseSMExpr("1 + 2"), {}),     3);
  assertEquals(evalSMExpr(parseSMExpr("3 * 4 - 5"), {}), 7);
  assertEquals(evalSMExpr(parseSMExpr("(1 + 2) * 3"), {}), 9);
  assertEquals(evalSMExpr(parseSMExpr("10 / 4"), {}),    2.5);
  assertEquals(evalSMExpr(parseSMExpr("-5 + 3"), {}),   -2);
});

Deno.test("sm_expression: bool literals", () => {
  assertEquals(evalSMExpr(parseSMExpr("true"), {}),  true);
  assertEquals(evalSMExpr(parseSMExpr("false"), {}), false);
  assertEquals(evalSMExpr(parseSMExpr("!true"), {}),  false);
  assertEquals(evalSMExpr(parseSMExpr("!false"), {}), true);
});

Deno.test("sm_expression: dotted variable lookup", () => {
  assertEquals(
    evalSMExpr(parseSMExpr("vel.mag > 4"), { "vel.mag": 5 }),
    true,
  );
  assertEquals(
    evalSMExpr(parseSMExpr("vel.mag > 4"), { "vel.mag": 3 }),
    false,
  );
});

Deno.test("sm_expression: bare ident is a string literal in equality", () => {
  // "crouched" is bare → string literal. csm.posture is dotted → variable.
  assertEquals(
    evalSMExpr(parseSMExpr("csm.posture == crouched"), { "csm.posture": "crouched" }),
    true,
  );
  assertEquals(
    evalSMExpr(parseSMExpr("csm.posture == crouched"), { "csm.posture": "upright" }),
    false,
  );
  assertEquals(
    evalSMExpr(parseSMExpr("csm.posture != crouched"), { "csm.posture": "upright" }),
    true,
  );
});

Deno.test("sm_expression: && and || short-circuit", () => {
  // Right side has an undefined var; short-circuit must skip it.
  assertEquals(
    evalSMExprBool(parseSMExpr("false && missing.var"), {}),
    false,
  );
  assertEquals(
    evalSMExprBool(parseSMExpr("true || missing.var"), {}),
    true,
  );
});

Deno.test("sm_expression: composite expression typical of CSM transitions", () => {
  const expr = parseSMExpr("vel.mag > 4 && csm.posture != crouched");
  assertEquals(
    evalSMExprBool(expr, { "vel.mag": 5, "csm.posture": "upright" }),
    true,
  );
  assertEquals(
    evalSMExprBool(expr, { "vel.mag": 5, "csm.posture": "crouched" }),
    false,
  );
  assertEquals(
    evalSMExprBool(expr, { "vel.mag": 1, "csm.posture": "upright" }),
    false,
  );
});

Deno.test("sm_expression: undefined dotted var throws", () => {
  assertThrows(
    () => evalSMExpr(parseSMExpr("missing.var"), {}),
    Error,
    "undefined variable 'missing.var'",
  );
});

Deno.test("sm_expression: comparison precedence binds tighter than logical", () => {
  // (vel.mag > 4) && (state.elapsed > 0.05)
  const expr = parseSMExpr("vel.mag > 4 && state.elapsed > 0.05");
  assertEquals(
    evalSMExprBool(expr, { "vel.mag": 5, "state.elapsed": 0.1 }),
    true,
  );
  assertEquals(
    evalSMExprBool(expr, { "vel.mag": 5, "state.elapsed": 0.0 }),
    false,
  );
});

Deno.test("sm_expression: checkSMVars finds missing", () => {
  const expr = parseSMExpr("vel.mag > 4 && input.dodge");
  const known = new Set(["vel.mag"]);
  assertEquals([...checkSMVars(expr, known)], ["input.dodge"]);
});

// ============================================================================
// state machine runtime
// ============================================================================

function tinyLocomotionSM(): StateMachineDef {
  return {
    id: "tiny",
    layers: [
      {
        id: "posture",
        kind: "posture",
        output: "flag",
        initial: "upright",
        states: { upright: {}, crouched: {} },
        transitions: [
          { to: "crouched", when: "input.crouch" },
          { to: "upright",  when: "!input.crouch" },
        ],
      },
      {
        id: "locomotion",
        kind: "base-locomotion",
        output: "animation",
        mask: "lower_body",
        initial: "idle",
        states: {
          idle: { clip: "$idle", loop: true },
          walk: { clip: "$walk", loop: true },
          run:  { clip: "$run",  loop: true },
          roll: { clip: "$roll", duration: 0.6, rotateRoot: "velocity.dir" },
        },
        transitions: [
          { to: "roll", when: "input.dodge && state.elapsed > 0.05", priority: 10 },
          { from: "roll", to: "idle", when: "state.elapsed >= state.duration" },
          { to: "run",  when: "vel.mag > 4 && csm.posture != crouched" },
          { to: "walk", when: "vel.mag > 0.5" },
          { to: "idle", when: "vel.mag < 0.2" },
        ],
      },
    ],
  };
}

Deno.test("state machine: compile validates initial and transition targets", () => {
  assertThrows(
    () =>
      compileStateMachine({
        id: "bad",
        layers: [{
          id: "x", kind: "flag", output: "flag", initial: "ghost", states: { real: {} }, transitions: [],
        }],
      }),
    Error,
    "initial 'ghost' is not a state",
  );

  assertThrows(
    () =>
      compileStateMachine({
        id: "bad",
        layers: [{
          id: "x", kind: "flag", output: "flag", initial: "real", states: { real: {} },
          transitions: [{ to: "ghost", when: "true" }],
        }],
      }),
    Error,
    "unknown target 'ghost'",
  );

  assertThrows(
    () =>
      compileStateMachine({
        id: "bad",
        layers: [{
          id: "x", kind: "flag", output: "flag", initial: "real", states: { real: {} },
          transitions: [{ from: "ghost", to: "real", when: "true" }],
        }],
      }),
    Error,
    "unknown state 'ghost'",
  );
});

Deno.test("state machine: initial state populates every layer", () => {
  const csm = compileStateMachine(tinyLocomotionSM());
  const init = initialSMState(csm);
  assertEquals(init.posture.node, "upright");
  assertEquals(init.posture.elapsed, 0);
  assertEquals(init.locomotion.node, "idle");
});

Deno.test("state machine: idle elapsed advances", () => {
  const csm = compileStateMachine(tinyLocomotionSM());
  const s0 = initialSMState(csm);
  const { next } = smTickAll(csm, s0, {
    "vel.mag": 0,
    "input.crouch": false,
    "input.dodge": false,
  }, 0.05);
  assertEquals(next.locomotion.node, "idle");
  assertEquals(next.locomotion.elapsed, 0.05);
});

Deno.test("state machine: vel triggers walk → run", () => {
  const csm = compileStateMachine(tinyLocomotionSM());
  let s = initialSMState(csm);

  // walking
  ({ next: s } = smTickAll(csm, s, {
    "vel.mag": 1, "input.crouch": false, "input.dodge": false,
  }, 0.05));
  assertEquals(s.locomotion.node, "walk");

  // run kicks in
  ({ next: s } = smTickAll(csm, s, {
    "vel.mag": 5, "input.crouch": false, "input.dodge": false,
  }, 0.05));
  assertEquals(s.locomotion.node, "run");

  // crouch suppresses run via cross-layer read
  ({ next: s } = smTickAll(csm, s, {
    "vel.mag": 5, "input.crouch": true, "input.dodge": false,
  }, 0.05));
  // posture flips to crouched THIS tick, but locomotion's transition reads the
  // start-of-tick csm.posture (still 'upright') so it stays 'run'. Next tick
  // it should drop back to walk.
  assertEquals(s.posture.node, "crouched");
  ({ next: s } = smTickAll(csm, s, {
    "vel.mag": 5, "input.crouch": true, "input.dodge": false,
  }, 0.05));
  assertEquals(s.locomotion.node, "walk");
});

Deno.test("state machine: priority and exit-by-duration", () => {
  const csm = compileStateMachine(tinyLocomotionSM());
  let s = initialSMState(csm);

  // Tick once with vel.mag=0 so locomotion stays idle. This clears the
  // `state.elapsed > 0.05` gate that protects against same-tick dodge.
  ({ next: s } = smTickAll(csm, s, {
    "vel.mag": 0, "input.crouch": false, "input.dodge": false,
  }, 0.06));
  assertEquals(s.locomotion.node, "idle");
  assertEquals(s.locomotion.elapsed, 0.06);

  // Now dodge — priority-10 roll wins even though vel.mag would otherwise
  // select 'walk'.
  ({ next: s } = smTickAll(csm, s, {
    "vel.mag": 1, "input.crouch": false, "input.dodge": true,
  }, 0.05));
  assertEquals(s.locomotion.node, "roll");

  // Roll has duration 0.6. Tick past it; should auto-exit to idle.
  for (let i = 0; i < 13; i++) {
    ({ next: s } = smTickAll(csm, s, {
      "vel.mag": 0, "input.crouch": false, "input.dodge": false,
    }, 0.05));
  }
  assertEquals(s.locomotion.node, "idle");
});

Deno.test("state machine: paramOverrides swap effective fields", () => {
  const csm = compileStateMachine({
    id: "ov",
    layers: [
      {
        id: "posture", kind: "posture", output: "flag", initial: "upright",
        states: { upright: {}, crouched: {} },
        transitions: [
          { to: "crouched", when: "input.crouch" },
          { to: "upright",  when: "!input.crouch" },
        ],
      },
      {
        id: "locomotion", kind: "base-locomotion", output: "animation", initial: "idle",
        states: {
          idle: {
            clip: "$idle", loop: true,
            paramOverrides: {
              "csm.posture == crouched": { clip: "$crouch_idle" },
            },
          },
        },
        transitions: [],
      },
    ],
  });

  const layer = csm.layers[1];
  // upright → base clip
  const a = effectiveState(layer, "idle", { ...buildCsmVars(csm, { posture: { node: "upright", elapsed: 0 } }) });
  assertEquals(a.clip, "$idle");
  // crouched → override clip
  const b = effectiveState(layer, "idle", { ...buildCsmVars(csm, { posture: { node: "crouched", elapsed: 0 } }) });
  assertEquals(b.clip, "$crouch_idle");
});

Deno.test("state machine: fired transitions are reported", () => {
  const csm = compileStateMachine(tinyLocomotionSM());
  let s = initialSMState(csm);
  const tick1 = smTickAll(csm, s, {
    "vel.mag": 1, "input.crouch": false, "input.dodge": false,
  }, 0.05);
  s = tick1.next;
  // posture stays upright (no transition since it was already upright via the
  // initial state — `to: upright when: !input.crouch` is suppressed by the
  // self-transition guard). locomotion fires idle → walk.
  assertEquals(tick1.fired.length, 1);
  assertEquals(tick1.fired[0].layer, "locomotion");
  assertEquals(tick1.fired[0].from, "idle");
  assertEquals(tick1.fired[0].to, "walk");
});

Deno.test("state machine: from as array allows-list", () => {
  const csm = compileStateMachine({
    id: "arr",
    layers: [{
      id: "x", kind: "flag", output: "flag", initial: "a",
      states: { a: {}, b: {}, c: {} },
      transitions: [
        { from: ["a", "b"], to: "c", when: "input.go" },
      ],
    }],
  });
  let s = initialSMState(csm);
  // From a → c works.
  ({ next: s } = smTickAll(csm, s, { "input.go": true }, 0.01));
  assertEquals(s.x.node, "c");
  // From c → c is excluded by transition `from`, so nothing fires.
  ({ next: s } = smTickAll(csm, s, { "input.go": true }, 0.01));
  assertEquals(s.x.node, "c");
});

// ============================================================================
// T-194 — compile-time validation
// ============================================================================

Deno.test("T-194: compile rejects csm.<unknown_layer> reference", () => {
  assertThrows(
    () =>
      compileStateMachine({
        id: "bad",
        layers: [{
          id: "locomotion", kind: "base-locomotion", output: "animation", initial: "idle",
          states: { idle: { clip: "$idle" } },
          // typo: "postur" instead of "posture" — no such layer
          transitions: [{ to: "idle", when: "csm.postur == crouched" }],
        }],
      }),
    Error,
    "csm.postur but no such layer exists",
  );
});

Deno.test("T-194: compile rejects csm.<layer>.<unknown_tag> reference", () => {
  assertThrows(
    () =>
      compileStateMachine({
        id: "bad",
        layers: [
          {
            id: "right_hand", kind: "action", output: "animation", initial: "idle",
            states: {
              idle: { clip: null },
              swing: { clip: "$weapon", tags: ["action"] },
            },
            transitions: [{ from: "idle", to: "swing", when: "true" }],
          },
          {
            id: "x", kind: "flag", output: "flag", initial: "a",
            states: { a: {}, b: {} },
            // typo: "actoin" vs "action"
            transitions: [{ from: "a", to: "b", when: "csm.right_hand.actoin" }],
          },
        ],
      }),
    Error,
    "csm.right_hand.actoin but no state in layer 'right_hand' declares the 'actoin' tag",
  );
});

Deno.test("T-194: csm.<layer>.<declared_tag> compiles cleanly", () => {
  // Smoke test the positive path.
  const csm = compileStateMachine({
    id: "ok",
    layers: [
      {
        id: "right_hand", kind: "action", output: "animation", initial: "idle",
        states: {
          idle: { clip: null },
          swing: { clip: "$weapon", tags: ["action", "active_hitbox"] },
        },
        transitions: [{ from: "idle", to: "swing", when: "true" }],
      },
      {
        id: "x", kind: "flag", output: "flag", initial: "a",
        states: { a: {}, b: {} },
        transitions: [{ from: "a", to: "b", when: "csm.right_hand.active_hitbox" }],
      },
    ],
  });
  assertEquals(csm.id, "ok");
});

Deno.test("T-194: validateStateMachineScope rejects unknown scope var", () => {
  const csm = compileStateMachine({
    id: "scope",
    layers: [{
      id: "x", kind: "flag", output: "flag", initial: "a",
      states: { a: {}, b: {} },
      // typo: "healt" vs "health"
      transitions: [{ from: "a", to: "b", when: "healt.current < 10" }],
    }],
  });
  const known = new Set(["health.current", "health.max", "vel.mag"]);
  assertThrows(
    () => validateStateMachineScope(csm, known),
    Error,
    "unknown scope variable",
  );
});

Deno.test("T-194: validateStateMachineScope ignores csm.* and state.*", () => {
  const csm = compileStateMachine({
    id: "ok",
    layers: [
      { id: "p", kind: "posture", output: "flag", initial: "up", states: { up: {}, dn: {} }, transitions: [] },
      {
        id: "x", kind: "flag", output: "flag", initial: "a",
        states: { a: { duration: 1 }, b: {} },
        transitions: [
          { from: "a", to: "b", when: "state.elapsed >= state.duration && csm.p == up" },
        ],
      },
    ],
  });
  // No `known` vars — but state.* and csm.* are built-in, so this should pass.
  validateStateMachineScope(csm, new Set());
});

Deno.test("T-194: validateStateMachineScope catches typos in duration $-refs", () => {
  // Duration strings like "$action.active_seconds" are scope lookups too.
  const csm = compileStateMachine({
    id: "dur",
    layers: [{
      id: "x", kind: "action", output: "animation", initial: "idle",
      states: {
        idle: { clip: null },
        // typo: actoin vs action
        active: { clip: "$weapon", duration: "$actoin.active_seconds" },
      },
      transitions: [{ from: "idle", to: "active", when: "true" }],
    }],
  });
  const known = new Set([
    "action.windup_seconds", "action.active_seconds", "action.winddown_seconds",
  ]);
  assertThrows(
    () => validateStateMachineScope(csm, known),
    Error,
    "actoin.active_seconds",
  );
});

Deno.test("T-194: collectSlotRefs returns every $slotName used in clips + paramOverrides", () => {
  const def: StateMachineDef = {
    id: "slots",
    layers: [{
      id: "loc", kind: "base-locomotion", output: "animation", initial: "idle",
      states: {
        idle: {
          clip: "$idle",
          paramOverrides: { "csm.p == crouched": { clip: "$crouch_idle" } },
        },
        walk: { clip: "$walk_forward" },
        // raw clip (no $) is not a slot ref
        custom: { clip: "explicit_clip_id" },
      },
      transitions: [],
    }],
  };
  const slots = collectSlotRefs(def);
  assertEquals([...slots].sort(), ["crouch_idle", "idle", "walk_forward"]);
});
