# T-320 — Controller-native camera + control rework (free-look, movement-facing, soft aim-assist)

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then the T-320 ticket body in `TICKETS.md`.
Required code reading before any edit (all anchors verified at HEAD by the orchestrator; re-verify):
- `packages/client/src/render/camera_rig.ts` (whole file — the T-317 chase controller you REPLACE)
- `packages/client/src/input/intent_translator.ts` (`_facing`, `getCursorFacing`, `getCameraYaw`,
  the datagram `facing` field, the camera-relative movement basis, the existing RMB-down flag)
- `packages/client/src/render/renderer.ts` `getCursorWorldPos` / `getCursorFacing`, and where
  `render(...)` feeds `localFacing`
- the interaction path: `packages/client/src/interaction/{interaction_system,interactable_handlers}.ts`,
  `packages/client/src/render/hover_outline.ts`, `hoverState` in `input/context.ts`, and
  `game.ts`'s `_nearestGroundItem` + the `CommandType.UseEntity` sends (the proximity substrate)
- the combat resolver: `packages/tile-server/src/actions/resolvers/combat.ts` +
  `packages/tile-server/src/combat/hit_resolver.ts` (where the swing sweep runs) and how
  `physics.ts` writes `Facing` from `InputState.facing`
- `game_config.json` `camera.*` (T-317 left backDistance/heightAbove/lookAtBias/fovDeg + the now-
  removable follow knobs followHalfLife/maxTurnRateDeg/deadzoneOuterDeg/deadzoneInnerDeg)

**Status of the decision (do not re-litigate):** the user played T-317 and adopted a
controller-native Witcher/Souls scheme. **Free-look under POINTER LOCK. Soft AIM-ASSIST, no hard
lock-on in v1.** This REPLACES T-317 — its chase controller and cursor-facing raycast are deleted
(CLAUDE.md: refactors replace; no toggle, no `useOldCamera` flag). Your job is the correct, tuned,
honest implementation.

## The four coupled changes

### 1. Camera = direct rotation + clamped pitch (client)
- Rig **yaw** is driven directly by accumulated mouse-X delta under pointer lock (and would map to
  a pad right-stick — leave a clean seam, but v1 input is mouse). DELETE the entire T-317 follow
  controller: `setFacingTarget`, the deadzone/inner/outer/hysteresis state, the critically-damped
  spring + max-rate step, `DEFAULT_YAW`-as-boot-only comment stays only as the pre-input seed.
- Add a **pitch** axis: mouse-Y delta → pitch, CLAMPED to a narrow band around the shipped gaze
  (the geometry today yields ~55° below horizontal; allow a small ± pan, e.g. game_config
  `camera.pitchMinDeg`/`pitchMaxDeg` around a `camera.pitchRestDeg`). The rig recomputes its
  look-at / height from (yaw, pitch, geometry) each frame. Keep the no-horizon telephoto property:
  the clamp must not let the horizon flood in (that reopens fog/draw-distance issues) — keep the
  band small and say so in a comment.
- **Pointer lock**: clicking the canvas calls `requestPointerLock()`; Esc or opening any menu
  (Inventory/Equipment/Stats/etc.) calls `exitPointerLock()` and the cursor returns for UI; closing
  the menu / clicking the canvas re-locks. Read mouse deltas from `movementX`/`movementY` while
  locked. Handle the `pointerlockchange`/`pointerlockerror` events. Respect a paused/unlocked state
  (no rotation when unlocked).
- Knobs in game_config `camera.*` (ContentStore doctrine): `mouseSensitivity`, `invertY`,
  `pitchRestDeg`, `pitchMinDeg`, `pitchMaxDeg`. Repurpose the freed follow-knob slots; remove the
  dead deadzone/spring knobs from the schema + JSON.

### 2. Facing = movement direction, not the cursor (client → wire)
- Facing stops being cursor-derived. DELETE `getCursorFacing` and the cursor→ground raycast used
  for facing (check whether `getCursorWorldPos` has any OTHER consumer before removing it — build
  ghost placement may use it; keep it only for a live non-facing consumer). The datagram `facing`
  now carries the **camera-relative movement direction** while moving (the WASD intent already
  rotated by `getCameraYaw()`), and HOLDS the last facing when there is no move input. Idle never
  snaps facing to a default.
- The local body prediction (`renderer.render`'s `localFacing`) reads this same value so the
  player's body turns to where they move without a server round-trip.
- This is the load-bearing inversion: no cursor ⇒ no cursor→facing→camera feedback loop, so the
  camera yaw can be direct without the T-317 spin pathology.

### 3. Soft aim-assist (server-authoritative)
- On the active tick of a melee/skill attack, BEFORE the sweep, pick the best target: the enemy
  minimizing a cost of (distance, angular offset from the actor's current facing) within a max
  range and a frontal half-angle cone (config: reuse/add `combat`/`camera` knobs, e.g.
  `aimAssistRangeUnits`, `aimAssistHalfAngleDeg`). Orient the swing — and set the actor's `Facing`
  — toward that target for the active phase. If no target in cone, swing straight ahead (current
  facing), unchanged.
- Lives SERVER-SIDE (authoritative, identical for mouse and pad) in the combat resolver path
  (`resolvers/combat.ts` / `hit_resolver.ts`). It reads entity positions it already has; **no new
  wire field**. Query enemies via the existing spatial/world query (respect the no-`isNpc`-branch
  doctrine — target by team/hostility data, not a type switch).
- This is the highest-value UNIT TEST of the ticket: spawn 3 enemies at different angles/distances,
  begin an attack facing roughly between them, assert the swing/Facing orients to the best one, and
  that an enemy outside the cone is NOT chosen. Deterministic, no live stack.

### 4. Interaction = proximity + Use key (client)
- Cursor hover→click is gone. Generalize the existing `_nearestGroundItem` proximity pattern +
  `hoverState` into a **nearest-interactable** selector: each frame, pick the closest interactable
  (trader/workstation/POI-action/lever/ground-item) within its range, drive the existing hover
  outline + prompt off THAT (not a cursor raycast), and a Use key sends the existing
  `CommandType.UseEntity` (or PickUp for ground items) for the selected one. Preserve every
  existing interaction target kind — do not drop trader/workstation/T-212 action/puzzle-lever
  reachability. The E-key pickup fallback already does this for items; unify them.

## Doctrine / scope fences
- REPLACE, don't accrete: T-317's cursor-facing + chase controller code AND their doc comments are
  deleted in the same commits that add the new behaviour. Grep `cursor`/`getCursorFacing`/`deadzone`/
  `facing.*chase` across `packages/client` when done — no stragglers, no stale "mouse-facing" prose.
- **Zero new wire fields.** `facing` already exists; aim-assist is server-internal; interaction uses
  the existing `UseEntity`/`PickUp` commands. If you find yourself minting a ComponentType or command,
  stop — you've overreached.
- No hard lock-on, no target-cycling, no camera target-framing (that's a deliberate v1 cut — a
  possible T-321 follow-up; note it in the T-320 close, don't build it).
- Menus must still work: releasing pointer lock for the cursor when a panel opens is REQUIRED, not
  optional — verify Inventory/Equipment/Stats/Trade panels are still usable.

## Suggested commit sequence
1. `client+content`: camera rig → direct yaw + clamped pitch + pointer-lock engage/release +
   game_config knobs (drop the follow knobs); rig unit tests (yaw/pitch from injected deltas,
   pitch clamp). Camera rotates; facing still old for now if needed to keep it bisectable, else fold in 2.
2. `client`: facing = movement direction; delete cursor-facing raycast + its dead consumers; local
   prediction reads it.
3. `tile-server+content`: soft aim-assist in the combat resolver + the deterministic server unit test.
4. `client`: interaction → nearest-interactable proximity + Use key; hover outline repointed.
5. Debug hook (small) so the harness can inject camera-rotate deltas for a scene-probe check
   (e.g. a `_voxim_game.testInput.rotateCamera(dx,dy)` or a debug command) — needed because
   pointer-lock free-look can't be driven headless.
6. Close: T-320 → done + hashes; delete `prompts/T-320-controller-camera.md` in the closing commit;
   note the hard-lock-on v1 cut as a possible follow-up in the ticket body.

## Verification
Standard bar from ENVIRONMENT.md (type-check per commit, full suite, bundle rebuild). Additionally:
- Unit tests for the four logic pieces (rig yaw/pitch, facing=move-dir, **aim-assist target pick**,
  interaction nearest-pick) — these carry the correctness weight since the raw feel is un-headless.
- Scene-probe check via the debug rotate hook: inject a yaw sweep, read `cameraRig` yaw/pitch back,
  confirm the world rotates and pitch clamps; screenshot two headings.
- Server aim-assist: the deterministic multi-enemy test above, plus (best-effort) a live spawn+swing
  scene probe confirming the actor's Facing snapped toward the spawned enemy.
- In your final report, spell out exactly what remains a MANUAL user check (the pointer-lock free-
  look feel, menu-release round-trip, invert-Y/sensitivity taste) so the orchestrator can hand the
  user a precise "try this" list.
