/**
 * T-335 — the keyboard-binding guard.
 *
 * The bug: crouch was bound to Ctrl, so crouch-walking forward (Ctrl+W) was the
 * browser's "close tab" chord. A page cannot preventDefault a reserved chord, so
 * no amount of client-side handling could have saved it — the only fix is to
 * never bind a modifier. These tests are the fix: they make the class of bug
 * unrepresentable in content rather than fixing the one instance of it.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { JsonSource, validateInputBindings } from "./loader.ts";
import type { GameConfig } from "./types.ts";

function cfg(bindings: Record<string, string[]>): GameConfig {
  return { input: { bindings } } as unknown as GameConfig;
}

Deno.test("validateInputBindings rejects every modifier key", () => {
  for (const code of ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]) {
    assertThrows(
      () => validateInputBindings(cfg({ crouch: [code] })),
      Error,
      "browser-reserved",
      `binding crouch to ${code} must be refused — it turns every movement key into a browser chord`,
    );
  }
});

Deno.test("validateInputBindings rejects Tab and the F-keys", () => {
  for (const code of ["Tab", "F1", "F5", "F12"]) {
    assertThrows(() => validateInputBindings(cfg({ jump: [code] })), Error, "browser-reserved");
  }
});

Deno.test("validateInputBindings rejects a code bound to two actions", () => {
  assertThrows(
    () => validateInputBindings(cfg({ crouch: ["KeyC"], consume: ["KeyC"] })),
    Error,
    "bound to both",
  );
});

Deno.test("validateInputBindings rejects an empty binding list", () => {
  assertThrows(() => validateInputBindings(cfg({ jump: [] })), Error, "non-empty");
});

Deno.test("validateInputBindings accepts plain keys", () => {
  validateInputBindings(cfg({
    moveForward: ["KeyW", "ArrowUp"],
    crouch: ["KeyC"],
    consume: ["KeyQ"],
  }));
});

Deno.test("the shipped game_config binds no browser-reserved key", async () => {
  const content = await JsonSource.load();
  const bindings = content.getGameConfig().input.bindings;
  // Loading already runs the validator (it would have thrown), so this asserts
  // the shipped content actually HAS bindings and that crouch left Ctrl.
  assertEquals(bindings.crouch, ["KeyC"]);
  const allCodes = Object.values(bindings).flat();
  assertEquals(allCodes.some((c) => c.startsWith("Control")), false);
});
