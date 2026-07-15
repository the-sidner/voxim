/**
 * Readable i-frame flash (T-298) — pure unit test of `computeIframeFlash`.
 */
import { assertEquals } from "jsr:@std/assert";
import type { ActionDef } from "@voxim/content";
import type { ActiveActionsData } from "@voxim/codecs";
import { computeIframeFlash } from "./iframe_flash.ts";

const DODGE_ROLL: Partial<ActionDef> = {
  id: "dodge_roll",
  phases: { dash: { ticks: 5 } },
};

function getAction(id: string): ActionDef | undefined {
  return id === "dodge_roll" ? (DODGE_ROLL as ActionDef) : undefined;
}

function locomotion(actionId: string, phase: string, ticksInPhase: number): ActiveActionsData {
  return { states: { locomotion: { actionId, phase, ticksInPhase, initiator: "intent" } } };
}

Deno.test("iframe flash: peaks at the start of the dash phase", () => {
  assertEquals(computeIframeFlash(locomotion("dodge_roll", "dash", 0), getAction), 1);
});

Deno.test("iframe flash: fades linearly across the phase's own ticks", () => {
  assertEquals(computeIframeFlash(locomotion("dodge_roll", "dash", 1), getAction), 1 - 1 / 5);
  assertEquals(computeIframeFlash(locomotion("dodge_roll", "dash", 4), getAction), 1 - 4 / 5);
});

Deno.test("iframe flash: 0 when not dodging", () => {
  assertEquals(computeIframeFlash(locomotion("idle", "hold", 0), getAction), 0);
  assertEquals(computeIframeFlash(null, getAction), 0);
});

Deno.test("iframe flash: 0 outside the dash phase (e.g. a future multi-phase dodge)", () => {
  assertEquals(computeIframeFlash(locomotion("dodge_roll", "recover", 0), getAction), 0);
});
