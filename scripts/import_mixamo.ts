/**
 * Batch import Mixamo FBX exports into data/anim_library/biped/.
 *
 * Workflow:
 *   1. Download animations from mixamo.com as FBX (T-pose, "no skin" is fine).
 *      One file per animation. Keep the Mixamo filename — the snake_case
 *      conversion below derives the clip id from it.
 *   2. Drop the FBX files into a folder, e.g. ~/Downloads/mixamo_batch/.
 *   3. Run:  deno task mixamo-import [--input <dir>] [--map <name>]
 *
 * For each FBX, the script:
 *   - Converts FBX → GLB via the FBX2glTF binary (auto-fetched from npm
 *     into /tmp on first run).
 *   - Runs scripts/convert_anim.ts with the `mixamo` bone map.
 *   - Writes data/anim_library/biped/{snake_case_id}.json.
 *   - Heuristically marks idle / walk / run / crouch / strafe / loop names
 *     as loop=true, everything else loop=false. Override with a manifest
 *     file (see --manifest below) when you need precise control.
 *
 * Mixamo license note: free for personal/commercial use, can't redistribute
 * the FBX files standalone, no attribution required. Shipping the converted
 * JSON clips inside the game is fine.
 */

const args = Deno.args;
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const INPUT  = flag("--input", `${Deno.env.get("HOME")}/Downloads/mixamo_batch`)!;
const MAP    = flag("--map", "mixamo")!;
const OUTPUT = flag("--output", "packages/content/data/anim_library/biped")!;
const FPS    = parseInt(flag("--fps", "30")!);
const DRY    = args.includes("--dry-run");

// Filename keywords that indicate a looping clip. Anything else → one-shot.
const LOOP_KEYWORDS = [
  "walking", "walk", "running", "run", "idle", "loop", "crouching",
  "crouch", "strafe", "strafing", "treading", "swimming", "flying",
  "climbing", "jogging", "sprint", "sneak",
];

// Filename keywords that should be treated as ONE-SHOT even if a loop
// keyword also matches (e.g. "Walking Hit" → one-shot).
const ONESHOT_OVERRIDE = [
  "death", "die", "dying", "hit", "impact", "knockdown", "fall",
  "land", "jump", "attack", "swing", "throw", "kick", "punch",
  "stab", "slash", "cast", "interact", "pickup", "drop",
];

// ---- helpers ----

/** "Walking In Place.fbx" → "walking_in_place" */
function clipIdFromFilename(name: string): string {
  return name
    .replace(/\.fbx$/i, "")
    .replace(/[\s\-\.]+/g, "_")
    .replace(/[()]/g, "")
    .replace(/_+/g, "_")
    .toLowerCase()
    .replace(/^_|_$/g, "");
}

function shouldLoop(name: string): boolean {
  const lower = name.toLowerCase();
  for (const kw of ONESHOT_OVERRIDE) if (lower.includes(kw)) return false;
  for (const kw of LOOP_KEYWORDS) if (lower.includes(kw)) return true;
  return false;
}

async function ensureFbx2gltf(): Promise<string> {
  const binPath = "/tmp/fbx2gltf-bin/package/bin/Linux/FBX2glTF";
  try { await Deno.stat(binPath); return binPath; } catch { /* fetch */ }
  await Deno.mkdir("/tmp/fbx2gltf-bin", { recursive: true });
  console.log("[import_mixamo] fetching FBX2glTF binary (one-time, ~13MB)...");
  const pack = new Deno.Command("npm", {
    args: ["pack", "fbx2gltf", "--silent"],
    cwd: "/tmp/fbx2gltf-bin",
    stdout: "piped", stderr: "inherit",
  });
  const { code, stdout } = await pack.output();
  if (code !== 0) throw new Error("npm pack fbx2gltf failed");
  const tarball = new TextDecoder().decode(stdout).trim();
  const tar = new Deno.Command("tar", {
    args: ["xf", tarball],
    cwd: "/tmp/fbx2gltf-bin",
    stderr: "inherit",
  });
  if ((await tar.output()).code !== 0) throw new Error("tar extract failed");
  await Deno.chmod(binPath, 0o755);
  return binPath;
}

async function fbxToGlb(fbx2gltf: string, fbxPath: string, glbOut: string): Promise<void> {
  const cmd = new Deno.Command(fbx2gltf, {
    args: ["-i", fbxPath, "-o", glbOut.replace(/\.glb$/, ""), "--binary"],
    stdout: "piped", stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`FBX2glTF failed: ${new TextDecoder().decode(stderr)}`);
  }
}

async function convertAnim(
  glbPath: string,
  mapName: string,
  clipId: string,
  loop: boolean,
  fps: number,
): Promise<{ id: string; loop: boolean; tracks: Record<string, unknown>; durationSeconds?: number } | null> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run", "-A", "scripts/convert_anim.ts",
      glbPath, mapName,
      "--id", clipId,
      "--loop", String(loop),
      "--fps", String(fps),
    ],
    stdout: "piped", stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    console.error(`  convert_anim failed: ${new TextDecoder().decode(stderr)}`);
    return null;
  }
  const text = new TextDecoder().decode(stdout).trim();
  // convert_anim.ts emits one or more comma-separated JSON objects (for
  // multi-anim GLBs). Mixamo files have exactly one animation, so wrap as
  // an array and take the first.
  const parsed = JSON.parse(`[${text}]`);
  return parsed[0] ?? null;
}

// ---- main ----

console.log(`[import_mixamo] input=${INPUT} output=${OUTPUT} map=${MAP} fps=${FPS}${DRY ? " (DRY RUN)" : ""}`);

// Extract any .zip packs under INPUT into INPUT/_extracted/{pack}/. Idempotent
// — skips packs already extracted. Mixamo "Pack" downloads are zips of FBX.
async function extractZips(root: string): Promise<void> {
  for await (const e of Deno.readDir(root)) {
    if (!e.isFile || !e.name.toLowerCase().endsWith(".zip")) continue;
    const stem = e.name.replace(/\.zip$/i, "").replace(/[\s\-\.]+/g, "_").toLowerCase();
    const dst = `${root}/_extracted/${stem}`;
    try { await Deno.stat(dst); continue; } catch { /* not extracted yet */ }
    await Deno.mkdir(dst, { recursive: true });
    console.log(`  unzip "${e.name}" → _extracted/${stem}/`);
    const cmd = new Deno.Command("unzip", {
      args: ["-q", `${root}/${e.name}`, "-d", dst],
      stderr: "inherit",
    });
    if ((await cmd.output()).code !== 0) {
      console.error(`  unzip failed for ${e.name}`);
    }
  }
}

// Recursive .fbx walk. Returns full paths.
async function collectFbx(dir: string, out: string[]): Promise<void> {
  for await (const e of Deno.readDir(dir)) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory) await collectFbx(full, out);
    else if (e.isFile && e.name.toLowerCase().endsWith(".fbx")) out.push(full);
  }
}

let inputPaths: string[] = [];
try {
  await extractZips(INPUT);
  await collectFbx(INPUT, inputPaths);
} catch (err) {
  console.error(`[import_mixamo] cannot read input dir: ${(err as Error).message}`);
  console.error(`[import_mixamo] hint: download Mixamo FBX exports into ${INPUT}/`);
  Deno.exit(1);
}
inputPaths.sort();
const inputFiles = inputPaths;

if (inputFiles.length === 0) {
  console.log(`[import_mixamo] no .fbx files in ${INPUT}/`);
  Deno.exit(0);
}
console.log(`[import_mixamo] found ${inputFiles.length} FBX files`);

const fbx2gltf = DRY ? "" : await ensureFbx2gltf();
const tmpGlb = "/tmp/mixamo_import.glb";

let imported = 0, skipped = 0, failed = 0;
for (const fpath of inputFiles) {
  const fname = fpath.split("/").pop()!;
  const clipId = clipIdFromFilename(fname);
  const loop = shouldLoop(fname);
  const outPath = `${OUTPUT}/${clipId}.json`;

  // Don't silently overwrite existing clips with the same id (e.g. an
  // already-imported UAL2 idle vs Mixamo idle). Skip with a warning.
  try {
    await Deno.stat(outPath);
    console.log(`  SKIP ${fname} → ${clipId}.json (already exists)`);
    skipped++;
    continue;
  } catch { /* ok */ }

  console.log(`  ${fname} → ${clipId}.json (loop=${loop})`);
  if (DRY) { imported++; continue; }

  try {
    await fbxToGlb(fbx2gltf, fpath, tmpGlb);
    const clip = await convertAnim(tmpGlb, MAP, clipId, loop, FPS);
    if (!clip) { failed++; continue; }

    const out = {
      ...clip,
      _source: `mixamo:${fname.replace(/\.fbx$/i, "")}`,
    };
    await Deno.writeTextFile(outPath, JSON.stringify(out, null, 2));
    imported++;
  } catch (err) {
    console.error(`  FAIL ${fname}: ${(err as Error).message}`);
    failed++;
  }
}

try { await Deno.remove(tmpGlb); } catch { /* ok */ }

console.log(`\n[import_mixamo] imported=${imported}, skipped=${skipped}, failed=${failed}`);
