# Voxim2 — Engineering Tickets

Each ticket is a self-contained unit of engineering work. Tickets are grouped by domain.
**This file holds only OPEN work.** Closed tickets — done, obsolete, superseded, deferred —
are archived in [CHANGELOG.md](CHANGELOG.md), which doubles as the project changelog.

**Format:**
```
### T-NNN · Title
Effort: S|M|L   Status: todo|in-progress|done|obsolete   [Commit: <hash>]

What needs to be built and what "done" looks like.
```

Effort: **S** < half a day · **M** half–two days · **L** multi-day or architectural

---

## Combat

### T-346 · Procedural bow/crossbow generation (T-306 composition)
Effort: M   Status: in-progress   (deferred from T-338, 2026-07-14; renumbered from a T-340 collision — T-340 was already the particles ticket, and numbers are never reused)

T-338 (bow/crossbow hold-to-aim path) shipped `wooden_bow`/`wooden_crossbow` on their existing
AUTHORED models (`model_bow_basic`/`model_crossbow_basic`) rather than composing with T-306's
procedural equipment generation, as originally asked. Deliberately deferred, not dropped: a bow is
two curved limbs + a string, which doesn't map onto `blade_grammar.ts`'s single-spine
limb+pommel+guard composition — the closer structural analog is `armor_grammar.ts` ("purely
visual"; a bow has no hit-sweep capsule of its own — the arrow's collision radius is a separate,
already-existing `ProjectileActionConfig.radius`). Sizing this properly (a `bow_grammar.ts` pure
evaluator in `@voxim/content` + a client `procmodel/generators/bow_grammar.ts` + a `ProcModelDef`
+ a boot-cross-checked field on `SwingableData` naming it, following the exact
`bladeGrammar`/`deriveBladeGeometry` pattern) is comparable in scope to blade_grammar/armor_grammar
themselves (each has its own dedicated multi-case test file) — realistically its own ticket, not a
tail end of T-338.
Done when: `wooden_bow`/`wooden_crossbow` (or their replacements) render a generated bow instead of
the static model, seed-unique per equipped instance, with zero change to the T-338 mechanic.

## Stealth

## Lore & Skills

### T-360 · Externalise Lore UI — write a learned fragment to a blank tome
Effort: S   Status: done   Commit: ab5d98c5 (+a56855ef)   (renumbered from a T-328 collision — numbers are never reused. The dormant server handler was NOT rotted — T-344 had already modernised DynastySystem to the T-260b LoreLoadout shape; what was missing was purely the client entry point. InventoryPanel's context-menu idiom: a blank_tome slot gets one "Write: <fragment>" action per learned fragment (the action list IS the selector, no new panel), shown only with ≥1 learned fragment; learnedFragmentIds surfaced client-side for the first time via mapLoreLoadoutToUI; new write_tome UIAction → CommandType.Externalise. Round trip Externalise→Internalise now test-pinned server-side)

Found while building T-072 (heir-ritual UI): `CommandType.Internalise` (read a
tome, T-020) now has a client entry point (InventoryPanel's "Read" action),
but `CommandType.Externalise` (write a learned Lore fragment to a blank tome,
T-019) still has none — the server handler has been sitting dead since it
shipped. This is the OTHER half of how tomes get into the family library in
the first place (a living player banks fragments for the next heir to read),
distinct from the heir-ritual flow T-072 covers.
Done when: a player with a learned fragment and a blank_tome in their burden
can pick a fragment (LoreLoadout has no UI surface for `learnedFragmentIds`
today either — that selector is part of this ticket) and write it, producing
a filled tome they can carry to the library.

## Crafting & Economy

### T-036 · Blueprint as saveable/storable Lore item
Effort: M   Status: needs-design   (premise has no referent in the code — scouted 2026-08-24, no code written)

A blueprint (saved after designing) becomes a `blueprint_tome` — a Lore item storable in the
family library, tradeable, and loadable by NPCs via a `build(blueprint_element)` job.
Done when: a designed blueprint can be saved as a tome item; another character or NPC can load
and execute it.

SCOUT FINDING (2026-08-24): there is no in-game "design" step to save. `Blueprint` is a
networked component on ONE pending-construction cell; structure types are pre-authored content
prefabs picked freely from the hammer radial menu; placement commits instantly per click (T-131:
"no staging, no confirm") and the Blueprint entity is DESTROYED on completion — no plan state is
ever retained anywhere, and no Save/Design command exists in the protocol. The substrate for the
ITEM half is all present and cheap once a design exists (Inscribed-pattern instance component,
DynastySystem's Externalise/Internalise idiom, TraderSystem trades any prefab). Design call
needed, two candidate shapes: (1) minimal "stamp" tool — capture a footprint of already-built
cells into `{structureType, [{dx,dy}]}` on a blueprint_tome; loading pre-seeds build mode (still
manual placement); (2) a real plan-mode UI (compose + confirm before materials are spent, named
plans) matching the ticket's literal wording — materially bigger than Effort: M, would need a
ticket split. T-037 stays blocked on whichever shape is picked (its `build(blueprint_element)`
job needs the same resolved data format).

### T-037 · NPC builder job assignment to blueprint element
Effort: S   Status: todo

Add `build_element` job type to the job board. NPCs with hammer + required materials in inventory
can execute build jobs, incrementally constructing blueprint elements.
Done when: assigning a build job to an NPC causes it to navigate to the blueprint and construct.

---

## NPC & Society

### T-042 · NPC specialisation matching to job requirements
Effort: M   Status: needs-design   (original Lore-on-NPC premise is dead — T-260b removed NPC LoreLoadout)

Original premise: jobs carry a `skillRequirement` Lore fragment; an NPC pulling a job checks its
own `learnedFragmentIds`. That mechanism no longer exists — NPCs carry **no LoreLoadout** since
T-260b (`spawner.ts:219`: "No LoreLoadout for NPCs"), so there is nothing to match a fragment
requirement against. There is no `skillRequirement` field on JobBoard jobs today either.

The goal still stands (a forging job should only be taken by an NPC that can smith), but the
matching key must be redesigned around what NPCs actually carry: their `NpcTemplate`
(archetype / `npcType`, and any future per-archetype skill tags). Concrete shape to decide:
add an optional `requiredArchetype` (or a small `skills: string[]` tag set on the template) to
JobBoard pending jobs; when an `AssignedJobBoard` NPC pulls a job, skip ones whose requirement
its template doesn't satisfy. Needs the NPC job-pull-from-board path confirmed/wired first
(JobBoard + AssignedJobBoard components exist; the admin endpoint appends jobs, but verify an
NPC actually dequeues from its assigned board).

Done when: a forging job tagged for smiths is only taken by NPCs whose archetype/skill tags
satisfy it; non-matching NPCs skip to a lower-priority job.

## World & Macro Simulation

### T-049 · Macro simulation — trade agreement + resource exchange
Effort: L   Status: todo

When two cities have an active trade agreement, a periodic job dispatches caravans (T-048)
between them. On arrival, goods are transferred between city inventories. Agreement can lapse
if a caravan is raided N times.
Done when: two cities with an agreement exchange goods via caravans; raiding disrupts the flow.

### T-050 · Connect LLM to city agent interface (T-046)
Effort: M   Status: todo

Wire the real LLM API (Anthropic Claude) to the city agent interface defined in T-046.
Context packet assembly, call trigger from world event bus, response parsing, tool execution.
Rate-limit: one call per city per event; no tick-driven calls.
Done when: a live city reacts to a significant event with LLM-generated tool calls.

## Gateway & Multi-tile

## World Generation

### T-058 · Road network generation
Effort: M   Status: todo

Connect city seed positions with roads following terrain of least resistance. Road tiles get a
flatten pass during tile generation. Gate positions on road tiles align with road path.
Done when: roads connect city seeds on the world map; road tiles carry a road flag.

### T-059 · NPC city seeding on world map
Effort: M   Status: todo

Select city locations from world map (flat terrain, near water, resource diversity). Create a
`CityState` (T-044) for each. Seed each with a founding NPC and a starting workbench.
Done when: world generation produces N cities at valid locations with initial state files.

### T-215..T-224 · Scene graph as a central engine system
Effort: XL (multi-ticket arc)   Status: in-progress

**BOUNDARY DECISION (user, 2026-07-07) — what is an entity:** **everything visible is an entity**, with one
honest exception that is not a compromise: **procedural scatter stays scatter**. The decorative forest
(thousands of trees per chunk) is NOT entities today and never becomes them — it is client-side procedural
placement from server fields, rendered as one `InstancedMesh` node (exactly as SCENE_GRAPH_PLAN.md's client
tree already shows: `ForestInstances (InstancedMesh)`). What DOES become entities: every authored,
identity-bearing thing and its parts — bones, equipment, attachments, POI scene parts, and the parts of
harvestable/interactable props.

Measured cost of that call (live tile, 2026-07-07): ~276 entities today → ~5k with prop sub-objects
promoted. Affordable because the plan's own static-vs-dynamic split makes it so: static entities carry
Position/ModelRef/optional Hitbox, NO behaviour components — no system iterates them per tick, the 20 Hz
changeset loop is unaffected by their count, and AoI ships only their initial spawn (they never change →
never ship deltas). The extra join cost is ~0.3–0.5 MB against a 6 MB content blob + 5 MB terrain stream.

Two capabilities this decision REQUIRED first — **both now DONE**: **T-333** hit-bubbling to the nearest
ancestor carrying the component (else a tree split into a subtree becomes unharvestable), and **T-334**
seeded pool/probability on `Prefab.children` — `resolveSeededPick` (`@voxim/engine`) is the ONE shared
primitive, wired through the engine spawn walk + tile-server's `ctx.resolveSeed`, with
`resolveSubObjects`/`hitbox_derive.ts` converged onto it too (so the geometry the client draws and the
hitbox the server derives cannot drift — the T-323 bug class, closed structurally).
Order: T-333 + T-334 → T-219 (bones — where the real content is) → T-221 (static props) → T-223 → T-224.
T-222 (coordinator) is deferred: its subject (cities) does not exist yet (T-059 is open).

See [`SCENE_GRAPH_PLAN.md`](SCENE_GRAPH_PLAN.md) at the repo root for the
full design + migration plan. Summary:

`@voxim/engine` grows a scene-graph primitive (parent/child links via a
networked `Parent` component) that sits co-equal with the flat ECS.
Nodes are entities; prefabs produce subtrees of entities; the same
engine APIs work in atlas (bake), tile-server (runtime), coordinator
(world graph), and client (rendering). What differs between services
is *which systems they install*, not which scene representation they
use.

Migration phases (each its own ticket):

  - T-215 — DONE (inert). engine/scene.ts: Parent (networked,
    engine-owned inline codec, wire id 49 reserved in protocol) +
    Transform/composeTransform; World gains setParent/getParent/
    getChildren/descendants/destroySubtree/worldTransform/localTransform
    (O(1) child index, changeset-deferred subtree teardown, cycle-safe
    transform compose). Registered in NETWORKED_DEFS. 8 engine tests +
    regression green; bake byte-identical. Nothing consumes it yet.
  - T-216 — DONE. engine/src/prefab.ts owns the generic spawn walk;
    concretes injected via PrefabSpawnContext (getPrefab/
    resolveComponent/compoundInstaller/preInstall). tile-server
    spawnPrefab keeps its signature as a thin wrapper — call sites
    unchanged, behaviour identical. 70 tests green; bake byte-identical.
  - T-217 — DONE. Prefab.children (ChildPrefabRef{prefabId, local?}) +
    engine spawnPrefab subtree recursion (spawn child → setParent →
    ctx.placeChild) + ChildSpawn structural type + placeChild ctx hook
    (tile-server writes child Position from local; scale deferred). Loader
    validates child shape per-prefab + a cross-ref pass rejecting
    unknown/abstract child ids. 3 engine prefab tests + 96 content/engine
    green; bake byte-identical (no prefab uses children yet). Bootstrap
    rides the JSON blob — no codec bump.
  - T-218 — DONE. First real `children` consumer. PoiBase.scenePrefabId
    (TS+valibot) → prefabs/poi/signal_pyre_scene.json (campfire parent w/
    lightEmitter+poiTrigger + 4 torch_placed children). placePoiTriggers
    spawns the scene prefab via spawnPrefab (recursing the subtree) and
    patches runtime poiInstanceId/poiDefId onto the walked trigger; POIs
    w/o a scene prefab keep the bare-entity fallback. T-217 placeChild
    hook refined to also pass parentId — service bakes child *world*
    Position off the parent (static subtrees; live compose is T-223). 2
    poi_spawner tests + 103 content/engine/poi green; bake byte-identical.
  - T-219 — DONE (lane/t219-bones, merged with T-220 as one arc per the
    plan's own note — T-219 was invasive enough that splitting them would
    have meant re-deriving the same equip-slot-to-bone resolution twice).
    `spawner.ts`'s `installSkeletonBones` spawns one real ECS entity per
    `SkeletonDef.bones` entry at skeletal-installer time (17 for biped, 11
    for wolf), scene-graph parented to mirror the skeleton's own hierarchy
    exactly (immediate `world.setParent`, safe — runs inside `preInstall`,
    before the entity is ever visible to any session, same argument as
    `buff.ts`'s `spawnBuffChild`). `Bone` component (wireId 59) carries
    ONLY `boneId` — restPose/parentBoneId stay content data
    (`SkeletonDef.bones`), the parent-bone ENTITY link is the engine's own
    `Parent`. **Bone transforms are never replicated** — motion stays
    derived client-side from `AnimationState` (already on the wire), the
    same derivation `entity_mesh.ts`'s pre-existing `boneGroups` pipeline
    already computed; this is the load-bearing decision the plan called
    out (17 bones × ~20 humanoids × 20 Hz of wire traffic for something the
    client already computes would have been the wrong path).
    A required engine prerequisite surfaced during implementation and
    fixed first: `world.setParent` writes `Parent` immediately
    (`world.write`), invisible to the wire delta builder
    (`AppliedChangeset.sets` sources exclusively from `pendingOps`) for an
    entity a session already knows about — the one existing live caller
    (`buff.ts`) was safe only by always targeting a brand-new entity.
    `world.reparent()` (deferred, routed through `world.set`) is the
    system-safe twin; `applyChangeset()`'s commit loop now maintains the
    child index on a committed `Parent` set/removal (previously only
    `setParent`'s immediate path did — a deferred reparent would have
    silently desynced `getChildren`/`descendants` from the wire-visible
    Parent value). Also closed in passing: `Parent`'s wire id 49 was
    registered in `NETWORKED_DEFS` since T-215 but never reached
    protocol's `ComponentType` enum or `CODEC_BY_WIREID` — every Parent
    byte the server has ever sent was silently dropped on decode
    (`COMPONENT_TYPE_TO_NAME.get(49)` → undefined). `aoi.ts` gained a
    generic scene-graph subtree-expansion pass (`world.descendants()` on
    every already-in-AoI entity) — bones/equipped-items carry no Position,
    so without it they'd be structurally correct server-side but never
    sent to any client; `descendants()`'s own parent-before-child DFS
    ordering resolves the "child must not arrive before its parent" hazard
    structurally, no separate sort pass needed.
  - T-220 — DONE (same lane/commits as T-219). Equipping = `world.reparent`
    (not `setParent` — EquipmentSystem is a live system touching
    already-AoI-known entities, exactly the gap the engine fix above
    closes) to `resolveAttachParent`'s resolved bone entity; unequipping /
    dropping = `world.reparent(..., null)` (+ the existing Position write
    for drop). `resolveAttachParent`/`EQUIP_SLOT_PRIMARY_BONE` cover the
    five SINGLE-bone equip slots (weapon→hand_r, offHand→hand_l, head→head,
    chest→torso_upper, back→torso_upper — mirrors the client's existing
    `entity_mesh_registry.ts` attachment table; a small, documented,
    human-reviewable duplication flagged for unification when T-223 gives
    the client a reason to consume the wire-replicated Bone/Parent data
    itself). `legs`/`feet` are deliberately EXCLUDED — the client's own
    table maps those to 2–4 bones each, so a single item entity has no one
    bone to parent to; they keep falling back to the holder root, same as
    a skeleton-less holder. Every character-destroy site
    (`death.ts`, `server.ts`×3, `poi.ts`) converted `world.destroy` →
    `world.destroySubtree` so bones/equipment never leak past their
    holder's death/disconnect (degrades to exactly `destroy()` for a
    childless entity — behaviour-preserving everywhere else). Found and
    fixed in passing: the tile-handoff success path never called
    `destroyCarriedItemEntities` at all (unlike the other two
    disconnect/death paths) — a pre-existing carried-item leak on every
    tile crossing, closed at the same call site as its `destroySubtree`
    conversion.
    **Scope boundary, recorded so it isn't re-litigated:** client
    rendering (`entity_mesh.ts`'s `boneGroups` Three.js Map,
    `skeleton_evaluator.ts`) is UNCHANGED this lane. Bone entities are
    real and replicated server→client (`client_world.ts` gained typed
    `parent`/`bone` `EntityState` fields so the decode isn't silently
    dropped), but nothing client-side consumes them for rendering yet —
    the client still builds its Three.js pose hierarchy directly from
    content `SkeletonDef.bones`, exactly as before T-219. This trivially
    satisfies "client visual output identical to pre-T-219" and is the
    SAME precedent T-218 already set for POI props ("live transform
    composition is still T-223"); building a one-off entity-driven
    Three.js pipeline just for bones ahead of T-223 (which gives the
    client a real materialize-from-World-scene-graph pipeline) would be
    throwaway work. The `Equipment` component is RETAINED as the
    slot-name authority (still read by AoI's own-item visibility, the
    Status/Modifier `equipment` ModifierSource, the Trigger `equipment`
    TriggerSource, CraftingSystem, every UI paperdoll read) — `Parent` is
    an ADDITIVE scene-graph fact layered on top for topology/lifecycle
    correctness, not a replacement; ripping `Equipment` out would cascade
    into the Status/Modifier and Trigger primitives, well outside either
    ticket's stated files-touched scope.
    In-lane verification: 8 new/extended test files (`scene.test.ts`
    reparent cases, `components.test.ts` boneCodec round-trip,
    `codec_registry.test.ts`, `skeleton_loader.test.ts`,
    `spawner_bone.test.ts`, `aoi_scene_graph.test.ts`, `equipment.test.ts`,
    `equip_cleanup.test.ts`) — full suite 914 green (894 baseline + 20),
    atlas snapshot suite byte-identical (no atlas file touched; atlas
    never spawns creature/skeletal prefabs into a World). The no-foot-slide
    proof (`swing_pose.test.ts`) and every producer in the pose pipeline
    (gait, foot-terrain IK, look-at, crouch, locomotion lean, swing IK)
    stayed untouched and green throughout — none of them read `boneGroups`
    through anything this lane changed. Live-stack visual verification
    (characters animate, sword follows hand) deferred to post-merge per
    lane rules — see the lane implementer's final report for the exact
    procedure.
  - T-221 — static prop sub-objects as scene-graph children. **DEFERRED (2026-07-14) — the
    original blockers are GONE, but the payoff is not here yet.** T-333 (hit bubbling) and
    T-334 (`resolveSeededPick`) both landed, so the two hard blockers named below — a child
    trunk being unharvestable, and `Prefab.children` having no PRNG concept — are answered:
    a hit on a child now bubbles to the nearest ancestor carrying the handler's component,
    and `Prefab.children` can express `tree_oak`'s 1 trunk + 24 pool/probability branches.
    The ticket is buildable. It is deferred anyway, because what it would BUY is not
    rendering (the client draws prop parts from content today, merged and cheap) but
    **dynamic per-part state** — a branch you can break off, a wall that partially collapses.
    Nothing needs that yet. Building it now costs draw-call risk (25 parts × ~200 props, if
    the batching is lost) and wire/entity growth for capability with no consumer. **Revisit
    when T-339 (death: ragdoll / crumble into voxels or parts) makes the requirement
    concrete** — at which point it specifies itself instead of being guessed at. [Update,
    lane/t339-death-crumble: T-339 landed (2026-07-15) — did NOT unblock this ticket. Crumble
    is skeleton bone-GROUP detachment off T-219/T-223's addressable bones, an entirely
    different subsystem from `Prefab.children`/static props; the PRNG-on-`Prefab.children`
    blocker described below is untouched.] The
    2026-07-13 audit's findings, preserved because they are still the map of the terrain: `subObjects` (packages/content's `ModelDefinition.subObjects`, resolved by
    `resolveSubObjects`/`hitbox_derive.ts`) is populated on exactly 5 models in the repo, and
    every one fails a different way: (1) the ticket's own named targets —
    `model_building_well`/`_cottage`/`_ruin_tower`/`_ruin_wall` — all have `subObjects: []`
    (confirmed unchanged since the T-095 file split); there is nothing there to migrate without
    first hand-authoring new multi-part building content, an art/content decision outside
    doctrine. (2) The four populated non-empty models — `drowner`/`human_base`/`rotten_knight`/
    `wolf` — are 100% `boneId`-driven bone-segment attachments; that's T-219's job. [Update,
    lane/t219-bones: the bone-ENTITIES half of T-219 has since landed — one real ECS entity per
    skeleton bone, server-replicated — but live transform composition off them is still not
    landed (deferred to T-223, same as this note originally said); client rendering for these
    four models is unaffected either way.] Not a "static prop" regardless. (3) `tree_oak` (the
    one non-skeletal model with real content: 1 fixed `trunk_oak` entry + 24
    `pool`+`probability` branch entries, consumed by the dormant-but-tested `tree`/`yew_tree`
    resource-node prefabs) needs seeded pool/probability selection that the landed
    `Prefab.children` (T-217, `engine/src/prefab.ts`) does not have — it is a flat
    `{prefabId, local?}[]` with no PRNG concept at all — so giving it one is a new engine
    capability, and doing it for tree-density content (not POI-density) reopens the plan's own
    wire-size/entity-count invariant (§3) for real: every rendered branch across every tree in a
    tile would become a live networked child entity instead of a free client-side render trick.
    Even the ONE fully-static, PRNG-free entry (`trunk_oak`) is not safe to move in isolation:
    `deriveHitboxTemplate`/`applyHitboxTemplate` merge every sub-object capsule onto the
    *parent's single* `Hitbox`, and `ResourceNodeHitHandler.onHit` requires `ctx.targetId`
    itself to carry `ResourceNode` (authored on the `tree`/`yew_tree` prefab, i.e. the parent) —
    moving the trunk capsule onto a child entity makes the trunk unharvestable unless hit
    resolution learns to bubble a child hit up to an interactable ancestor, which nothing in the
    hit-handler pipeline (`handlers/`) does today. None of this is inferable from doctrine or
    the landed T-215–218 shape; it needs an explicit call on (a) whether pool/probability
    belongs on the scene-graph primitive at all vs. staying a render-only trick, and (b) how
    hit/interaction identity should resolve across a subtree. No files touched other than this
    entry.
  - T-222 — coordinator world-scale scene graph
  - T-223 — DONE (lane/t223-client-scene-graph, commits f591ed7/dffac04/f6766ec/83a9513).
    Re-specified after recon (6cecdd5: "entities supply structure, content supplies
    transform" — the original text's "materialize Three.js objects from entity
    transforms" was unbuildable, since bone entities carry no transform, ever).
    `ClientWorld` gains a parent→children reverse index (`childrenOf`/`descendants`,
    mirroring engine `World`'s exact DFS shape) — an EXTENSION of ClientWorld per the
    plan's open call #3, not a fork of engine `World`. Each skeletal `EntityMeshGroup`
    gains a `boneEntityByBoneId`/`boneIdByEntity` identity map, built once per skeleton
    from `ClientWorld.descendants(entityId)` — bone entities acquire IDENTITY, never
    geometry; `boneGroups` (the THREE.Group-per-boneId pose target) is completely
    untouched, still built from content `SkeletonDef` data. `syncEquipment` now resolves
    every equipped item's attach bone via a new pure `resolveItemAttachment(world, mesh,
    characterId, itemEntityId)` — a 3-way result (bone / holderRoot / unresolved)
    distinguishing the five single-bone slots (graph-derived) from legs/feet (T-220's
    deliberate holder-root parenting — no single bone fits) from a transient
    not-yet-resolved window — which DELETES `ARMOR_SLOTS`/`SLOT_REST_BONE` outright, the
    ticket's primary deliverable, closing the drift hazard against spawner.ts's
    `EQUIP_SLOT_PRIMARY_BONE` (now the sole surviving slot→bone table, server-side only,
    doc comment updated to say so). Legs/feet's old static 4-anchor table (2 of which
    were always empty in practice) is replaced by a content-driven fan-out over the
    equipped item's own `armor.coversBones` (new optional `ArmorData` field, boot-
    validated in loader.ts) — NOT every bone the item's `armorGrammar` happens to author,
    since `plate_armor_iron` is one procModel SHARED across plate_chest/plate_helm/
    plate_greaves (torso_upper+head+upper_leg_l+upper_leg_r combined) and naively
    enumerating it would plate the wrong body parts on a legs-only item. Draw calls are
    unchanged by construction (fan-out only creates anchors for bones the item actually
    covers). Pose pipeline (`swing_pose.ts`/`ik_solver.ts`/`skeleton_solver.ts`/
    `skeleton_evaluator.ts`) untouched — `git diff 6cecdd5` on all four is empty, the
    tripwire the plan named explicitly. 25 new tests across three first-ever test files
    (`client_world.test.ts`, `entity_mesh_registry.test.ts`, `armor_covers_bones.test.ts`);
    full suite 940 green (915 baseline + 25). **Live-stack verification DONE post-merge
    (2026-07-14, merge 74b343d):** attachment resolves through the graph in the live client
    (17-entry bone identity map; `childrenOf(player)`=1 root bone, `descendants`=19 = 17
    bones + 2 held items; anchors `main_hand`/`off_hand` present, equipment = stone_axe /
    iron_sword). **Per-humanoid render cost is IDENTICAL, measured not asserted:** the
    fully-equipped player's mesh subtree is 61 Object3D / 22 THREE.Mesh both before
    (6cecdd5) and after (74b343d) — bone entities took identity, not geometry, exactly as
    the re-spec required. (Total scene draw calls are NOT a usable metric here: the same
    build measured 970 and 1030 in two runs, a 60-call spread, because NPCs wander and the
    visible chunk set differs — the +13 seen between pre/post builds is far inside that
    noise. The per-humanoid subtree count is the deterministic one.) ANIM gates 6/7 with
    the single failure (`locomotion clip while moving`) proven PRE-EXISTING by running the
    same gates against the pre-lane build, which scores 5/7 — the check looks for a
    walk/run CLIP, but since T-308 the gait is procedural (`applyGaitPose`), so no clip is
    active while limbs demonstrably sweep (0.127 vs 0.015 idle). **The harness check is
    stale, not the code — it should be rewritten to assert limb sweep, not clip identity.**
  - T-224 — inspector / editor tooling against any World. **CLIENT HALF DONE
    (2026-07-14): `ScenePanel`** — the replicated Parent/Bone hierarchy as a live tree
    (Debug → Scene graph). Only buildable since T-223 gave `ClientWorld` a children
    index; before that the client held a flat Map and there was no tree to walk. Shows
    the player subtree with the equipped weapons visibly hanging off `hand_r`/`hand_l`,
    chunks as roots, per-entity component detail, filter, live/pause, and a "reveal me"
    that expands the 17-bone chain in one click. Orphans (a child whose parent left AoI)
    are shown flagged rather than dropped — a silently vanished subtree is precisely the
    failure this panel exists to expose. It deliberately renders the ENTITY graph, not
    the Three.js scene: those are two different trees on purpose (entities supply
    structure, content supplies pose), and conflating them would hide the bug you opened
    the panel to find.
    STILL OPEN: the generalisation the ticket actually names — one `EngineInspector`
    module taking any `World` (bake-time / runtime / replicated), with the atlas
    inspector and a tile-server admin endpoint as specialisations of it. The client panel
    is a purpose-built consumer, not that shared module.

The T-214 IR + reducer + rasterizer split work is the substrate this
builds on. Snapshot determinism stays the invariant across every
phase.

## Client Rebuild

The full plan lives in `CLIENT_REBUILD_PLAN.md` (grounded in an 8-subsystem audit).
Spine: one **voxel pipeline** (`VoxelAtom` → `bakeVoxels` → `buildVoxelMaterial` →
InstancePool, fed by models/terrain/placement/ghost), one **palette authority**
(`palette/world.json` snapping every material at load), and one **scene owner**
(renderer god-class → `EntityMeshRegistry`). Each phase deletes the old path with
the new (replace, don't accrete). Phases are ordered cheapest-identity-win first.

## Animation & Render Verification

## Client / Controls, Feel & Render Polish

## Symphony — Feel, Content & Voxel Language

## Procedural Animation

The Overgrowth/David Rosen direction: a few authored anchors + procedural everything-between + IK,
over one substrate (the skeleton). Poses, IK, and body attachments all hang off the same bones, so
orthogonal behaviours (crouch + strafe + swing) compose instead of needing a combinatorial clip
matrix. See `swing_pose.ts` (the shared producer) and the Swing Inspector (the authoring tool).

## AAA Graphics

### T-311 · Visual data-model arc — author the world's look as content, not client hacks
Effort: XL   Status: in-progress   Plan: `VISUAL_DATAMODEL_PLAN.md` + `ART_DIRECTION.md`

**Progress:** Phase 0a landed — `MaterialDef.render` block frozen (I2) + TextureStyle
registry retiring the numeric `DRAW_FN` switch (`abdaf2d`); per-voxel `tintJitter`
amplitude threaded from `render` through `bakeVoxels` (`a649dee`). Both byte-identical /
zero visual change, `deno check` + parity tests green. **0b/0c/0d deliberately deferred,
not skipped:** 0b (CLIFF_* → config) is interim that Phase 6 deletes wholesale + would
need new bootstrap plumbing → throwaway; 0c (`buildMaterialMap`) is a 10-line stable
atlas-enum lookup, not a richness hack → converting it is ceremony; 0d (FieldExpr/
FieldSampler registry) is premature before the Phase-3 grids exist (the critique's #5 —
build the sampler with its data, not before). Phase 1 landed (both panels, live-verified via
playwright) — Studio "Material" editor (`0f6f73d`) live-previews `MaterialDef.render`, and
"ProcModel" editor (`57cf815`) generates trees/plants/rocks through the REAL generator
registry + bake, both via the curated `@voxim/client/render` barrel (shipped runtime, no
drift). The Scatter-Field-Painter half of P1a defers to P3/P4 (no field grids to paint
yet). Phase 2 in progress — **GradeDef** landed (`3a5e940`): the first AuthoredEnvParamSet (G7),
the 13 EdgePass grade constants lifted into a content `grades/` category (wired
types→store→loader→bootstrap round-trip), EdgePass.setGrade applied by the renderer; zero
visual change (values byte-equal to the retired constants). **LightDef** mostly landed (mapped by a
cartography workflow): LightDef content category (`4e8292b`, BOOTSTRAP_VERSION 15→16) +
FlickerCurve registry replacing the hardcoded oscillator (`4bf9c4a`) + client LightBudget
capping dynamic PointLights at 8, degrading the rest to always-on emissive flame voxels
(`8636ce4`, headless unit-verified). The LightEmitter wire bump landed too (`73eeeb7`):
`flicker` float retired for a `lightDefId` string (numbers stay on the wire for getLightAt;
client resolves flicker/castsPool/family from the LightDef — T-250), placed prefabs +
Illuminator + deriveItemStats + EquipmentSystem all moved in one commit, server boot
cross-check added. **LightDef is COMPLETE.** **MaterialStateLadder (G3) COMPLETE** too — `resolveMaterialVariant`
in @voxim/content (colorOverride/HSL-colorShift/emissiveCracks/addsTags; stable id→index, I3c)
+ a Studio Material "State ladder" dropdown previewing each variant through the real resolver
(the in-game per-cell index comes from P3's SurfaceStateGrid.variantIndex); example
corrupted/mossy variants on stone, live-verified. **PHASE 2 COMPLETE** (GradeDef · LightDef ·
MaterialStateLadder). Next: **Phase 3** — the unified per-cell field grids, the ONE permanent
wire break. **FIELD-SET MATRIX SIGNED OFF (user, I1)** — see `VISUAL_DATAMODEL_PLAN.md §Phase 3`:
`VegFieldGrid`{canopyLight,corruption,fertility} + `SurfaceStateGrid`{wetness,overgrowth,wear,
variantIndex u8,ruinAge,traffic} + `WaterGrid`{surfaceLevel f32}; full-res, mandatory RLE/zlib,
ruinAge+traffic baked in now (no 2nd break). P3 + P4 (multi-layer scatter) unlock the hero-cell
DENSITY slice. **P3 commit 1 LANDED (`c87a4fc`)** — the grids are minted as networked chunk
components (wireIds 54/55/56), sync per-plane RLE codecs (gzip ruled out — Serialiser is sync),
registered in NETWORKED_DEFS + the client CODEC_BY_WIREID decode table, createChunk writes neutral
defaults so every chunk carries them, MAX_CHUNK_SPAWNS_PER_TICK 20→12; 6 codec round-trip tests +
deno check ×5 green. **The permanent wire is set.** Remaining P3: **2a LANDED (`70e8e47`)** — pure `deriveFieldPlanes` core, unit-tested. **2b-i LANDED
(`539ee7d`)** — the `fields` pipeline stage (rasterises pathLevel from the zone graph, calls
deriveFieldPlanes → state.fields; wired into the typed pipe + ORDERED_STAGES + a tunable
GenParams["fields"] slice; snapshot unchanged, runner now 12 stages). **commit 3 LANDED (`663bc49`)**
— Atlas-inspector heat overlays (a "fields" viewer + plane select, encodeState/decodeState `__planes`
bundle, round-trip unit-tested) + the `fields` GenParams sliders tune the formulas live, no re-bake.
**DERIVE + VISUALISE + TUNE done.** **2b-ii LANDED + RE-BAKE-VERIFIED** (`<this commit>`): state.fields →
TileInit → TileInitWire(fieldsB64) → upsample (nearest-resample, NaN-safe water) → atlas_terrain →
chunksFromBuffers(32² slice) → setChunk* — every chunk now carries the atlas-DERIVED Veg/SurfaceState/
Water grids. Verified live: brought the docker stack up, `POST /world/bake` ran the fields stage +
serialised fieldsB64 into the stored wire (canopyLight max 255 / ruinAge max 246 / traffic from paths,
via GET /tile), and the tile-server loaded the re-baked world cleanly ("atlas terrain loaded" + booted) —
the re-bake caught + fixed a real transition crash (old worlds lack fieldsB64 → graceful zero planes).
**FieldExpr (G2) evaluator also landed** (`content/field_expr.ts`). **PHASE 3 COMPLETE** (grids minted +
derived + threaded to chunks + inspector + FieldExpr). **Phase 4 STARTED + LIVE-VERIFIED:** client stores the per-chunk field grids (`client_world` maps +
getters) and **field-driven scatter density** landed — `ScatterDef.densityField` (FieldExpr) replaces
the flat hash gate; `scatter_renderer` evaluates it per cell (dense in fertile/shade, receding on dry
rock/paths); 4 foliage defs authored; loader boot cross-check. **Verified live on the running stack:**
re-baked world → tile-server re-derives chunks with fields → AoI → client receives + STORES them
(probe: fertility 66–167, canopyLight 0–255, traffic 0–255, all varying per cell) → scatter reads them.
The live loop caught + fixed 3 integration bugs (re-bake decode crash on old worlds; stale-save bypass;
the T-312b save-load field gap). **FieldExpr (G2)** evaluator also landed. **Scatter CLUSTERS landed +
LIVE-VERIFIED:** `ScatterDef.cluster {count:[min,max], radius}` — a matching cell seeds a field-sized
clump (count lerped 0→max by the cell's field density, scattered in a disk) instead of a single prop, so
fertile/shaded cells read DENSE and dry rock thins to nothing; all instances of a cell share one handle.
Authored into grass (0-5, r1.4) + fern (0-3, r2.2). End-to-end live proof on a SAVE-loaded world after the
T-312b fix: fields reach the client (fertility 66-167, canopyLight 0-255 varying), all 256 chunks decorate,
962 scatter instances place (oak 792, grass 133 clustered, fern 31, rock 6) — visually a dense forest.
**Bush/mushroom zero-placement SOLVED** — the live placement-funnel probe traced it to THREE substrate
bugs, all fixed: (1) FieldExpr inverted windows (min>max, the "denser in shade" idiom) silently degenerated
to a raw≥max threshold via the `span<=1e-6` guard — the declutter pass (415dad2) actually placed ZERO oaks
(`15b4862`); (2) round() on the cluster-count lerp cliffed everything under density 0.25 to empty
(`90a8979`, stochastic hash-dithered rounding — field decides expected count, hash only dithers);
(3) hash2u was Perlin integer noise whose low 16 bits are garbage on cell lattices (median 56576/65535) —
every `(h&0xffff)` probability gate was broken, the REAL bush=0 cause + a near-constant variant pick
(`08d46c8`, murmur3 mix32). Plus the atlas gap the probe exposed: fertility was near-FLAT outside chambers
(no signal could carry groves at all) → **fertility dapple** fbm modulation in `deriveFieldPlanes`
(`feb10e4`, GenParams `fertilityDappleAmp/Scale`, re-bake). Defs re-authored to the MEASURED band
(ground fertility mean 0.26, band 0.14–0.45; `aee129f`): live-verified oak 962 grove-varied /
grass 9.6k / fern 4.8k / mushroom 1.4k / bush 173 / rock 296, paths clear, under InstancePool caps.
**Moss-creep LANDED** (`a46e14a`): `VoxelAtom.moss01` (G6 sidecar — DATA, palette stays the colour
carrier) from SurfaceStateGrid.overgrowth × `render.mossBlend` floor/wall bias (+jointBoost on terrace
ledges); bakeVoxels lerps the per-voxel tint via `resolveMossResponse`; byte-identical when absent
(test-pinned); authored on stone+gravel; Studio Material editor grew a Moss section with a MOCK
overgrowth ramp through the real bake (verified grey→mossy-green). **Wetness specular LANDED**
(`0b4b819`): the G4 **SurfaceTreatment registry** (sibling of TextureStyle; water + `render.reflect`
join in P5) with the `wet_specular` builtin — per-vertex `aWetness` (VoxelAtom.wet01 →
SurfaceFieldInput generalises the moss input) darkens diffuse + boosts Phong specular in-shader;
treatments CHAIN onBeforeCompile after canopyFade; authored on path/stone/gravel/dirt/mud; Studio
Wetness section verified dry-tan→wet-dark. **Corruption-morph LANDED** (`f28733f`):
`ProcModelDef.morphTiers` (≤3 deep-merged param overrides = ≤4 tiers, loader-validated) +
`ScatterDef.morphField` (FieldExpr, cross-checked incl. tier membership); ScatterRenderer builds a
variant pool PER TIER and buckets each cell's SERVER corruption — the field decides the form, never a
hash; fern/grass/oak authored (withered → corrupted purple husk), live-verified tier counts (fern t0
4760 / t1 12 / t2 30 — healthy the norm, corruption marks the old chambers).
**Decals LANDED (Q8 resolved by user: EPHEMERAL)** (`97510c7`): in-memory + decay, never saved, never
networked — no DecalGrid wireId (transient state doesn't earn a permanent wire slot; late-joiner gaps
self-heal by decay). `DecalDef` content category (`data/decals/*.json`, full plumbing, BOOTSTRAP_VERSION
17) + the client decal-source registry over the closed event catalog (`damage`/`death` — wire GameEvents
carry the WHERE/HOW-STRONG: DamageDealt hit contact point + amount intensity, blocked draws none;
EntityDied pools at the entity) + `DecalRenderer` (thin voxel slabs via InstancePool — no alpha quads;
slab-by-slab crumble decay; MAX_SPLATS=160 perf cap; tile-transition reset; `blood` material id 33).
Live-verified: stimulated wire events → splats at player, blocked skipped, fast-forward decay → 0.
**PHASE 4 COMPLETE** (field-driven scatter density/clusters · corruption-morph · moss-creep · wetness
specular · ephemeral decals). **P4 follow-up (`f7eb022`):** cliff edges are now warped voxel STACKS — the T-310 inset-ziggurat
voxeliser is DELETED (with it the recede-degeneration bug family, incl. vanishing 1-wide ridges). A cliff
cell piles 2–5 full-footprint stone boxes base→lip; the hand-stacked read comes from the per-voxel
language alone: exposed-face warp (`render.relief.warp`, the relief block's first consumer; deterministic
voxHash, welded faces/z/top stone exact), per-voxel tint, corner displacement, per-stone Sobel ink.
Live-verified: the pale zigzag ledge artifacts on every cliff edge are gone, TRIS 1718k→1679k. The
stack TRIGGER stays the client stopgap P6 retires — the stacked-stone language survives on the atoms.
**Stacked-voxel language completed (`dc93a14`, `3dd769a`):** `VoxelAtom.dispSeed` decorrelates a voxel's
corner warp from the world-position weld — stones/slabs poke out of the merged mesh, clip into each other
(deliberate) and get their own facet normals (per-stone light); oversize-into-known-solid (≥ max corner
roll) guarantees gaps never see through the wall. Extended to the walkable floor as
`relief.surfaceWarp` + `surfaceWarpField` (FieldExpr, boot-checked): rough clod-mosaic wilderness,
perfectly smooth trodden paths (traffic-inverted) — one grammar, two consumers; field sampler shared
(`field_sample.ts`). **Found + fixed en route: ALL terrain had rendered FALLBACK grey** — the legacy
ContentCache never held ground materials, so getMaterialSync returned undefined and every
`MaterialDef.render` response silently no-opped on terrain; now falls back to the bootstrap
ContentService (scene-probe verified: real colours + textures live, golden paths, textured stone).
Grade retune against the REAL material colours is an open content follow-up.
**Civilization axis (`989fb8a`, user design principle):** `relief.disturbanceField` (renamed from
surfaceWarpField) is THE per-cell wildness FieldExpr (1 = wild, 0 = civilized) scaling every
voxel-disturbance channel: surface roughness, cliff-stack warp, and NEW the per-voxel tint mottle
(`VoxelAtom.tintScale`, 25% floor) — trodden/worked cells read flat + uniform + orderly, wilderness
rough + mottled. `path` authors `disturbanceField: []` (empty expr = always civilized). Next: **Phase 5** — AtmosphereDef + server sun-arc (folds in the deferred
T-310 arcing sun) + creature fragmentation (G6/I3b) + cheap water reflection.
**Phase 5a LANDED (lane/atmosphere):** `sun_arc.ts` (dependency-free pure altitude/azimuth/direction
function, unit-tested incl. midnight-wrap continuity) + `AtmosphereDef` content category (sun path, ground
mist, near-field god-ray params — day/night COLOUR stays on `Palette.phases`, not duplicated). **Resolved
the I2 render-context-key gap**: 0b/0c/0d were deliberately deferred and never actually landed (verified —
`GradeDef` still hardcodes `cache.getGrade("default")`); P5a builds the selector as `WorldClock.biomeTag`
(reuses the existing wireId 23, no new wire field), computed atlas-side via the existing `biomeTag()` ladder
(already used by zone_namer) from the tile's `WorldCellRecord.biome` — one value per tile, no re-bake
needed since biome is DB cell metadata, not baked into the tile_init buffer. `environment_lighting.ts`
now computes the sun direction every frame from the server clock via `sunArc()`; the shadow-camera basis
is recomputed per-frame (was a one-time precompute); `SUN_DIR` is deleted everywhere (grep-swept). Ground
mist landed as an EdgePass composite term (reuses the pass's existing depth reconstruction — no new
render target) with per-phase density from `AtmosphereDef.mist`. God-ray params (the existing
screen-space radial-scatter pass, near-field-only by construction) now come from `AtmosphereDef.godRay`
instead of hardcoded literals. Zero look-change at noon (pinned regression in `sun_arc.test.ts`). Full
suite 605/605 green throughout; atlas snapshot suite unaffected (biomeTag is additive metadata, not baked
into any buffer). Next: **Phase 5b** — WaterStyleDef + water_renderer rebuild, reusing this same
biomeTag selector.
**Phase 5b LANDED (lane/atmosphere):** `WaterStyleDef` content category (wave/fresnel/specular shader
params + base colour, `data/water_styles/default.json` freezing today's literals verbatim) — selected via
the SAME `WorldClock.biomeTag` key P5a's AtmosphereDef uses (the point where I2's "one render-context key,
not three wire bumps" promise is actually redeemed: two independent consumers now share it). `water_renderer.ts`
rebuilt wholesale on `WaterGrid.surfaceLevel`: the KindGrid-derivation path, the client-mirrored
`RIVER_DEPTH` constant, and the pending/tryBuild wait machinery are all deleted (closes the T-315 comb
note); geometry now merges contiguous same-height row runs into single quads (unit-tested, 5 new headless
tests — no THREE scene dependency needed for pure geometry). Cheap wetness-weighted reflection shipped as
two additive consumers of the wet_specular's existing `aWetness` input: a sky-tinted `reflect()` term in
the water shader (EnvironmentLighting is now also the single sky-colour owner via `getSkyColor()`), and a
new `wet_reflect` SurfaceTreatment for wet ground materials (`render.reflect`, unused since G4 until now) —
no render-to-texture, no probe, no SSR (the full planar probe stays a named T-313 follow-on). Full suite
610/610 green throughout. This closes the atmosphere lane's scope (P5a+P5b); P5c (creatures) and P6
(terrain) remain, owned by other lanes.

**Phase 5c LANDED on `lane/creatures` (creature fragmentation, G6/I3b — see
`prompts/T-311-P5c-dissolves.md`):** `dissolutionPhase` f32 appended to
`AnimationStateData` (wire id 14 unchanged, purely additive tail field) —
DERIVED each tick by `AnimationSystem` from `Resource.values["dissolve_timer"]`,
never mutated by ResourceSystem directly (ResourceSystem runs before
AnimationSystem in declared order, and AnimationSystem fully replaces
AnimationState via `world.set` every tick, so a same-tick `world.mutate` from
elsewhere would be silently clobbered). `DissolveProfileDef` content category
(`data/dissolve_profiles/*.json`, mirrors DecalDef's plumbing; one profile
authored, `drowner_rot`) + `NpcTemplate.dissolveProfileId`, boot-cross-checked.
**Architecture correction vs. the prompt's literal wording:** death-dissolve
start is a `shed_dissolve` **DeathHook**, not an `entity_died` Trigger — the
pinned `bossfight.test.ts` test ("an entity_died Trigger ... does NOT fire")
already proves that wiring is structurally inert (TriggerSystem's buffered
drain runs one tick after DeathSystem has already `world.destroy()`-ed the
entity; see `components/boss_arena.ts`'s header). `DeathHook.onDeath` gained an
optional `{ linger: true }` return so a profiled corpse can defer
`world.destroy` to its `dissolve_timer` Resource's terminal threshold
(`cross@0` → the already-registered `destroy_self` effect) instead of despawning
same-tick; default behaviour for every other death (players, non-profiled NPCs,
the boss) is unchanged. Client: G6 sidecar extended (`VoxelAtom.fray01`/
`driftDir` → `aFray`/`aDriftDir`, byte-identical when absent) + an isolated,
cleanly-revertible in-shader drift patch (`dissolve_shader.ts`, per-vertex
`transformed +=` offset only, zero CPU re-bake) + a Studio Dissolve panel
showing the I3b caps live. **I3b MEASUREMENT: PASS** (post-merge, live stack,
2026-07-06): 6 drowners killed in one burst via the new `DebugKillEntity` dev
command (harness commit 148446f); baseline with 14+ live drowners on screen
POST 0.3–0.8 ms (median ~0.45), during 6 simultaneous dissolves POST
0.4–1.2 ms across 6 mid-dissolve samples in two runs — worst-case increase
+0.75 ms, typical +0.2–0.5 ms, within the ≤~1–2 ms bar (headless software-GL,
so absolute costs are conservative). GL stayed inside its baseline noise band
(8–14 ms). The measurement also FOUND AND FIXED a shipped P5c bug: no corpse
ever dissolved live — DeathSystem's health<=0 sweep re-killed the lingering
corpse every tick and shed_dissolve re-seeded `dissolve_timer` back to 60/60
after each ResourceSystem decrement (commit 87843e6, regression-pinned in
shed_dissolve.test.ts; the lane's tests never re-ran DeathSystem after the
linger vote). Known
v1 scope gap (documented at `ContentCache.getSoleDissolveProfileSync`): the
wire carries no per-entity archetype id, so the client resolves "the sole
registered profile" rather than a true per-entity lookup — correct today
(one profile exists) and a safe no-op the moment a second is authored.

### T-312 · Visual content-authoring arc — fill the libraries the look needs
Effort: XL   Status: planned (blocked on T-311 tools)

T-311 delivers the **machinery** (field grids, registries, devtools, render hooks); the art-bible look
only *appears* once content is authored against it. This is that authoring arc — the bulk of the visible
result, and weeks–months of work even with the tools. **Goal: the layered DENSITY of the screenshots**
(`ART_DIRECTION.md §1`), reached by composing small primitives (`VISUAL_DATAMODEL_PLAN.md §Density through
composition`). **Discipline: hero-cell → hero-scene → propagate** — get ONE patch fully dense in the
devtool until a screenshot crop is matched (the density vertical-slice), then let the field grids + biome
tables replay that recipe across the world. Do NOT hand-place; tune one recipe and scale by data.

Each sub-library is gated on its T-311 phase tool:
- **Flora & ground-cover library** — ~12 generators (fern/moss/root/vine/mushroom/grass/thorn/…) ×
  healthy↔corrupted, biome-tuned `ScatterDef`/`ProcModelDef`. Tool: T-311 P1 ProcModel + Scatter-Field-Painter.
- **Ruins/props/landmarks library** — chapels/altars/statues/tombs/gates/monoliths + caravan/barrel/crate/
  well/chest/banner prefabs, sacred↔corrupted + wear states (the ruins + props sheets). Tool: P1 Material + P2 StateLadder.
- **Creature roster** — the haunts (Wailing Shade, Hollow Lantern, Grief Husk, Mirror Stalker, …) as
  `voxel_creature` procmodels + `DissolveProfileDef`s + skeletons. Tool: P5 Creature/Dissolve panel.
- **Settlement module library** — the full tier × upgrade-stage × road-kit content beyond T-311 P7's
  "one strategy + a handful of modules". Tool: P7 Module Composer.
- **Atmosphere/grade/material polish pass** — `AtmosphereDef`/`GradeDef`/`render`-block tuning per
  biome × time-of-day; the final mood pass. Tool: P5 Atmosphere + P2 Grade panels.

LLM-assisted seeding (SPEC L22) is the intended accelerant. Without this arc, T-311 is a richly-capable
engine rendering a sparse world — the capability gap is closed but the look is not yet authored.

### T-330 · Water planar-reflection probe — the canal-city mirror
Effort: M   Status: todo

Split off T-313 item 4 (deliberately deferred, not built there — see that ticket's closing note). P5b
(`water_renderer.ts`) already ships a cheap screen-space sky-tinted `reflect()` streak keyed off the
existing `wet_specular` `aWetness` input — good enough for ambient wet-surface sheen, but not a true mirror.
This ticket is the quality follow-on: a real planar-reflection render — a second scene pass from a
mirrored camera into its own render target, ordered correctly against the outline (Sobel/EdgePass) and
bloom passes in the existing hand-rolled (no-EffectComposer) pipeline, sampled by the water shader instead
of (or blended with) the sky-streak term. Fragile by nature (a second full scene traversal, camera-plane
mirroring, and RTT-ordering against a pipeline that already has 3+ interleaved passes — see
`shadow_cascade_pass.ts`'s header for how T-313 reasoned about a similar RTT-ordering problem) and only
pays off where water is actually on-screen, so it's explicitly NOT a blocker for anything else. Done when:
a water surface visibly mirrors nearby geometry (not just sky), the pass is skipped/cheap when no water is
on-screen, and the near-field god-ray/bloom/EdgePass ordering established by T-313 is undisturbed.

## Player UX

## Heritage & Dynasty

### T-080 · Dynasty reputation persistence in NPC world
Effort: L (cross-service arc)   Status: todo   (premise corrected — deferred; needs the prerequisite chain below)

GOAL (unchanged): on heir spawn, the new character inherits the dynasty's standing with NPC
cities; a predecessor's actions (king-killing, trade betrayals) persist as dynasty history, so a
new heir faces the same city attitudes. Reputation is keyed by `Heritage.dynastyId` (stable across
permadeath) — keying by dynastyId IS the done-condition.

PREMISE CORRECTION (2026-06 scope pass): the ticket's stated dependency is **false against the
code**. "NPC city relationship maps (T-044)" are **city→city** affinity (`CityState.relationships:
Record<cityId, -1..1>`, `coordinator/src/city_sim.ts`), NOT dynasty-keyed reputation (CHANGELOG
confirms T-044 shipped "city→city stance"). And the substrate this needs does not exist yet:
- Cities live in **Postgres + the coordinator**, not the tile-server (no CityRepo/city entities on a tile).
- NPC attitude is **dynasty-blind** — the only aggro path (`findDetectedThreat`) is proximity/sense
  only; there is no faction/reputation/hostility component anywhere.
- **No city-affiliated NPCs** are seeded (no guard template; `tile_layout.json` seeds a lone merchant).
- **No kill/betrayal → city-history pipeline**; `entity_died` is tile-local, only gate-crossings +
  a heartbeat reach the coordinator.

So this is a cross-service ARC, not a single ticket. Prerequisite chain (each its own ticket when
scheduled): (a) `CityState.dynastyReputation: Record<dynastyId, number>` in the coordinator (reuses
the `cities.state` jsonb — no migration) + a `CityRepo.adjustDynastyReputation` server-side merge;
(b) a `DynastyGrievance` WorldEvent + coordinator handler (tile publishes on king-kill/trade-betrayal
keyed by killer `Heritage.dynastyId`); (c) push per-tile dynasty attitudes down via TileCommand
(replace the log-only `onCommand`) into a server-only `DynastyAttitudes` cache; (d) a city-guard NPC
template + `CityAffiliation` marker; (e) gate `findDetectedThreat`/`set_job_attack_nearest` on the
attacker's dynastyId vs the city's attitude (data-driven thresholds in game_config). Deferred from
the Heritage batch because of this span.

---

## Territorial Control

### T-294 · Upper-terrain claims as POI metadata (not a second heightmap)
Effort: L   Status: todo

Implement ideas.md's upper/lower terrain as a SEMANTIC overlay on the existing single heightmap,
NOT a literal second elevation layer. A second heightmap doubles terrain wire + save size and
forces layered physics/fog for a feature whose content — claims, central POIs, building hubs,
fast-travel — is all metadata that lives on POI entities; the wilderness plateau already IS the
"upper terrain", and "lower navigation / upper for POIs" maps onto the path-floor-vs-plateau the
terrain already expresses. Build the core claim loop: add a server-only `Claim` component on POI
entities (`poiInstanceId`, `claimerId`, `timestamp`); mark central/hub POIs (`isCentral` on
`PoiDef` + a `TileNarrative` tag). Defeating a central POI publishes a `ClaimAcquired` event;
`TriggerSystem` fires a `grant_claim` effect on the victor (reuses the trigger primitive — no new
event→effect bridge). Persist claims in `HeritageStore` per player per tile (survives death/
disconnect). Gate building placement on owned claims (buildings snap to claimed POI anchors; each
claim unlocks a content-defined building set via `data/buildings`). Depends on T-212 (POI runtime)
/ T-213 (stairs). DONE: a player defeats a central POI, receives and keeps a claim across
reconnect, and unlocks claim-gated building options at that anchor; no second heightmap is
introduced; claim state is server-only for now. Defer claim-SHARING (others' spawnpoints / fast-
travel / sleeping) and minimap/fog claim overlays to follow-up tickets so this lands the core loop.

## Species

## Item Durability

## World / Environment

## UI / Interaction

### T-329 · Networked hotbar + backpack-gated inventory access
Effort: L   Status: todo

Split out of T-309 (done, lane/t309-hotbar, 2026-07-13) — the full vision that ticket originally
described but which its launching prompt explicitly scoped out as "its own arc, do NOT build it
here". T-309 landed a CLIENT-LOCAL hotbar (`HotbarState.assignments`, session-scoped, not
networked) and body-anchor rendering of non-active slung items, visible only to the local player
on their own screen. This ticket makes it real for everyone else and adds the access gate:

1. **Networked hotbar component.** A new server-authoritative component (wireId, codec in
   `@voxim/codecs`) replacing/superseding client-local `HotbarState.assignments` — the server
   is the source of truth for what's assigned to which hotbar slot and which slot is active, so
   every AoI-visible player's client can render the SAME slung-gear body anchors T-309 built
   (those anchors are already generic — they just need real data for remote entities, not only
   the local player). Decide the wire representation: unique items are entity-refs already
   (inventory slot → item entity), so the hotbar assignment is naturally `hotbarSlot →
   inventorySlot` (matching T-309's client-local mapping) or `hotbarSlot → itemEntityId`
   directly — pick one and make `EntityMeshRegistry.syncHotbar` read it for ALL entities with
   the component, not just the local player via the cached setHotbar() path.
2. **Backpack-gated inventory access.** No backpack item assigned to a hotbar slot ⇒ the
   inventory panel doesn't open (or opens empty/locked) — "the hotbar is what you carry on your
   body; the backpack is one slot that opens the bag." Needs: a backpack item concept (new
   Equippable-adjacent component or a `carryContainer` flag on a prefab?), the actual inventory
   capacity/access gate (currently `InventoryPanel` always opens if `uiState.inventory` is
   non-null), and a design decision on what happens to already-stored items when the backpack
   is unassigned (locked-but-visible vs fully hidden vs auto-drop — needs a design call, not a
   default to guess).
3. **Visible slot count by carry-gear.** T-309's step (3) — gate how many of the 8 hotbar slots
   are usable by what's equipped (a belt might grant 2 extra slots beyond the backpack's base
   set) — depends on (2)'s backpack/carry-equipment concept existing first.

Done when: hotbar assignment is server-authoritative and every player sees every other player's
slung gear (not just their own), and opening the burden panel is gated on having a backpack
slotted into the hotbar.

## Housing

### T-093 · Housing system — player-owned structures as persistent home
Effort: L   Status: todo

A house is a enclosed structure (walls + floor + roof, built via the blueprint system) that a
dynasty claims as their home base. Claiming converts a completed enclosure into a `HouseEntity`
tagged with the dynasty ID. The house is the social and mechanical anchor for a dynasty:

**Claiming:** Player interacts with the interior of a fully enclosed structure (detected via
T-090 room flood-fill) to claim it. Requires a placed family workbench (T-038) inside. A
structure can only be claimed by one dynasty. Claiming transfers the structure's wall/floor
entities to the dynasty's tag (T-083).

**Shelter mechanics:** Interior cells of a claimed house provide: corruption gain suppression,
warmth bonus (amplified further if a hearth/campfire is inside, T-089), and a safe-sleep
anchor for NPCs (T-039). These are computed from the `RoomTag` interior cell set (T-090).

**Persistence:** House ownership persists across server restarts as part of the save system.
On heir spawn (T-079), heir always appears inside the family house if it still stands.

**Destruction / capture:** Destroying enough walls dissolves the enclosure (T-090), which
dissolves the `HouseEntity`. The dynasty loses its home anchor. A new claimant can rebuild
and re-claim. This is the base-capture loop (T-082) applied to housing.

**Furniture:** Deployable items (bed, shelf, chest, hearth) can be placed inside. Furniture
carries the dynasty tag. Furniture items are defined in item_templates.json with a
`deployable: true` flag and an entity template for the placed form.

Done when: a player can build a fully enclosed structure, claim it as home, gain shelter
bonuses inside, and lose the claim when the structure is sufficiently destroyed.

**Prerequisite the enclosure/roof stack is waiting on (from T-066's live-verify, 2026-07-07):**
the wall-blueprint completion path currently never writes `OpenMask` — `BlueprintHitHandler.
applyToTerrain` only touches Heightmap/MaterialGrid, so a completed wall does not close a cell in
the grid `EnclosureSystem` reads. T-093 must make wall-blueprint completion (1) write `OpenMask`
(the cell becomes closed) and (2) let `EnclosureSystem` see it (the existing `BuildingCompleted` →
`markDirty` link then triggers the recompute). Once that lands, T-066's roof rendering activates
in-world for free (it is built + unit-tested, dormant only for lack of a live enclosure trigger —
POI room stamps close `OpenMask` at gen but never fire `BuildingCompleted`, so they don't roof
today either). Decide as part of T-093 whether POI cave-chambers should also roof (would need an
initial/boot enclosure compute) or whether roofs stay exclusive to player-built houses.

---

## Content Architecture

End-state: every distinct piece of game tuning is content; the engine ships small
generic algorithms that consume content; a single typed-registry federation owns
it all. Client and server share content via a WebTransport-handshake bootstrap
blob — no separate HTTP service, no client-side static bundle. Procedural
generators (loot, names, POIs, quests, dialogue) live as data declarations on top
of engine-side algorithms in `@voxim/content`. Tile-server crash → connection
dies → client reconnects → fresh content blob, version drift impossible.

T-173 unblocks immediate creature work and is independent of the rest. T-174 →
T-175 → T-176 → T-177 are the foundation, sequenced. T-178 → T-179 → T-180
together retire the per-creature skeleton sprawl. T-181 / T-182 / T-183 can land
in parallel once the foundation is in.

### T-183 · Unified generator framework
Effort: L   Status: todo

One concept and one entry point for everything procedural — voxel
geometry, loot tables, name generators, POI layouts, stat curves,
templated text. Algorithms are TypeScript code; generators are data
declarations that pick an algorithm and supply its params. Sharp split
keeps each layer testable in isolation.

Entry point:
  content.invoke<I, O>(generatorId: string, input: I): O

Algorithm registry (under packages/content/src/generators/algorithms/):
  voxel_shape    primitive volumes → ModelDefinition.nodes[]
                 (box / cylinder / sphere / capsule / cone / disc / …)
  voxel_compose  union / subtract / overlay multiple voxel outputs
  voxel_distort  twist / noise / taper post-pass
  voxel_recipe   morph-parameterised body part for T-186 Layer 2
  weighted_draw  loot tables, spawn weights
  markov         name generation from phoneme tables
  grammar        L-system / CFG for POI / settlement layouts
  template       placeholder substitution (quest / dialogue text)
  curve          piecewise-linear evaluator for stat scaling

Generator declarations (in content):
  data/generators/voxel/{id}.json    VoxelGeneratorDef
  data/generators/loot/{id}.json     LootTableDef
  data/generators/names/{id}.json    NameGeneratorDef
  data/generators/poi/{id}.json      PoiTemplateDef
  data/generators/curves/{id}.json   CurveDef

Each declaration: `{ id, algorithm, params }`. The algorithm registry
provides typed param schemas; the loader validates against them at
content-load and fails fast on bad params. Adding a new algorithm is
purely additive (register implementation + paramSchema → drop
declarations using it).

Determinism: every invoke accepts an explicit seed; same seed + same
params + same algorithm version → same output. Used for per-entity
body morphs (T-190), per-spawn loot, per-character names, etc.

Voxel editor (T-191b) consumes the framework directly — every
sub-object in the tree can be a generator invocation with sliders for
its declared params, live re-baking on param change.

First non-voxel migrations:
  - poi_placer's hardcoded room shape → grammar
  - corpse loot tables (wolf / drowner / rotten_knight) → weighted_draw
  - one name generator per culture → markov

Done when: poi_placer reads room shape from data; wolves drop loot
from a generator; spawned NPCs get generated names; voxel editor
spawns procedural sub-objects via the same registry; adding a new
algorithm is one file in algorithms/ + zero changes elsewhere.

### T-186 · Procedural character body generator (skeleton + voxel mesh)
Effort: L   Status: in-progress   (Layer 1 done via T-190; Layer 2 recipe voxelizer done, see below —
auxiliary work below remains open)

**Layer 1 delivered as part of T-190.** Sub-object voxel chunks now
stretch alongside bones via the existing morphParams table. Remaining
under this ticket: Layer 2 (procedural body-part recipes) — replace
authored body voxel positions with a recipe-driven voxelizer that fills
each part's volume from morph-parameterised dimensions at spawn. Adds
mass-distribution variety (thick thighs, broad shoulders, narrow waist)
that uniform per-axis scaling can't express.

Single-source-of-truth body shaper: per-character morph values (already
on ModelRef) drive BOTH skeletal proportions AND voxel geometry. A "long
legs" parameter stretches the leg bones AND elongates the leg voxel
chunks together, so the skeleton joint sits at the visible end of the
limb at every value of the slider.

Two layers:

  Layer 1 — sub-object voxel scaling alongside bone scaling:
    biped.json `morphParams` already lists which bones each morph
    affects + a `restAxis`. entity_mesh.ts applies these via boneScale
    {X,Y,Z} to bone rest offsets. Extend the same pass to scale any
    voxel sub-objects parented to those bones along the same axis.
    Adds ~30 lines, no schema changes. Covers: limb length, torso
    height, head size, hip width — anything that maps cleanly to
    "scale the bone segment + the visible chunk by the same factor".

  Layer 2 — procedural part recipes (replaces authored body voxels):
    biped voxel body becomes a recipe declaration instead of authored
    voxel positions. Each part declares a shape generator with morph-
    parameterised dimensions, e.g.
      { part: "torso_upper", shape: "tapered_box",
        length: "$torsoHeight",
        widthTop: "$shoulderWidth * 0.6",
        widthBot: "$hipWidth * 0.5", taper: "$torso_taper" }
    A voxelizer in @voxim/content fills each volume at spawn, keyed by
    the per-character morph values. Required when proportions need to
    affect body MASS distribution, not just length — e.g. "broad
    shoulders + narrow waist", "thick thighs", limb taper, asymmetric
    builds — things that uniform per-axis scaling can't express.

**Layer 2 delivered (lane "body", branch lane/body):** `BodyRecipeDef`/
`BodyPartRecipeDef` schema on `SkeletonDef` (`packages/content/src/types.ts`),
a shared pure evaluator (`packages/content/src/body_recipe.ts` —
`evaluateBodyRecipe`/`resolveBodyPartDims`/`bodyPartCapsule`/
`crossCheckBodyRecipe`, reusing `formula.ts` for morph-scaled expressions), a
`bodyRecipe` block on `biped.json` covering all 16 bones and all 10
morphParams (not just the 6 named in this ticket's prose above — biped grew
`right/leftArmScale` and `right/leftLegScale` since this text was written).
`bone_segment.json` and `scripts/build_skeletal.ts` are deleted outright —
every humanoid prefab (player/drowner/rotten_knight/villager/bandit/archer/
merchant, all `modelId: biped_skeletal`) now renders a recipe-voxelized body
instead of the 1-voxel-wide bone-colored debug cylinders every one of them
actually rendered through before this ticket (a placeholder, not a design
target — the "reads as a body, not a stick figure" bar was used instead of
byte-parity with that placeholder). Single source of truth for mesh AND
collision: `hitbox_derive.ts`'s skeletal-capsule fallback now resolves a
recipe-covered bone's capsule via the SAME `bodyPartCapsule()` dimensions the
mesh voxelizer used (previously a wholly separate hardcoded `BONE_RADIUS`
table, decoupled from any voxel geometry — the risk this ticket's "if
hitboxes derive from authored voxels" bullet named turned out to already be
latent rather than active, since the debug cylinders were never hit-boxed at
all; this landing is the first time collision and visuals share one source).
Studio: a Morph panel in `AnimationEditor.tsx` previews the recipe live
against slider values through the real `evaluateBodyRecipe()`. Payoff:
`bandit.json` morphRanges tuned for a thick-set silhouette (wide shoulders,
narrow hips, stocky legs) alongside `drowner.json`'s already-lanky profile.
Also fixed in the same lane: a latent hitbox-template cache-collision bug
(cache key didn't include morphValues) and a client mesh-build bug
(`entity_mesh_registry.ts` wasn't passing `ModelRef.morphValues` into the
mesh-build's `resolveMorphParams` call, so per-instance morph overrides never
reached the VISUAL body, only pose/hitbox-debug). See T-302's body for the
humanoid_grammar porting note this reduces to — **T-302 landed**: the
evaluator is unchanged (still the one body-volume evaluator) but is now
reached through `humanoid_grammar.ts`'s `humanoidGrammarByBone`/
`humanoidGrammar` on the ProcModel generator substrate instead of a direct
`evaluateBodyRecipe()` call from `entity_mesh_registry.ts`. **Foot IK — done**
(lane/t308-anim, commit 1625089, landed as part of T-308's "foot-on-terrain
IK": T-308's and this ticket's foot-IK items were the same work, per the
T-308 coordination note — `applyFootTerrainIK` in `swing_pose.ts` re-plants
feet at the local terrain height via `aimLimb`, so limbs scaled far from
authored proportions (or standing on a slope) still read as planted; see
T-308's entry for the mechanism). NOT done: posture overlay, character-creator
UI — ticket stays in-progress for that residual.

Auxiliary work:
  - Posture-overlay layer: small additive AnimationLayer composed from
    slider values (backlean, slump, alert) — pure rotation offsets on
    a few torso/neck bones. STALE PREMISE as originally worded: "runs
    alongside whatever Mixamo clip plays on the override layer" describes
    the pre-Action-primitive CSM (retired T-228) — there is no more
    "override layer" concept in the current `AnimationLayer`/action-driven
    pipeline (see T-308's `ActionAnimation`/fused pose pipeline). The
    underlying idea (a few additive rotation-offset sliders on torso/neck,
    composed on top of whatever pose is already playing) still fits the
    current base-pose-catalogue architecture as one more producer — but
    where the slider VALUES come from (a per-character stat? a stance
    toggle? NPC archetype flavor?) is a design call this note doesn't
    answer, left open rather than guessed.
  - Character-creator UI: live sliders mutate ModelRef.morphValues
    in-editor, baked to per-character permanent values on commit. Use
    only in the creator screen — for live characters morphs are
    immutable identity. Its own scoped UI/UX arc (creator screen flow,
    persistence, entry point) — not attempted here.

Property of this design: hit detection self-consistent at any morph.
blade.baseLocal/tipLocal are hand-bone-local; longer arms genuinely
reach further because the hand bone's world position is further out.
No retargeting maths needed.

Done when: the character creator screen exposes ~6 sliders that
visibly reshape the character (height, leg length, arm length,
shoulder width, hip width, head size); a saved character spawns into
the world at exactly those proportions; Mixamo animations play on
every body type without artifact; hits land at the new reach.

## Core Mechanics Depth

### T-341 · Build out the existing core mechanics (crafting · building · survival · NPCs/social)
Effort: XL (arc)   Status: needs-design   (user, 2026-07-14)

The core loops all EXIST but are thin — each is a skeleton that proves the mechanism without yet being a
game: crafting (recipes + workstations + the crafting-queue Resource), building (blueprints + the hammer
loop; note the OpenMask gap T-093 owns), survival (hunger/thirst/stamina as Resources; day/night; light),
NPCs & social (BT-driven archetypes, traders, job boards, the dynasty/heritage substrate).
This is the "make it a game" arc. It needs SORTING before building: for each of the four, decide what the
loop actually IS end-to-end, what is missing versus what is merely thin, and what the smallest version is
that makes it worth playing. Then it splits into real tickets.
Do NOT start building until that pass is done — otherwise it becomes four half-deepened systems.

### T-342 · Atlas rethink — a better mix of procedural generation and persistent world
Effort: XL (arc)   Status: needs-design   (user, 2026-07-14)

"Gute Ideen im Kern vorhanden, müssen sortiert und zu Ende gedacht werden." The atlas today bakes a whole
world from a seed (deterministic, regenerable, disposable) while the tile-server persists what players do
to it (terrain edits, POI state, saves). Those two truths pull against each other: what happens to a
player's house when the world is re-baked? What is authored, what is generated, what is remembered?
The arc: sort the existing ideas, decide the persistence model end-to-end (what survives a re-bake and
why; how procedural content and player history compose; whether the world is regenerable-from-seed at all
once it is lived in), and only then rework. This is the deepest architectural question left in the project
and it wants a design pass, not a lane.

## Ops & Deployment

