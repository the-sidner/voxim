# Animation source maps

Per-source-library maps that convert third-party humanoid skeletons (Quaternius,
Mixamo, CMU mocap, etc.) into our 17-bone skeleton's clip format.

## Files

| File | Source library | Notes |
|---|---|---|
| `mixamo.json` | [Mixamo](https://www.mixamo.com) | ~65-bone source rig; we keep ~16, drop fingers and twist bones |
| `quaternius.json` | [Quaternius UAL 1+2](https://quaternius.itch.io/universal-animation-library) | A-pose source — `restDeltas` pulls arms toward our T-pose |
| `cmu.json` | [CMU mocap (cgspeed BVH → GLB)](https://sites.google.com/a/cgspeed.com/cgspeed/motion-capture/the-daz-friendly-bvh-release-of-cmus-motion-capture-database) | T-pose source; `lowerback/upperback/thorax` map 1:1 to our three torso bones |
| `cesiumman.json` | Khronos sample asset | Smoke-test target; bespoke bone names |

## Workflow

```bash
# 1. Inspect a new GLB to see its bone names & animations.
deno task anim-inspect path/to/source.glb

# 2. If the source uses a known library, run the converter directly.
deno task anim-convert path/to/source.glb quaternius --clip Walking --id walk_quat > /tmp/clip.json

# 3. Splice the resulting clip object into the target skeleton's "clips" array.
#    (Edit packages/content/data/skeletons/human.json by hand, or write a tiny
#    splice script — there's no auto-merge yet.)

# 4. Restart tile server, refresh browser; eyeball the imported clip in-engine.

# 5. If poses look stiff or arms point the wrong way, tune `restDeltas` in the
#    library map (radians, additive on top of every keyframe per bone).  Re-run.
```

## Adding a new library map

1. `deno task anim-inspect source.glb` — copy the source bone names.
2. Create `<library>.json` with a `bones` map from source name → our bone name.
   Multiple source bones may target the same our-bone (e.g. Mixamo `Spine` and
   `Spine1` both → `torso_mid`); the later channel wins, so put the meatier
   bone last in source order if both have animation tracks.
3. Leave `restDeltas` empty initially. Iterate: import a clip, view it,
   eyeball-tune the deltas (radians) per bone until idle/walk look natural.
4. Source bones with no map entry are silently dropped — that's how you handle
   fingers, twist bones, extra spine subdivisions.

## Notes

- Translation channels are ignored. Our format has rotation tracks only;
  locomotion is driven by the entity's velocity, not baked into root XYZ.
- Clip times are normalised 0..1; the `--fps` flag controls sample density,
  not playback speed (playback speed comes from `idleSpeedScale` etc. in
  `game_config.json` and from velocity scaling in `AnimationSystem`).
- Quaternion → Euler XYZ uses the same convention as our hand-authored clips
  (`THREE.Euler.setFromQuaternion(q, "XYZ")`).
