# Leather, Hide & Parchment

**Scope & gameplay role.** Hide processing is the classic long-chain craft: an animal
byproduct from butchery enters a tannery and leaves weeks later as armour padding,
belts, scabbards, book covers, parchment sheets, drum heads, or strong-bond glue.
The category sits at the economic junction of four other chains: food (butchery
supplies raw hides and offal), textiles (leather thongs, padded gambesons need linen
or wool cores, scoured hair can be felted), chemistry (lime, ash-lye, tannin liquor,
bone glue), and knowledge/lore (parchment is the physical substrate for tomes). It
serves the combatant (leather armour, sheaths, quivers, shield covers), the homesteader
(shoes, belts, thongs, harness), the trader (hide and finished leather were staple
medieval trade goods), and the specialist (parchment-maker supports the scribe).

Tanners were historically segregated to the downwind edge of towns because of the
smell (urine, lime, rotting flesh, fermenting bark liquor). The work is long, dirty,
batch-scale, and requires fixed infrastructure (pits in the ground, running water).
Every realistic gap in the Voxim workstation model shows up here.

**Chains documented.**
- **Vegetable (bark) tanning** — the canonical 8-step medieval leather pipeline.
- **Alum tawing** — short, white/luxury leather for gloves and fine goods.
- **Brain tanning** — buckskin; frontier/hunter tradition, uses the animal's own emulsion.
- **Parchment / vellum** — non-tanned writing substrate; shares prep with tanning then diverges.
- **Rawhide** — the minimal chain: scrape, stretch, dry. Shields, thongs, drum heads.
- **Hide glue** — trimmings and scraps boiled down to gelatin adhesive. Cross-chain glue.
- **Currying and dubbing** — finishing pass on tanned leather; waterproofs for harness/boots.

---

## Chain: Vegetable (Bark) Tanning

**Real-world context.** The dominant technique across medieval Europe, the Near East
and much of Asia from antiquity to the 19th century. Hides are slowly penetrated by
tannin-rich liquor made from ground oak, chestnut, hemlock or mimosa bark; polyphenols
cross-link the collagen and render it rot-proof, flexible and strong. A thick ox hide
took six to eighteen months in the pits historically, with tanners moving hides from
weak "handler" liquor through progressively stronger baths. This is the main chain
that produces armour-grade leather.

**Gameplay role.** Produces `leather` — the input for gambeson padding, belts, sheaths,
quivers, strap material on wooden shields, saddlery, bookbinding. Voxim currently has
no leather item (scan of `packages/content/data/items/` confirms); this chain is the
prerequisite for an entire equipment sub-tree. `hair` and `lime_sludge` are the
notable byproducts; `spent_bark` is compostable fuel-tier trash.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | `raw_hide` ×1 | skinning_knife | — | Dropped by butchery of any large mammal; not a recipe. |
| 2 | cure | salting_floor | `raw_hide` ×1, `salt` ×2 | `cured_hide` ×1 | — | 500 | `stepType: time`. Salt draws water; hide becomes stable for transport/storage. Real: ~1 week. |
| 3 | soak | soaking_vat | `cured_hide` ×1, `water` ×3 | `soaked_hide` ×1, `brine_waste` ×1 | — | 200 | `stepType: time`. Rehydrates and softens. `chainNextRecipeId` → liming. |
| 4 | leach + soak | lime_pit | `soaked_hide` ×1, `quicklime` ×1, `water` ×3 | `limed_hide` ×1, `lime_sludge` ×1, `loose_hair` ×1 | — | 600 | `stepType: time`. Alkaline swelling loosens hair and opens fibre structure. Real: 3–10 days. **Interesting step.** |
| 5 | scrape | beam (`fleshing_beam`) | `limed_hide` ×1 | `dehaired_hide` ×1, `hair` ×1, `flesh_scraps` ×1 | fleshing_knife | 0 | `stepType: attack`. Hair comes off the grain, fat and membrane off the flesh side. Scraps feed hide_glue. |
| 6 | bate | bating_tub | `dehaired_hide` ×1, `bran` ×1, `dung` ×1 (or `bird_droppings` ×1) | `bated_hide` ×1, `spent_bate` ×1 | — | 300 | `stepType: time`. Enzymatic relaxation of swollen fibres — historically dog or pigeon dung. Optional in-game; could be folded into step 5 to spare players the dung step. |
| 7 | tan | tanning_pit | `bated_hide` ×1, `bark_liquor` ×4 | `tanned_hide` ×1, `spent_bark` ×2 | — | 1800 | `stepType: time`. **The long step.** Real: 6–18 months compressed to ~90 s. Hide sits in liquor soaking up tannins. Must be outdoors near water. |
| 8 | press + dry | drying_rack | `tanned_hide` ×1 | `crust_leather` ×1 | — | 400 | `stepType: time`. Surface drying. Real: several days. |
| 9 | curry | currying_bench | `crust_leather` ×1, `tallow` ×1 | `leather` ×1 | slicker | 0 | `stepType: attack`. See separate currying chain below; this final pass produces usable hide. |

Side-recipe: `bark_liquor` is made at a `bark_mill` (or `quern`) from `oak_bark` ×3 +
`water` ×2 → `bark_liquor` ×4, ticks 150. Oak bark itself is a gather from any oak
stump as a byproduct of felling.

**Primitive verbs exercised:** cure, soak, leach, scrape, bate (new? — probably just
`ferment` with enzyme inputs), tan, press, dry, curry.

**Workstations introduced:** `salting_floor` (flat surface, covered), `soaking_vat`
(water-filled tub), `lime_pit` (dug pit, caustic), `fleshing_beam` (angled log, scraping
surface), `bating_tub`, `tanning_pit` (dug pit, must be near water — see GAP-ENV),
`bark_mill` or shared `quern`, `drying_rack`, `currying_bench`. **Nine distinct
stations for one chain.** A working tannery is a whole town district.

**Byproducts and their fate:**
- `hair` → textile/felting chain (wool/hair batt for padding, felted hats).
- `flesh_scraps` → hide_glue chain or dog food.
- `lime_sludge` → disposed, or contribution to a future mortar chain.
- `brine_waste` → discarded.
- `spent_bark` → compostable, low-tier fuel.
- `spent_bate` → discarded (good riddance).
- `loose_hair` in the lime bath overlaps with the fleshing output; treat the fleshing
  output as canonical.

**Knowledge gating:** `requiredFragmentId: lore_tannery_craft` — a single unlock that
opens the bark-tanning recipe chain. Players who haven't learned it can still rawhide.

**Engine gaps exposed:**
- **GAP-ENV** — the tanning pit is the flagship case. Historically dug into clay near
  a stream (for water supply and for dumping waste). Authoring this as a prefab that
  places anywhere flattens the entire geographical flavour of tanneries. Needs "adjacent
  to water tile" placement rule, maybe a downwind-of-settlement placement penalty.
- **GAP-CHECKPOINT** — how does a player or NPC know a hide is tanned through? Real
  tanners cut a corner, looked at the cross-section; full penetration meant done.
  The recipe's atomic timer hides this judgment. Fine for v1 (timer = done), but a
  richer simulation would expose "undertanned" vs "overtanned" pulls.
- **GAP-BATCH** — real tanning pits held 20–100 hides at once. Liquor was shared across
  hides; a single hide hogging an entire pit is economically absurd. Voxim's
  "one recipe per station" model forces either (a) one-hide-per-pit with long ticks, or
  (b) recipes that take 50 hides in and emit 50 out in one go. Neither matches how a
  player interacts with it. This is the largest simulation gap for the category.
- **GAP-STATE** — a tanning pit's liquor ages. Fresh pit = weak; used pit = strong.
  Historical tanners moved hides from weak to strong liquor across pits. Could model
  as a station-local `liquor_strength` scalar that recipes consume. Currently the
  station has no such slot.
- **GAP-PROCESS-PARAM** — temperature matters (warm liquor tans faster); humidity of
  the drying loft matters (too fast = crack, too slow = rot). No parameter support.
- **GAP-SKILLED-YIELD** — a skilled tanner extracts more from less bark.

**Variants worth noting:** oak bark is the European standard; chestnut gives browner
leather; hemlock (North American) gives redder leather; mimosa (tropical) is fastest.
In-game these can be `alternates` on the bark input rather than separate chains.
Also oak-galls and sumac produce similar tannin-rich liquors and were used for fine
goods.

---

## Chain: Alum Tawing

**Real-world context.** A non-tan treatment with potassium aluminium sulphate
("alum"), salt, flour, egg yolk, and sometimes olive oil. Produces a soft white
leather that was the medieval standard for gloves, fine clothing, bookbinding, and
purse/pouch goods. Technically reversible — wet tawed leather can be washed back
out — so it never replaced vegetable tanning for armour or harness. Guilds of
`whittawers` existed separately from tanners in most major towns.

**Gameplay role.** Produces `white_leather` — soft, supple, high trade value but
poorer structural properties than bark-tanned. Use for noble-tier gloves, fine
bookbinding covers, pouches. Material multiplier: low armour value, high trade price.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | (shared with bark tanning) | — | — | `dehaired_hide` ×1 | — | — | Reuse steps 1–5 of bark tanning up to dehaired hide. |
| 2 | blend | mixing_tub | `alum` ×1, `salt` ×1, `flour` ×1, `egg_yolk` ×1, `water` ×2 | `taw_paste` ×1 | — | 60 | `stepType: time`. The distinctive ingredient list is the hook. |
| 3 | taw | tawing_drum | `dehaired_hide` ×1, `taw_paste` ×1 | `tawed_hide` ×1, `taw_dregs` ×1 | — | 500 | `stepType: time`. Real: 2–4 days of repeated working. **Interesting step.** |
| 4 | dry + stake | staking_bench | `tawed_hide` ×1 | `white_leather` ×1 | slicker | 0 | `stepType: attack`. Staking = flexing the hide repeatedly over an edge to keep it supple. |

**Primitive verbs exercised:** blend, taw (new — propose as a primitive), stake
(mechanical flex; could collapse into `knead`).

**Workstations introduced:** `mixing_tub` (could reuse soaking_vat), `tawing_drum`
(historically just a tub with paddle, later a rotating drum), `staking_bench`.

**Byproducts and their fate:** `taw_dregs` → discarded; might be flagged as fertiliser
in a future farming chain.

**Knowledge gating:** `requiredFragmentId: lore_whittawer_craft` — separate from
bark tanning. Reflects the guild separation.

**Engine gaps exposed:**
- **GAP-BATCH** — same as bark tanning; tawing drums held many skins at once.
- **GAP-QUALITY** — the quality of tawed leather depended enormously on the skill of
  the staking; skilled craftsmen produced glove-grade, unskilled ones got stiff trash.
- **GAP-DURABILITY** (reverse) — real tawed leather degrades in water. No way to
  express "this item loses condition when wet" in the item model today.

**Variants worth noting:** Cordovan (originally Moorish Córdoba) is a goat-skin
variant with horse-shell infill; authoring it as a separate chain is probably
redundant — a material alternate on the input slot is enough.

---

## Chain: Brain Tanning

**Real-world context.** The pre-agricultural tanning method, practised across the
Americas, Arctic, northern Eurasia, and historically by European hunter cultures
before vegetable tanning took over. The emulsified lecithin in animal brain acts as
a fatliquor that coats the fibres as the hide is worked and dried; combined with
stretching and smoke, this produces soft, breathable buckskin. Every mammal's brain
is roughly enough to tan its own hide — a convenient economic fact that needs to be
reflected in recipe inputs.

**Gameplay role.** Produces `buckskin` — a soft leather with different material
properties than vegetable-tanned (more breathable, less dense, quieter — gameplay
hook for stealth/hunter gear). Primitive tier: no alum, no bark, no long pit. The
hunter archetype can produce usable leather without settling near a town.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | `raw_hide` ×1, `brain` ×1 | skinning_knife | — | Brain is a byproduct of butchery on the same animal. |
| 2 | scrape | fleshing_beam | `raw_hide` ×1 | `scraped_hide` ×1, `flesh_scraps` ×1 | fleshing_knife | 0 | `stepType: attack`. No lime; dehair optional (hair-on buckskin exists). |
| 3 | blend | — (handcraft) | `brain` ×1, `water` ×1 | `brain_emulsion` ×1 | — | 40 | `stepType: time`. Warm mash. |
| 4 | work-in | staking_bench | `scraped_hide` ×1, `brain_emulsion` ×1 | `brained_hide` ×1 | — | 200 | `stepType: time`. Hide repeatedly rubbed with emulsion. |
| 5 | stretch + dry | staking_bench | `brained_hide` ×1 | `dry_buckskin` ×1 | — | 300 | `stepType: time`. Must be worked continuously as it dries or it goes hard. **Interesting step.** |
| 6 | smoke | smoke_pit | `dry_buckskin` ×1, `punky_wood` ×2 | `buckskin` ×1 | — | 400 | `stepType: time`. Smoke sets the fibres — washable without reverting. See GAP-ENV: open smoke pit requires outdoor placement. |

**Primitive verbs exercised:** scrape, blend, work-in (could be `knead`), stretch,
dry, smoke (use the existing `cure` with a smoke-source input).

**Workstations introduced:** `smoke_pit` (shared with smoked-meat chain in food
category — a good cross-category reuse). `fleshing_beam` and `staking_bench` reused
from other chains.

**Byproducts and their fate:** `flesh_scraps` → hide_glue or food. `brain` once used
is consumed. No spent-bark-style waste; this chain is very clean. Culturally
appropriate for the "no settlement required" narrative.

**Knowledge gating:** `requiredFragmentId: lore_hunter_tanning` — differs from the
settled-tannery fragment. A hunter-archetype player unlocks this without discovering
bark tanning.

**Engine gaps exposed:**
- **GAP-ENV** — smoke pit needs open sky; staking needs protection from wind/rain.
- **GAP-CHECKPOINT** — hide must be worked *as it dries* — there's a window, not a
  point, for the "work-in" step. Current atomic recipe model flattens this.
- **GAP-PROCESS-PARAM** — colder ambient temperature slows the work; a winter
  buckskin session is harder than a summer one.

**Variants worth noting:** egg yolk, liver, or bone marrow can substitute for brain
in pinch; these are `alternates` on the emulsion input. Smoke colour (white birch =
pale; rotten oak = dark) determines the cosmetic colour of the output — a material
slot candidate.

---

## Chain: Parchment / Vellum

**Real-world context.** The medieval writing substrate, dominant from late antiquity
until paper arrived in Europe in the 13th–14th centuries and only fully displaced by
the 15th. Calf (vellum), sheep or goat hides were limed and dehaired like leather,
then — crucially — *not* tanned, but stretched wet on a rectangular frame and
scraped with a crescent-shaped `lunellum` as they dried. The wet-to-dry stretching
re-aligns the collagen fibres into a thin translucent sheet that takes ink without
bleeding. A monastic scriptorium's annual output was hide-count-limited.

**Gameplay role.** Produces `parchment_sheet` — **the input to lore tomes**, which
already exist in Voxim as the delivery vehicle for skill fragments. This is the
direct category-to-category bridge: hide processing gates knowledge. Currently a
scribe-style chain doesn't exist, so parchment would be the missing upstream step
for the entire knowledge-unlock economy.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | (shared) | — | — | `raw_hide` ×1 | skinning_knife | — | Best: calf_hide or goat_hide. Material slot into `parchment_sheet`. |
| 2 | cure | salting_floor | `raw_hide` ×1, `salt` ×2 | `cured_hide` ×1 | — | 500 | As bark tanning step 2. |
| 3 | soak | soaking_vat | `cured_hide` ×1, `water` ×3 | `soaked_hide` ×1, `brine_waste` ×1 | — | 200 | As bark tanning step 3. |
| 4 | leach + soak | lime_pit | `soaked_hide` ×1, `quicklime` ×1, `water` ×3 | `limed_hide` ×1, `lime_sludge` ×1 | — | 600 | As bark tanning step 4. |
| 5 | scrape | fleshing_beam | `limed_hide` ×1 | `dehaired_hide` ×1, `hair` ×1, `flesh_scraps` ×1 | fleshing_knife | 0 | As bark tanning step 5. Same intermediate. |
| 6 | stretch | parchment_frame | `dehaired_hide` ×1 | `stretched_hide` ×1 | — | 0 | `stepType: attack`. Laced onto rectangular frame with cords through pricked edges. |
| 7 | scrape-thin | parchment_frame | `stretched_hide` ×1 | `raw_parchment` ×1, `parchment_shavings` ×1 | lunellum | 600 | `stepType: time` with `requiredTools: [lunellum]`. **Interesting step** — the crescent blade is distinctive enough to warrant its own tool item. Real: 2–5 days of intermittent scraping as the hide dries. |
| 8 | cut + finish | parchment_frame | `raw_parchment` ×1, `pumice` ×1, `chalk` ×1 | `parchment_sheet` ×4 | knife | 200 | `stepType: time`. Pumice smooths, chalk whitens. One hide yields ~4 usable sheets. |

**Primitive verbs exercised:** cure, soak, leach, scrape, stretch, scrape-thin
(could be plain `scrape` with the frame station doing the work), cut, polish
(consider adding as a primitive).

**Workstations introduced:** `parchment_frame` (rectangular wooden frame — a
distinctive silhouette). Tool: `lunellum`. Everything else reused from tanning.

**Byproducts and their fate:**
- `parchment_shavings` → **directly feeds hide_glue** (this is how medieval
  parchmenters funded their waste — shavings were prime gelatin stock). Excellent
  cross-chain economic loop.
- `hair`, `flesh_scraps`, `lime_sludge`, `brine_waste` as per bark tanning.

**Knowledge gating:** `requiredFragmentId: lore_parchment_craft` — a monastic/scribe
unlock. Probably lootable from ruined monasteries or taught by scribe NPCs. Strong
candidate for a rare fragment because of its downstream effect on the knowledge
economy.

**Engine gaps exposed:**
- **GAP-CHECKPOINT** — parchment-making is the canonical "judge it as it dries"
  craft. A skilled parchmenter scraped heavier where the hide was too thick,
  lighter where it was already thin. Atomic recipe loses this entirely; the
  `chainNextRecipeId` workaround of "scrape 1", "scrape 2", "scrape 3" would be
  tedious. Flag this as the chain where the workaround is worst.
- **GAP-ENV** — parchment drying needs a consistent climate. Historically done in
  covered but ventilated lofts. Too dry → cracks; too damp → mildew.
- **GAP-QUALITY** — a scribe's tome is only as good as the sheet. High-quality
  parchment should make a higher-quality tome; Voxim currently has no way to pass
  quality through the chain.

**Variants worth noting:** `vellum` (calf, finest, for illuminated manuscripts) vs
`parchment` (sheep/goat, standard). Express as material alternates on the hide
input. **Uterine vellum** (stillborn calf) is historically real and absurdly
luxurious — flag as a top-tier rare material, not a separate chain.

---

## Chain: Rawhide

**Real-world context.** The minimal chain: a fresh hide is fleshed, stretched on a
frame, and dried hard. No tanning at all. The result is stiff, very strong in
tension, rot-prone when wet. Used for shield faces, drum heads, lashings, horn cores
for composite bows, whips, and dog chews. Ubiquitous wherever hides were processed
but rarely given its own craft identity because it's so trivial — which is exactly
why it belongs here as the "day one" hide chain.

**Gameplay role.** Produces `rawhide` — early-game shield face material, thong/strap
feedstock before a tannery exists. Distinct from leather: brittle when dry, ruined
by water, but available *immediately* without lime or bark.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | gather | — | — | `raw_hide` ×1 | skinning_knife | — | Any large mammal. |
| 2 | scrape | fleshing_beam | `raw_hide` ×1 | `scraped_hide` ×1, `flesh_scraps` ×1 | fleshing_knife | 0 | `stepType: attack`. Dehairing optional — many uses (drums, shields) want hair off, some (thong) tolerate it. |
| 3 | stretch + dry | drying_rack | `scraped_hide` ×1 | `rawhide` ×1 | — | 400 | `stepType: time`. Laced on a frame, left in the sun. Real: 1–3 days. |

**Primitive verbs exercised:** scrape, stretch, dry.

**Workstations introduced:** none new. Fleshing beam + drying rack shared with
bark tanning.

**Byproducts and their fate:** `flesh_scraps` → hide_glue chain.

**Knowledge gating:** none. Primitive knowledge — available from game start.

**Engine gaps exposed:**
- **GAP-ENV** — sun drying only; rain during drying ruins the hide. Currently no
  weather-dependent recipe gating.
- **GAP-DURABILITY** — rawhide degrades in damp conditions on the item side too.
  Needs "this item loses condition when wet" on the item model.

**Variants worth noting:** `parfleche` (painted rawhide container, North American)
is a rawhide item variant, not a separate chain.

---

## Chain: Hide Glue

**Real-world context.** The universal pre-synthetic adhesive. Collagen-rich hide
trimmings, cartilage, tendons, and connective tissue are repeatedly simmered in
water; the resulting gelatin-rich broth is clarified, strained, poured onto sheets
to set, then dried into amber chips or sticks that are rehydrated with warm water
at the point of use. Bone glue is the mineral-rich variant made from crushed bones.
Used for joinery, instrument-making, gesso primer under tempera paint, bookbinding,
composite-bow lamination, and sizing parchment before inking. A craft staple with
enormous cross-chain reach.

**Gameplay role.** Produces `hide_glue` — input to composite bow construction,
joinery recipes (stronger joins than wooden pegs alone), gesso for painted items,
bookbinding for tomes, ship caulking. Notable byproduct consumer: this chain is
how the flesh_scraps and parchment_shavings from every other hide process find
economic use, rather than rotting.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | wash | soaking_vat | `flesh_scraps` ×3 (alt: `parchment_shavings` ×3, `bone` ×3), `water` ×2 | `soaked_scraps` ×1, `wash_waste` ×1 | — | 100 | `stepType: time`. Soaks out blood and dirt. |
| 2 | boil | glue_pot | `soaked_scraps` ×1, `water` ×2, `firewood` ×2 | `glue_broth` ×1, `glue_residue` ×1 | — | 300 | `stepType: time`. Long simmer — historically hours. **Interesting step** — the distinctive low-boil pot. |
| 3 | strain + set | cooling_tray | `glue_broth` ×1 | `glue_slab` ×1 | sieve | 100 | `stepType: time`. Gelatin sets on cooling. |
| 4 | cut + dry | drying_rack | `glue_slab` ×1 | `hide_glue` ×4 | knife | 200 | `stepType: time`. Sheeting broken into chip stock. |

**Primitive verbs exercised:** wash, boil (specialisation of `apply-heat`), strain,
cut, dry.

**Workstations introduced:** `glue_pot` (a dedicated iron or copper cauldron on a
hearth — could share a prefab with the generic `cauldron` station), `cooling_tray`.

**Byproducts and their fate:**
- `glue_residue` → fertiliser or discarded.
- `wash_waste` → discarded.
- The chain itself is a byproduct consumer, not a producer — its economic role is
  absorbing scraps from tanning, parchment, and butchery.

**Knowledge gating:** none in practice — glue was household knowledge. Could gate
`bone_glue` (the finer variant) behind `lore_bonewright_craft` if differentiation
is wanted.

**Engine gaps exposed:**
- **GAP-STATE** — a glue pot needs to maintain low simmer; too hot = burnt glue
  (weak), too cold = incomplete extraction. Same deal as every other sustained-heat
  process; currently the recipe just runs.
- **GAP-BATCH** — small issue here; scale is already absorbed into input quantities.

**Variants worth noting:** `fish_glue` (isinglass, from sturgeon swim bladders) is
historically distinct, translucent, used for fine work. Best represented as an
alternate input (`flesh_scraps` alternate: `swim_bladder`) producing a different
output item rather than a parallel chain. **Rabbit-skin glue** is a specific
alternate beloved of painters for gesso — same deal, material alternate.

---

## Chain: Currying and Dubbing

**Real-world context.** Tanned leather fresh from the pit is stiff "crust" — it
needs a finishing pass to be useful for any specific end product. Currying is the
mechanical work (wetting, stretching, slicking, shaving thickness) and dubbing is
the chemical work (stuffing the fibres with tallow, neatsfoot oil, or a cod/tallow
mix). Different end products want different dubbing recipes: harness leather is
stuffed heavy and greasy; boot uppers lighter; bookbinding gets a thin surface
dressing. Historically a separate guild (curriers) from tanners.

**Gameplay role.** Currently treated as step 9 of bark tanning. Broken out here
because it's the natural extension point for specialised leather grades: one base
`crust_leather` can become `harness_leather`, `boot_leather`, `armour_leather`, or
`binding_leather` depending on the dubbing. This is a clean use of the `assembly`
step type — same inputs, different recipe choice.

**Chain steps:**

| # | Verb | Station | Inputs | Outputs (+byproducts) | Tools | Ticks | Notes |
|---|------|---------|--------|-----------------------|-------|-------|-------|
| 1 | (prior) | — | — | `crust_leather` ×1 | — | — | From bark tanning step 8. |
| 2 | slick | currying_bench | `crust_leather` ×1, `water` ×1 | `slicked_leather` ×1 | slicker | 0 | `stepType: attack`. Squeezes water and evens thickness. |
| 3a | dub (harness) | currying_bench | `slicked_leather` ×1, `tallow` ×2, `fish_oil` ×1 | `harness_leather` ×1 | — | 150 | `stepType: assembly`. Heavy stuffing. |
| 3b | dub (armour) | currying_bench | `slicked_leather` ×1, `tallow` ×1, `beeswax` ×1 | `armour_leather` ×1 | — | 150 | `stepType: assembly`. Wax adds stiffness. |
| 3c | dub (boot) | currying_bench | `slicked_leather` ×1, `tallow` ×1 | `boot_leather` ×1 | — | 120 | `stepType: assembly`. |
| 3d | dub (binding) | currying_bench | `slicked_leather` ×1, `beeswax` ×1 | `binding_leather` ×1 | — | 100 | `stepType: assembly`. Thin, flexible, won't stain pages. |

**Primitive verbs exercised:** slick (collapse into `press` or keep as
characteristic), dub (new — propose as a primitive; sits between `oil` and
`mordant` conceptually).

**Workstations introduced:** `currying_bench` (a shaped trestle with a frame).

**Byproducts and their fate:** none of note; the dubbing ingredients are fully
absorbed.

**Knowledge gating:** `requiredFragmentId: lore_currier_craft` — unlocks the
assembly variants. Without it, crust leather can still be used for coarse goods.

**Engine gaps exposed:**
- **GAP-QUALITY** — currying is where a skilled worker's output diverges most from a
  novice's. Same dubbing, same leather, wildly different feel. No scalar quality.
- **GAP-DURABILITY** — currying should itself consume the `slicker` over thousands
  of strokes. Currently tools never wear.

**Variants worth noting:** `waxed leather` (cuir bouilli) is tangential — hot wax
dipping that hardens leather for cheap armour. It's a short one-step recipe from
`slicked_leather` + `wax` that can stand as a "trivial recipes" bullet rather than
a full chain.

---

## Variants and minor chains

- **Smoke tanning (standalone).** Folded into Brain Tanning as its final step.
  As a standalone chain it's one step — omitted per the scope filter's minimum
  two-step rule.
- **Fur preservation (hair-on).** Deviates from leather only at step 4: skip the
  lime bath, tan with a weaker bark liquor or alum, keep the hair. Express as a
  variant recipe on bark tanning (`bark_tan_furred`) rather than a parallel chain —
  the steps are 95% the same.
- **Chamois / buff leather.** Oil-tanned (cod oil + physical working). Historically
  real, distinctive, but the chain overlaps strongly with brain tanning (the oil
  is just a different fatliquor). Treat as a material alternate on the brain-tan
  emulsion input.
- **Morocco leather.** A specialist sumac-tanned goatskin associated with North
  Africa and Iberia. The chain is bark tanning with sumac as a `bark` alternate.
  No new steps; a material variation.
- **Shagreen.** Untanned, pebbled donkey/shark skin historically used for sword-grip
  wraps. Scope filter: gameplay role plausible (grip material), but the chain is
  a single-step rawhide variant. Trivial.
- **Bookbinding.** Deliberately deferred — it's an assembly chain that *consumes*
  binding leather and parchment sheets. Belongs in a future "knowledge/scribe"
  category file, not here.
- **Pigment from scale/blood/ochre** was considered as a bark-tanning byproduct use;
  it's tangential enough that it belongs in a "chemistry & dye" category file.
- **Soap as a degreasing step** was considered for tawing prep; historically real
  but the chain gets tedious. Folded into the existing step inputs.

---

## Category summary

**Verbs used.** cure, soak, leach, scrape, bate, tan, press, dry, curry, blend,
taw, stake, work-in, stretch, smoke, wash, boil, strain, cut, slick, dub. Most
overlap existing primitives (`apply-heat`, `ferment`, `mordant`, `cure`, `knead`,
`press`, `dry`, `scrape`); the genuinely new candidates are **`taw`**, **`dub`**,
**`bate`**, and possibly **`slick`**. `scrape` and `stretch` are frequent enough
across this category (and likely woodwork and bone) to canonicalise as primitives
in the Phase 3 merge.

**Workstations introduced.** `salting_floor`, `soaking_vat`, `lime_pit`,
`fleshing_beam`, `bating_tub`, `tanning_pit`, `bark_mill` (or shared `quern`),
`drying_rack` (shared with food drying), `parchment_frame`, `staking_bench`,
`tawing_drum`, `currying_bench`, `smoke_pit` (shared with smoked-meat),
`glue_pot`, `cooling_tray`. A fully-kitted tannery is ~10 distinct stations —
**the densest workstation cluster in the game** once authored.

**Primitives consumed.** `raw_hide` (from butchery of any large mammal — the
primary input), `salt`, `quicklime` (from burning limestone — cross-chain to a
mineral-processing category), `water` (abundant), `oak_bark` / `chestnut_bark` /
`hemlock_bark` (gathered from stumps after felling — free byproduct of wood
chopping), `alum` (rare mineral, traded), `flour`, `egg_yolk`, `brain`,
`punky_wood` (for smoke), `tallow`, `beeswax`, `fish_oil`, `bran`, `dung`,
`bone`, `pumice`, `chalk`, `firewood`.

**Byproducts exported.** The byproduct graph for this category is unusually rich
and deserves its own note:
- **To chemistry/wood:** `flesh_scraps` and `parchment_shavings` → hide_glue, which
  then exports as `hide_glue` back into joinery, composite bows, gesso, bookbinding.
  The parchment chain's biggest real-world economic tie: scrap became glue that
  bound the books that parchment pages filled.
- **To textiles/felt:** `hair` from the lime bath → felting (hats, gambeson padding,
  padded cloth armour). Significant secondary revenue stream for tanners.
- **To food (reverse):** the chain consumes butchery byproducts (`raw_hide`,
  `brain`, `tallow`, `bone`) that would otherwise have low use. Tanning sinks
  butchery waste and exports finished goods.
- **To agriculture:** `lime_sludge` and `spent_bate` are historical fertiliser.
  Weak flow but real.
- **To lore / knowledge:** `parchment_sheet` → **lore tomes** — the only direct
  cross-category path from physical craft into Voxim's existing knowledge economy.
  This makes the parchment chain the highest-priority sub-chain from a design
  integration standpoint: authoring it is the single biggest lever for tying
  material crafting to the skill unlock system.

**Top engine gaps.** In rough descending order of frequency and severity for this
category:

- **GAP-ENV.** Dominant. Tanning pits need water and downwind placement; smoke pits
  need open sky; drying racks and parchment frames need covered ventilation; rawhide
  drying needs sun without rain. Hide work is in large part a geography craft, and
  placing every station on the same flat tile with no environmental rule flattens it
  severely. This category is probably the strongest argument in the whole research
  pass for building some form of environmental prerequisite into workstations.
- **GAP-BATCH.** Dominant. Historic tanneries processed dozens to hundreds of hides
  per pit, with hides migrating between pits of different strengths. The
  "one recipe per station" model forces a choice between tedious micro-batches and
  unrealistically large single-hide recipes. Concrete design ask: stations should
  support parallel recipe instances up to a capacity limit, sharing station state.
- **GAP-CHECKPOINT.** Parchment scraping is the canonical case — the craftsman's
  judgment mid-process is the entire skill of the craft. Vegetable tanning has a
  softer version (cross-cut colour test). Decomposing these into `chainNextRecipeId`
  micro-recipes works mechanically but turns one craft into six identical-looking
  recipes.
- **GAP-STATE.** Tanning pits have *liquor strength*. Historically fresh pits held
  weak liquor and spent pits held strong; a hide moved up the strength gradient
  over months. Modelling this requires station-local state beyond the slot buffer.
- **GAP-QUALITY** and **GAP-DURABILITY** show up repeatedly (tawing skill,
  currying skill, slicker wear) but the cases here echo gaps raised by other
  categories; not a leather-specific plea.
- **GAP-PROCESS-PARAM** (temperature, humidity) is present but generally
  workable by tuning ticks; defer.
