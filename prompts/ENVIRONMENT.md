# Shared execution context for the prompts in this directory

You are an implementation agent working in `/home/work/projects/voxim` (Deno + TypeScript
monorepo, branch `feat/aaa-graphics` unless the prompt says otherwise). Read this file fully,
then `CLAUDE.md` (project doctrine — it BINDS every change), then the required reading your
prompt names. Only then touch code.

## Drift warning — read first

These prompts were written 2026-07-03 (repo tip `abfe5c9`). Other prompts from this directory
may have landed since, and the codebase moves fast. Therefore:

- **Never trust a line number.** Locate everything by symbol/grep and re-read the actual file
  before editing.
- **Check `TICKETS.md` first**: your ticket's current status, and the status of every ticket
  your prompt lists under "Depends / assumes landed". If an assumption hasn't landed, stop and
  say so instead of building on air.
- If an anchor this prompt names no longer exists, adapt to the current shape — do not
  resurrect the old one.

## Environment facts

- The `deno` on PATH is the WRONG version. Always use `/home/work/.dvm/versions/2.8.0/deno`.
- Type-check that must stay green after EVERY commit:
  `/home/work/.dvm/versions/2.8.0/deno check packages/tile-server/mod.ts packages/client/src/game.ts packages/codecs/mod.ts packages/content/mod.ts packages/atlas/mod.ts packages/world/mod.ts packages/levelgen/mod.ts packages/protocol/mod.ts`
- Full test suite: `/home/work/.dvm/versions/2.8.0/deno test -A packages/` (expected fully
  green at the time of writing — 580 tests).
- The docker dev stack is normally already running: tile = container `voxim-tile-1-1`
  (serves the client on http://localhost:14433, game on udp :4433), gateway :8081, atlas :8082,
  postgres. The dev tile runs `deno --watch=./packages` and hot-restarts itself on server-code
  changes. The client bundle is watch-EXCLUDED: rebuild with
  `cd /home/work/projects/voxim && /home/work/.dvm/versions/2.8.0/deno task bundle`
  (if it fails with a root-owned `packages/client/dist/game.js`, delete that file and retry).
- NEVER use plain `docker restart` (drops the ./packages bind-mount). If a container must be
  recreated: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d <service>`.
- Testplay harness (visual verification): `scripts/testplay.mjs` — headless Playwright against
  the live stack. `OUT=<png> STEPS='[["key","KeyW",2000]]' node scripts/testplay.mjs`, then
  Read the screenshot and JUDGE it. It also prints a correlated client+server log stream.
  Rebuild the bundle before testplaying client changes.
- Atlas re-bake (needed after atlas/pipeline changes marked ✶):
  `curl -X POST "http://localhost:8082/world/bake?seed=7&width=2&height=2&name=<name>" -H "x-voxim-service-secret: $(grep ^VOXIM_SERVICE_SECRET= .env | cut -d= -f2-)"`
  The tile polls the worlds repo every 5 s and self-restarts onto the newest bake — no manual
  restart needed. Saves are keyed per world id; old saves never shadow a new bake.

## Doctrine you will be reviewed against (CLAUDE.md has the full text)

- Refactors replace, they don't accrete: no shims, no re-export bridges, no `useNewX` flags,
  no back-compat with saves/wire — data and code move together in one commit.
- ContentStore is the only data path; never hardcode tuning; every content id referenced by
  other content or config is cross-checked at boot and THROWS on mismatch.
- Registry-dispatch over kind-switches: new effect/gate/BT-node/hit-handler/activity =
  one handler file + one `register()` call, never an engine `switch`.
- Networked codecs live in `@voxim/codecs`; `wireId` lives on the component def; never reuse a
  retired wire id; server-only components set `networked: false`.
- Presence-as-flag is server-local; the wire carries data, the client derives presentation.
- Timers/lifetimes come from the Resource primitive; on-event behaviour from the Trigger
  primitive (closed event catalog: `hit_landed` / `damage_taken` / `entity_died`).
- **Chunk-grid lessons (T-315, expensive to relearn):**
  - Any NEW chunk grid must be added to `ChunkLifecycleSystem`'s `CachedChunk`
    (snapshot/restore — all grids, `.slice()` copies) AND to the round-trip assertions in
    `chunk_lifecycle.test.ts`, or unload/reload silently destroys it.
  - Client chunk grids live ONLY on `ClientWorld`'s `ClientChunk` structs; the chunk-ready
    hook fires once per chunk at spawn/delta BATCH boundaries (never mid-decode) — new grids
    ride the same mechanism, no per-consumer retry queues.
  - SaveManager deliberately excludes atlas-derived field grids and re-derives them on load
    via `applyFieldsToChunks` — decide explicitly which bucket a new grid belongs to.

## Git & bookkeeping

- Commit after every self-contained change; package-prefixed subject
  (`client: …`, `atlas+tile-server: …`), short body when the why isn't obvious, final line:
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Do not push.
- TICKETS.md: set your ticket `Status: in-progress` when you start; `Status: done` +
  `Commit: <short-hash>` when it lands; progress notes belong in the ticket body, not in
  loose files. If your work retires another ticket's premise, mark THAT ticket obsolete with
  a one-line reason.
- When a plan-doc phase closes (e.g. a `VISUAL_DATAMODEL_PLAN.md` phase), update the plan in
  the same commit that finishes it.

## Verification bar (every prompt, unless it narrows it)

1. Type-check green per commit (command above).
2. Targeted `deno test -A` for touched packages; full suite before finishing.
3. Atlas touched? Run the atlas snapshot suite. Byte-parity is the default expectation —
   if your change DELIBERATELY alters bake output (your prompt will say so), regenerate the
   snapshots in the same commit and say so in the commit body.
4. Anything client-visible: bundle rebuild + testplay screenshot pass, and actually LOOK at
   the screenshot (terrain, scatter, water, HUD sane; no console errors in the correlated log).
