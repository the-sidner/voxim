# T-317 — Facing-follow camera mode (rotating iso look, evaluative)

Read `prompts/ENVIRONMENT.md` first, then `CLAUDE.md`, then the T-317 ticket body in
`TICKETS.md`. Required code reading before any edit: `packages/client/src/render/camera_rig.ts`
(whole file — it's small and documents the rig geometry), `packages/client/src/input/intent_translator.ts`
(the camera-relative basis + the cursor→facing path), and `renderer.ts`'s `getCursorWorldPos`.

**Depends / assumes landed:** nothing. Independent of the T-311/T-212 prompts. Verify anchors
against HEAD anyway.

## Goal

A runtime-toggleable camera mode where the rig keeps its exact geometry (back-distance,
height, telephoto FOV, look-at bias) but its yaw FOLLOWS the character's facing — so the user
can compare fixed-iso vs rotating-iso live and render a design verdict. Playable smoothness is
part of "done": no cursor-chase spin, no motion-sickness jerk.

## The one real hazard — the facing feedback loop

Facing is cursor-derived: `intent_translator` raycasts the cursor onto the ground **through
the live camera** on every mouse-move (`getCursorWorldPos` uses `raycaster.setFromCamera`).
If the camera chases facing raw, every camera rotation re-projects a stationary cursor to a
new world point, and the next mouse-move snaps facing to it → drift/spin. Decisions (made):

1. **Smoothing lives in the CAMERA, never in facing.** Gameplay facing (what the server gets,
   what the body renders with) stays raw and cursor-accurate. The camera runs a
   critically-damped spring toward `facing + FOLLOW_OFFSET` with shortest-arc wrapping and a
   max angular rate.
2. **Follow deadzone (PoE-style soft follow):** the camera only chases when the yaw error
   exceeds a threshold (start ~15–20°), easing until the error re-enters a smaller inner
   threshold (hysteresis, so it doesn't twitch at the boundary). With the deadzone, small
   cursor aiming never rotates the world; committed turns do.
3. **Knobs in `game_config`** (ContentStore, no hardcoded tuning): follow gain / spring
   half-life, max rate, outer+inner deadzone, follow offset, and the mode default. Current
   fixed behaviour must be exactly reproducible (gain 0 / mode "fixed").

## Implementation notes

- `CameraRig` already owns `yaw` (`DEFAULT_YAW = π/4`) and `intent_translator` reads
  `getCameraYaw()` each input frame — camera-relative movement keeps working under a rotating
  yaw by construction. Add `setYawTarget(...)`/mode state to the rig (or a small follow
  controller beside it); the renderer's per-frame update feeds it the LOCAL player's predicted
  facing (the client predicts local facing since T-287 — use that, not the last server echo,
  or the camera lags your own turn).
- **Toggle:** a debug-key toggle (follow the existing debug-key pattern — there's a Debug HUD
  panel) + the config default. Both modes must be switchable live mid-session.
- **Comment honesty (same commit as the dynamic yaw):** the codebase documents the fixed-yaw
  assumption in several places — `camera_rig.ts` header ("Yaw is fixed (no mouse control)"),
  `renderer.ts` `getCursorWorldPos` doc ("shouldn't happen for the fixed iso camera"),
  `intent_translator`'s basis comments ("fixed top-down rig"). Update them to describe both
  modes truthfully. Grep for further "fixed iso"/"fixed-yaw" claims.
- **Consumers to sanity-check, not rebuild:** canopy_fade (camera-position uniforms), dust
  motes, water/reflection, EdgePass — all should be camera-generic through three.js matrices;
  verify visually rather than assuming. Minimap stays north-up in v1 (say so in a comment).
- Keep the whole thing client-side. No wire changes, no server knowledge of camera mode.

## Suggested commit sequence

1. `client+content`: dynamic yaw on the rig + follow controller (spring/deadzone/rate) +
   game_config knobs + debug toggle + comment-honesty sweep. Fixed mode = default,
   byte-identical behaviour.
2. Tuning pass: pick defaults that feel right via testplay (drive with STEPS, turn hard,
   strafe, aim in small circles — the last one must NOT rotate the camera thanks to the
   deadzone). Record chosen values in the commit body.
3. Evaluation deliverable: two testplay screenshot pairs (same spot, fixed vs follow at two
   headings) + a short verdict note appended to the T-317 ticket body. Leave the mode toggle
   in place for the user's own verdict; the ticket text defines what happens after the verdict
   (loser dies or toggle becomes a setting) — that follow-up is NOT yours to pre-empt.

## Do NOT

- Smooth, quantize, or otherwise touch the gameplay facing value.
- Change rig geometry/FOV, add mouse-drag orbit, or add zoom — yaw-follow only.
- Add server/wire anything.
- Leave the old "fixed yaw" comments lying.

## Verification

Standard bar (type-check, client tests, bundle + testplay). Specifically: with follow ON —
walk a full circle (camera tracks smoothly, world readable throughout), aim in small circles
at a fixed enemy (camera holds still — deadzone works), toggle mid-run (no snap wilder than
the spring allows). With follow OFF — behaviour byte-identical to today. Screenshot pairs
attached to the final report.
