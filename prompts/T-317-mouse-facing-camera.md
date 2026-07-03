# T-317 — The mouse-facing camera becomes THE camera (doctrine; run with OPUS)

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then the T-317 ticket body in
`TICKETS.md`. Required code reading before any edit:
`packages/client/src/render/camera_rig.ts` (whole file),
`packages/client/src/input/intent_translator.ts` (cursor→facing path + the camera-relative
movement basis), `renderer.ts`'s `getCursorWorldPos` and its `render(...)` frame loop
(where `localFacing` and `dt` live), and the minimap component in the client UI.

**Status of the decision:** the user evaluated a live prototype (2026-07-03) and adopted the
rotating camera as DOCTRINE. This is NOT a mode. The fixed-yaw camera is deleted, there is no
toggle, and no `useFollowCamera` flag of any kind (CLAUDE.md: refactors replace). Your job is
the correct, tuned, honest implementation.

## Goal

The camera keeps its exact rig geometry (back-distance, height, telephoto FOV, look-at bias)
but its yaw permanently follows the character's mouse-driven facing — smoothly, with a
deadzone, at a quality where aiming in combat never wobbles the world and committed turns
swing the camera naturally behind the player. Playability is part of correctness.

## The stability analysis — read this twice, it is the heart of the ticket

Facing today: derived **only on real mousemove events** — cursor pixel → ground-plane raycast
through the LIVE camera (`getCursorWorldPos`) → world point → `facing = atan2(toward point)`.
This event-driven, **world-pinned** semantics is LOAD-BEARING for stability. Two "obvious
improvements" both create endless spin — do not build either:

1. **Continuous re-derivation** (recompute facing from the static cursor pixel every frame):
   when the camera rotates by δ toward facing, the same pixel's ground intersection orbits
   the player by ≈δ (near-top-down rig) → facing advances by ≈δ → the yaw error NEVER
   shrinks → the world spins forever at chase speed.
2. **Screen-relative facing** (`facing := cameraYaw + screenAngle(cursor)`): the camera
   chases facing, facing re-derives to stay the same screen-angle ahead → the only
   equilibrium is cursor-at-screen-up; holding the cursor anywhere else spins forever.

Therefore the design is:

- **Facing keeps its exact current semantics** — updated on mousemove only, world-pinned,
  raw, never smoothed, never touched by camera logic. It is gameplay state (it goes on the
  wire); the camera is presentation that CHASES it.
- **The camera chases with deadzone + hysteresis + damping:** engage the chase only when the
  shortest-arc yaw error exceeds an OUTER threshold (start ~20°); chase with a
  critically-damped spring (half-life ~0.15–0.25 s) capped at a max angular rate
  (~180°/s); disengage when the error falls below an INNER threshold (~4°). Hysteresis
  prevents boundary twitch. Micro-aiming on an enemy lives inside the deadzone → the world
  holds still; a committed cursor flick crosses the outer threshold → the camera swings
  behind the new heading and settles.
- **Accepted consequence (by design):** after a camera swing settles, the on-screen cursor no
  longer overlays the pinned aim point until the next hand movement re-pins it. In practice
  combat aiming keeps the cursor ON the target (the pin is world-anchored), so facing stays
  correct straight through rotations. Do not "fix" this with continuous re-derivation — see
  above.

## Implementation decisions (made — implement, don't re-litigate)

1. **Rig:** `CameraRig` gains a yaw-follow controller (`setFacingTarget(facing|null)` fed the
   LOCAL player's predicted facing each frame — the renderer already receives `localFacing`;
   use the prediction, not the server echo, or your own turns lag). `DEFAULT_YAW` survives
   only as the boot value before the first facing exists (join screen, pre-spawn).
2. **Tuning lives in game_config** (ContentStore doctrine, no hardcoded feel numbers):
   `camera: { followHalfLife, maxTurnRateDeg, deadzoneOuterDeg, deadzoneInnerDeg }` — typed
   on GameConfig, carried in `data/game_config.json`, read via the client's content path.
   Current-behaviour reproduction is NOT required (the fixed camera is dead), but the
   defaults must ship at the tuned-good values you verify, not placeholders.
3. **dt plumbing:** `rig.update(targetPos)` becomes `update(targetPos, dt)`. The frame loop
   computes `dt` LATE (near the dust-motes update) — hoist the `dt`/`lastFrameMs` computation
   above the camera update (a naive insertion hits TS2448 use-before-declaration; the hoist
   is the fix, don't duplicate the computation).
4. **Movement under rotation:** `intent_translator` already queries `getCameraYaw()` per
   input frame, so held-W curves with the camera — that is intended third-person behaviour.
   Verify it feels continuous during a swing (no basis snapping), and rewrite the comments
   that promise a fixed yaw ("Diablo/PoE muscle memory on a fixed-yaw camera",
   "fixed top-down rig").
5. **Minimap stays north-up and gains a heading indicator** (a small view-cone or arrow
   rotating with camera yaw) so orientation survives rotation. Follow the minimap's existing
   drawing pattern; no map rotation in this ticket.
6. **Comment-honesty sweep in the same commit that makes yaw dynamic:** `camera_rig.ts`
   header ("Yaw is fixed (no mouse control) — the world has stable cardinal directions"),
   `renderer.ts` `getCursorWorldPos` doc ("shouldn't happen for the fixed iso camera"),
   `intent_translator` basis comments, and any further `grep -rn "fixed iso\|fixed-yaw\|fixed yaw" packages/client` hits.
7. **Consumers: verify, don't rebuild.** Shadow-frustum follow/snap in
   `environment_lighting.ts`, canopy_fade, dust motes, water shader, EdgePass, nameplate
   projection, hover/interaction raycasts — all should be camera-generic through three.js
   matrices; confirm visually under rotation. Chunk/prop culling is a player-centred ±4-chunk
   box (camera-independent) — fine by construction, leave it.
8. **Zero wire/server changes.** The camera is per-client presentation. Remote players are
   unaffected. If you find yourself editing anything under `packages/tile-server` or
   `packages/protocol`, stop — you've left the ticket.

## Suggested commit sequence

1. `client+content`: follow controller (spring/deadzone/hysteresis/max-rate) + game_config
   knobs + dt hoist + comment-honesty sweep + DEFAULT_YAW demoted to boot value. The fixed
   behaviour is GONE in this commit.
2. `client`: minimap heading indicator.
3. Tuning pass: pick defaults via real-input testing (below), record the chosen values and
   the feel rationale in the commit body.
4. Close: T-317 → done + commit hash; delete `prompts/T-317-mouse-facing-camera.md` in the
   closing commit (scaffolding dies with the work).

## Verification (real input required — testInput can't do this)

The testplay harness drives `testInput` (IntentTranslator), which bypasses real mousemove and
window key events — it CANNOT exercise the cursor→facing→camera loop. Verify with a one-off
Playwright script instead (pattern: auth against the gateway exactly like
`scripts/testplay.mjs` does, inject the token, join, then use `page.mouse.move(...)` for real
mousemoves and `page.screenshot(...)`; run it from the repo root so `playwright` resolves).
Assert, not just screenshot:

- **Deadzone holds:** small circular mouse motion around a fixed world target → camera yaw
  (read it via `page.evaluate` — expose a debug getter on `_voxim_game` if none reaches the
  rig) changes < 1° over several seconds.
- **Committed turn settles:** a hard cursor flick ~150° → yaw converges to within the inner
  threshold of the new facing and STOPS (sample yaw over 3 s; no residual creep — creep means
  you built feedback-loop variant 1 after all).
- **Two-heading screenshots** for the user's eyes, same spot, visibly rotated world, HUD sane.
- Type-check matrix + client tests + full suite green; bundle rebuilt; no console errors in
  the correlated logs while rotating.
