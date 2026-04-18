# Workbench & Derived NPC Planning Plan

**Executes after `PREFAB_SYSTEM_PLAN.md` is complete.** This plan assumes
prefabs, schemas, `spawnPrefab`, inheritance, and `requires` are all in
place. The phases here build on that substrate.

---

## Goal

Two entangled commitments, executed together because they reinforce each
other:

1. **Workbench is a component, not a kind of thing.** Anvils, furnaces,
   tanning racks, hearths, job-boards — anything you walk up to, set a
   recipe on, and hit with a tool — are prefabs composing a common
   `Workbench` component. Special workbenches (hearth, job-board) layer
   overlay components (`Hearth`, `JobBoard`) on top. Adding a new
   workbench is a prefab drop.

2. **NPC planning is derived from recipe data.** An NPC told "produce X"
   walks the recipe graph, discovers required inputs and workbenches,
   generates an ordered plan, and executes it through generic BT
   primitives. Adding a new recipe means the NPC can now produce it —
   zero AI code changes. Same derivation philosophy as
   skeleton → hitbox: the engine is a runtime, the behaviour is data.

Together these two reduce "make the world alive with working NPCs" to a
content authoring problem.

---

## Principles

1. **Generic BT primitives, per-recipe data.** `GoToWorkbench`,
   `PlaceInBuffer`, `HitWorkbench` know nothing about specific recipes or
   specific workbench types. They consume `CraftingPlanStep` records
   emitted by the planner. The planner knows nothing about NPCs.

2. **Planner is a pure function.** `plan(target, inventory, worldView) →
   CraftingPlan | null`. No world mutations, no side effects.
   Unit-testable with synthetic input.

3. **Reservations are emergent, not locked.** Two NPCs planning for the
   same anvil collide physically, one re-plans. No lock table, no queue,
   no manager. Complexity via composition, the same way other
   contentions resolve.

4. **NPCs share player systems.** An NPC crafting at an anvil is the
   same interaction the player would do — `PlaceInBuffer` writes to
   `WorkbenchBuffer`, `HitWorkbench` fires `ACTION_USE_SKILL`, crafting
   system resolves. No NPC-specific crafting code.

5. **Hearth and JobBoard are overlay components.** Placing them on a
   workbench prefab layers new behaviour. No dedicated entity kinds; no
   per-special-workbench spawn paths. The prefab system is the composition
   mechanism.

6. **Fail silent, re-plan later.** NPCs that can't fulfil a plan
   (workbench missing, material unavailable, path blocked) clear the
   plan and let the BT re-enter planning on the next tick. No exception
   propagation, no dead-NPC states.

---

## Universal acceptance criteria (every phase)

After each phase commit:
- `deno check packages/tile-server/mod.ts packages/client/src/game.ts
  packages/codecs/mod.ts packages/content/mod.ts packages/gateway/mod.ts`
  passes.
- `grep -rn "<deleted-identifier>" packages/` returns zero hits for every
  symbol removed.
- Observable gameplay is identical except where the phase explicitly
  adds capability (e.g. P3 enables NPCs producing items on demand).

---

## Phase 0 — RecipeGraph

**Ships:** A reverse index built at content-load that answers two queries
in O(1): "what recipes produce item X" and "what recipes does workbench
type Y support". No runtime consumers yet — this phase establishes the
data structure the planner (P1) and the BT (P2) will read from.

### Changes

- New module: `packages/content/src/recipe_graph.ts`.
- Structure:
  ```ts
  interface RecipeGraph {
    producers: Map<ItemType, Recipe[]>;    // item → recipes that output it
    byStation: Map<WorkbenchType, Recipe[]>; // workbench → supported recipes
    primitives: Set<ItemType>;             // items not produced by any recipe
                                           // (gathered from resource nodes or
                                           //  spawned directly)
  }
  ```
- Built once at `loadContentStore()`, alongside the existing recipe
  table. ContentStore exposes `getRecipeGraph(): RecipeGraph`.
- Primitive detection: any `ItemType` that (a) appears as an input to
  some recipe and (b) is not produced by any recipe is a primitive. The
  planner (P1) terminates recursion at primitives.
- Unit tests: small hand-built recipe fixtures; assert producers /
  byStation / primitives indices are correct.

### Deletion list

Nothing. Phase is purely additive.

### Acceptance

- `content.getRecipeGraph().producers.get("iron_sword")` returns the
  recipe(s) that produce it.
- `content.getRecipeGraph().primitives.has("iron_ore")` is `true`
  (gathered from resource nodes, not crafted).
- Unit tests in `packages/content/src/recipe_graph.test.ts` pass.

---

## Phase 1 — CraftingPlanner

**Ships:** A pure function `plan(target, inventory, worldView) →
CraftingPlan | null`. Given a target item, the NPC's current inventory,
and a lightweight view of available workbenches + resource nodes, returns
an ordered plan or null if unreachable. No mutations, no dispatch — a
caller (P3's BT nodes) consumes the result.

### Changes

- New module: `packages/tile-server/src/ai/crafting_planner.ts`.
- Plan step shape:
  ```ts
  type CraftingPlanStep =
    | { kind: "gather"; itemType: ItemType; resourceNodeTypes: string[]; quantity: number }
    | { kind: "craftAt"; recipeId: string; workbenchType: WorkbenchType; inputs: ItemStack[] }
    | { kind: "fetch"; itemType: ItemType; from: "inventory" | "buffer"; quantity: number };

  interface CraftingPlan {
    target: ItemType;
    steps: CraftingPlanStep[];  // ordered, front-to-back consumption
  }
  ```
- Planner interface:
  ```ts
  interface WorldView {
    placedWorkbenches: ReadonlyMap<WorkbenchType, EntityId[]>;
    nearbyResourceNodes: (itemType: ItemType) => boolean;
  }

  function plan(
    target: ItemType,
    inventory: InventoryData,
    world: WorldView,
    graph: RecipeGraph,
  ): CraftingPlan | null;
  ```
- Algorithm: depth-first goal regression from target.
  1. If target is already in inventory in sufficient quantity → single
     `fetch` step.
  2. If target is a primitive → `gather` step; if no resource node
     produces it in range → null.
  3. Else: for each recipe producing target:
     - Recurse on each input.
     - If any input returns null → skip this recipe.
     - If any required workbench type isn't in `placedWorkbenches` →
       skip this recipe.
     - Accumulate sub-plans → emit `craftAt` step.
  4. Rank candidate plans by total step count (cheapest wins). Ties
     break by proximity to the NPC (deferred: MVP just picks first).
- Returns null when no recipe chain terminates in achievable primitives.
- Cycle guard: maximum recursion depth parameter (default 16) — recipe
  chains deeper than that are treated as unreachable. Content authored
  past this limit is a content bug, not an engine concern.
- Unit tests in `packages/tile-server/src/ai/crafting_planner.test.ts`:
  - Simple single-recipe plan (`wooden_sword` → `wood_plank` → `wood`).
  - Multi-step plan (`iron_sword` → `iron_ingot` → `iron_ore` +
    `charcoal` → `wood`).
  - Inventory short-circuit (target already held → single fetch step).
  - Missing workbench → null.
  - Missing primitive source → null.
  - Cycle guard triggered → null.

### Deletion list

Nothing. Phase is purely additive.

### Acceptance

- `plan("iron_sword", npc.inventory, worldView, graph)` returns a
  readable step list end-to-end in unit tests.
- Planner has zero runtime callers yet — it's machinery for P2/P3 to
  consume.

---

## Phase 2 — BT primitives for workbench interaction

**Ships:** Three new behavior-tree nodes that any NPC can use to operate
any workbench for any recipe. These are the physical-interaction
primitives the planner's `craftAt` step will compose through.

### Changes

- New BT nodes in `packages/tile-server/src/ai/bt/nodes/`:

  - `go_to_workbench.ts` — looks up the nearest entity with a
    `Workbench` component of the parameterised type, sets a movement
    plan toward it, yields until within interaction range. Failure
    conditions: no such workbench exists on the tile, or path blocked
    beyond a retry budget.

  - `place_in_buffer.ts` — writes the parameterised `ItemStack[]` into
    the nearby workbench's `WorkbenchBuffer`, consuming them from the
    NPC's `Inventory`. Fails if the buffer is full, the NPC lacks the
    items, or the active-recipe lock is held by another NPC.

  - `hit_workbench.ts` — sets the NPC's `InputState.actions` to
    `ACTION_USE_SKILL` until the workbench's `WorkbenchBuffer` shows
    the target recipe has completed (buffer consumed, output spawned).
    Reuses the existing combat/action pipeline — NPCs hit workbenches
    the same way they hit enemies.

- BT node registration: these three land in
  `ai/bt/nodes/` alongside the existing `check_*` / `set_job_*` nodes.
  They register into the same `BTNodeRegistry` used by
  `NpcAiSystem`.

- No existing system changes. These are new composable primitives.

### Deletion list

Nothing. Phase adds primitives; the old `seek_food` and `seek_water`
jobs are untouched (they could later be reformulated as `TryProduce`
goals, but that's a follow-up).

### Acceptance

- An NPC with a hand-scripted behaviour tree composed of `GoToWorkbench
  → PlaceInBuffer → HitWorkbench` (fed with literal recipe / item
  parameters) walks to an anvil, places inputs, hits it, and spawns an
  output.
- The interaction is indistinguishable from a player doing the same
  actions — same components written, same event stream, same results.

---

## Phase 3 — BT goal node: `TryProduce(itemType)`

**Ships:** The bridge between the planner (P1) and the primitives (P2).
An NPC given the goal "produce X" runs the planner once, caches the
result on `NpcJobQueue`, and walks the plan step by step. Re-plans on
failure. At this point NPCs can produce any item whose recipe graph
terminates in gatherable primitives — with no per-recipe code.

### Changes

- `NpcJobQueueData` extended with an optional `craftingPlan?:
  CraftingPlan` field. The plan lives alongside the movement `plan`
  that already exists (they're orthogonal — movement plan is the
  current step's path; crafting plan is the sequence of steps).

- New BT nodes:

  - `try_produce.ts` — if `craftingPlan` is absent, call the planner.
    If null → failure. Otherwise store and continue.
  - `execute_plan_step.ts` — pops the front of `craftingPlan.steps` and
    dispatches to the appropriate subtree:
    - `gather` → existing `seek_resource` subtree (reformulated to
      accept a parameterised resource node type list).
    - `craftAt` → sequence `GoToWorkbench(type) → PlaceInBuffer(inputs)
      → HitWorkbench()`.
    - `fetch` → no-op if already in inventory; otherwise resolved
      during `craftAt`.
  - `check_plan_done.ts` — success condition when the target item is in
    inventory.

- `crafting_planner` gains a `replan()` convenience — clear the stored
  plan, BT on next tick re-enters `TryProduce` and regenerates.

- Reformulate the existing seek-food / seek-water jobs (optional; not
  strictly required this phase): both become `TryProduce(food_item)` /
  `TryProduce(water_item)` BT subtrees. Deferred to phase follow-up if
  it enlarges this phase too much.

### Deletion list

- If seek-food / seek-water reformulation lands: `ai/jobs/seek_food.ts`
  and `ai/jobs/seek_water.ts` deleted, their logic subsumed by the
  generic planner. Otherwise preserved for now.

### Acceptance

- Place an iron sword goal on an NPC via debug command. The NPC:
  1. Walks to a tree, chops wood.
  2. Walks to a kiln, makes charcoal.
  3. Walks to an iron node, mines ore.
  4. Walks to a furnace, smelts iron ingot.
  5. Walks to an anvil, forges the sword.
  6. Carries the finished sword.
- Adding a new recipe for `poisoned_dagger` makes the same NPC able to
  produce it — with zero AI code changes.

---

## Phase 4 — Hearth component + heir respawn

**Ships:** `Hearth` as an overlay component on a workbench prefab.
Dynasty heirs spawn at their hearth on login post-death. Ties the
account-service heritage flow to a physical location in the world.

### Changes

- New component in `packages/tile-server/src/components/hearth.ts`:
  ```ts
  interface HearthData {
    claimRadius: number;   // used by future territorial mechanics
  }
  ```
  `requires: ["Workbench"]` — a hearth is always also a workbench.

- Account service extension: user record gains a `hearthAnchor?:
  { tileId, position } | null` field. Tile server reports to the
  account service when a player places a hearth (tile calls
  `PATCH /internal/user/:userId/hearth`). On respawn, the gateway
  routes the heir to the anchor's `tileId` and the tile spawns the
  heir at the anchor's position.

- New endpoint on gateway: `PATCH /internal/user/:userId/hearth`
  body `{ tileId, position }`. Server-to-server auth, same secret.

- `AccountClient` in tile-server gets `updateHearth(userId,
  tileId, position)` method.

- Tile server: when a player places a `Hearth`-carrying workbench
  near them (via blueprint completion → prefab spawn), the building
  system checks the blueprint's dynasty tag and calls
  `accountClient.updateHearth(...)`. MVP: only the most-recently-placed
  hearth counts; heirs spawn there. Multi-hearth-per-dynasty is a
  future decision.

- Respawn flow: on player death → entity destroyed → account service
  records death (already done, T-114). On next login → gateway reads
  `hearthAnchor`, routes to that tile, tile spawns player at that
  position instead of the default spawn.

### Deletion list

- The hardcoded `player.defaultSpawnX` / `defaultSpawnY` fallback is
  retained but only used when the player has no hearth anchor yet
  (first character, pre-first-hearth-placed).

### Acceptance

- Place a hearth → die → reconnect → heir spawns at the hearth
  position.
- Destroy the hearth (combat on its workbench HP, handled by
  existing health-hit path) → next heir spawns at default.
- `accountStore.getUserById(...).hearthAnchor` reflects the placed
  hearth.

---

## Phase 5 — JobBoard component + NPC top-level goal pull

**Ships:** `JobBoard` as an overlay component on a workbench prefab.
NPCs associated with a job-board pull jobs from it and execute via
`TryProduce`. The management layer the SPEC describes falls out as a
thin data structure plus a BT branch.

### Changes

- New component `JobBoard`:
  ```ts
  interface JobBoardData {
    pending: Job[];
    claimed: ClaimedJob[];   // NPC has taken ownership, not yet done
  }

  interface Job {
    id: string;              // UUID
    goal: "produce" | "gather" | "patrol";
    args: Record<string, unknown>;
    priority: number;        // higher = pulled first
    postedBy: EntityId;      // player who assigned it
    postedAt: number;        // server tick
  }
  ```
  `requires: ["Workbench"]`.

- New component on NPCs: `AssignedJobBoard { boardId: EntityId }`.
  Hired NPCs carry this; untethered NPCs don't. (Hiring mechanic is
  separate; MVP can manually assign via debug command.)

- New BT root branch: the top of every NPC's behaviour tree becomes:
  ```
  selector
    ├── handle survival (existing: flee, seek-food, seek-water)
    ├── if AssignedJobBoard && board has pending → claim + execute
    └── idle / wander (existing)
  ```

- New BT nodes:
  - `pull_job_from_board.ts` — queries the assigned board, picks
    highest priority pending job, writes it into `NpcJobQueue.current`,
    moves it from `pending` to `claimed` on the board.
  - `execute_job.ts` — dispatches to the appropriate goal subtree.
    `produce` → `TryProduce(args.itemType)`. Others are future.
  - `finalise_job.ts` — on success, removes the job from `claimed`
    and optionally fires a "job done" event. On failure, decrement a
    retry counter or return to pending.

- Job-board operations (server-side only; client UI is later):
  - Debug command / admin endpoint to post a job: `postJob(boardId,
    goal, args, priority)`.
  - Future player UI: open the job-board workbench → see pending
    jobs → post new / cancel existing. Not in this phase.

### Deletion list

- Nothing. The existing NpcJobQueue / job handler infrastructure stays;
  it becomes the execution layer underneath the new top-level pull.

### Acceptance

- Post "produce iron_sword" to a job board. An NPC with
  `AssignedJobBoard` pointing at that board claims and executes the
  job, ends up holding an iron sword.
- Post 5 jobs, assign 3 NPCs. Jobs get distributed; no two NPCs
  attempt the same job; NPCs without jobs fall through to idle
  behaviour.
- Destroy the job-board workbench. Assigned NPCs lose their
  `AssignedJobBoard` (removed by the hit handler) and fall back to
  idle — demonstrating the territorial-anchor pattern the SPEC wants.

---

## Out of scope (deferred)

- **NPC lore internalisation / externalisation.** NPCs carrying lore
  fragments, writing tomes, reading from libraries. Separate plan,
  sits on top of this one.
- **Territorial claim semantics beyond heir spawn.** `claimRadius` on
  Hearth is reserved for future use; this plan doesn't yet wire it
  into anything.
- **Multi-hearth-per-dynasty** (multiple bases). MVP assumes one
  hearth per user.
- **Macro layer / NPC cities / LLM-driven strategy.** Separate plan.
- **Player client UI for job boards.** Server-side posting via admin
  command is sufficient until the client rebuild.
- **Workbench reservation / queue management.** Emergent for now —
  NPCs collide physically and re-plan. A proper reservation table
  can come later if contention becomes gameplay-relevant.
- **Cost functions beyond plan-step count.** Distance-based ranking,
  workbench-ownership preference, skill-gated recipes — all
  extensions to the planner's ranking pass.
- **Recipe quality / material composition in planning.** The planner
  currently treats recipes as opaque input/output tuples. Material
  quality (which affects output stats) is resolved at craft time by
  the existing crafting system; the planner doesn't optimise for it.

---

## Dependencies on other plans

- **Requires:** `PREFAB_SYSTEM_PLAN.md` complete. Specifically P2
  (inheritance) is used by the workbench family in P5 here.
- **Consumes:** heritage / account-service flow from
  `TICKETS.md` T-110–T-115. Phase 4 of this plan extends the account
  service with the `hearthAnchor` field.
- **Independent of:** client rebuild. This plan operates entirely
  server-side. Players interact with job boards via the existing
  command datagram path until the client is ready.

---

## Commit structure

One commit per phase. Each commit:

1. Lands all schema / code / data / test changes for that phase.
2. Passes all five `deno check` entry points.
3. Passes the phase's unit tests (P0, P1 have them; P2 onward have
   integration-style tests via a headless NPC harness if feasible).
4. Executes its deletion list fully.
5. Follows the project's commit message pattern — package prefix,
   concise "why", Co-Authored-By trailer.

Example commit title shapes:
- `content: W0 — RecipeGraph reverse index`
- `tile-server: W1 — CraftingPlanner pure function`
- `tile-server: W2 — BT primitives for workbench interaction`
- `tile-server: W3 — TryProduce goal node + plan execution`
- `tile-server+gateway: W4 — Hearth component + heir respawn anchor`
- `tile-server: W5 — JobBoard component + NPC job-pull BT branch`

---

## Why this plan, not another

Two architectural values this plan is explicitly *not* trading against:

- **Player-NPC symmetry.** Every mechanism here is something a player
  could do manually (walk to anvil, place items, hit it). The NPC
  path and the player path use the same components and the same
  systems. The SPEC's promise of "NPCs as simulated players using the
  same systems" is honoured literally — NPCs are players with a
  slower, dumber decision layer.

- **Content-author productivity.** Every decision favours making new
  recipes / workbenches / jobs a data-drop operation. The planner is
  the single piece of code that grows with the game — and it grows
  through data consumed, not code written.

The trade being made: some specific NPC behaviours (e.g. the current
hand-coded seek-food / seek-water that know about hunger / thirst
values) are eventually subsumed by the generic planner. That
generalisation adds a small inefficiency (the planner runs; the
special case could short-cut) in exchange for not maintaining N
parallel subsystems as N grows.

---

## When this plan lands

After these five phases, the tile-server satisfies the SPEC's §Social
section for the first time: NPCs use workbenches, fulfil player-posted
jobs, and do it all without per-recipe or per-workbench AI code. The
hearth-as-heir-anchor ties the permadeath loop to a physical world
investment. The job-board makes "manage a settlement" a concrete
primitive, preparing for the §Management System / §Territorial
Control sections of the SPEC that sit on top.

The vision's §Säule 1 (Persistenz) starts to feel real: the world
keeps producing even when the player isn't looking, because the NPCs
know how to work. Säule 6 (Komplexität durch Komposition) shows up as
emergent plans the designer never wrote — the player authors a recipe
chain; the NPCs discover the path through it.
