# Item Catalogue — Recipes by Item

Inverts the chain research. Each entry names an item the game needs,
explains what role it plays, and lists one or more recipes producing it.

Multiple recipes are encouraged where historically justified — a player
in a mountain biome should be able to roast charcoal in a pit while one
on the plains uses a kiln. Same output, different inputs and workstations.
Recipes are authored against the [CONSOLIDATION.md](CONSOLIDATION.md)
taxonomy (17 station families) — `stationType` values come from that
taxonomy, not from the old ~75-station sprawl.

**Cross-references.** Primitives (gathered, not crafted) are listed in
§1. Recipes cite input items by id; the id matches the prefab filename
the item will eventually be authored from. When an item appears as both
a stack and a unique (rare: same material, different instance state),
it's split into two entries.

**Engine gaps.** Called out per-recipe only when the *flavour* of the
chain suffers. A recipe that uses the current engine correctly needs no
flag.

**Status legend.**

- **Authored** — a recipe file exists in `packages/content/data/recipes/` today.
- **Referenced** — the item id is cited by another piece of content
  (NPC template, starting inventory, recipe output) but no prefab or
  recipe exists yet.
- **Proposed** — the item is suggested by this doc, no existing reference.

---

## 1. Primitives (gathered, not crafted)

Resource-node drops. No recipes; included here so downstream recipes can
cite them without ambiguity.

| id | Biome / node | Role |
|---|---|---|
| `wood` | tree node, any forest | All woodwork; fuel; polesaw handle |
| `stone` | rock node, any terrain | Crude stone tools; aggregate for masonry |
| `flint_nodule` | coastal / chalk terrain | Knapped blades; strike-a-light |
| `clay` | riverbed / pit | Pottery, brick, mortar |
| `sand` | coastal / desert | Glass batch; sand casting; moulding medium |
| `limestone` | mountain / quarry | Lime burn → quicklime |
| `iron_ore` | mountain / bog | `furnace` → raw_bloom |
| `bog_ore` | wetland biome | As iron_ore, lower-yield variant. **GAP-ENV** — no wetland tag today. |
| `copper_ore` | mountain | `furnace` → copper_matte / copper_ingot |
| `tin_ore` | mountain (rare) | Alloys with copper → bronze |
| `lead_ore` (galena) | mountain | `furnace` → lead; cupellation → silver |
| `salt_rock` / `brine` | coastal / saline spring | `pan` evaporate → salt |
| `flax_stalks` | cultivated plains | Ret → linen chain |
| `raw_wool` | sheep (animal node) | Scour → spin → weave |
| `raw_hide` | kill animal | Tanning chain |
| `raw_meat` | kill animal | Cook / cure |
| `grain` | cultivated plains | Mill → flour; malt → ale |
| `mushroom` | forest floor | Eaten raw or cooked |
| `berry` | bush node | Eaten raw; fermented → cordial |
| `honey_comb` | bee node | Wax + honey |
| `oak_gall` | oak tree rare drop | Ink precursor |
| `woad_leaves` / `madder_root` / `weld_plant` | cultivated / wild | Dyes |
| `birch_bark` | birch tree drop | Tar pyrolysis; tinder |
| `oak_bark` | oak tree drop | Bark tanning |
| `resinous_pine` (fatwood) | pine stump | Tar precursor |
| `beeswax` | processed from honey_comb | Candles; lost-wax |

---

## 2. Primary materials (first-processing stacks)

### `plank`

**Kind:** stack **Role:** Building material; handles for tools; crate staves.  
**Used by:** wood_wall blueprint; wooden_sword/spear/bow/hammer; campfire deploy; dozens of assemblies.  
**Status:** Authored ([recipes/plank.json](../../packages/content/data/recipes/plank.json)).

**Recipe — Chop planks (today):**
| Input | Qty | | Input | Qty |
|---|---|---|---|---|
| wood | 1 | | | |

**Station:** `bench` (chopping_block variant)  **Tool:** axe  **Step:** `attack`  **Ticks:** 0  **Output:** plank ×2

**Recipe — Rive planks (proposed, higher yield):**
| Input | Qty |
|---|---|
| wood | 1 |

**Station:** `bench` (riving_brake variant)  **Tool:** froe  **Step:** `attack`  **Ticks:** 0  **Output:** plank ×3 + bark ×1.  
**Lore gate:** `fragment_riving` — riving splits along the grain and yields
more but needs straight-grained wood (oak, pine); failure rate higher on
knotty stock.  
**Engine gaps:** GAP-QUALITY — riven planks are historically straighter
and don't warp; today the output is identical. Cosmetic loss.

---

### `stone_block`

**Kind:** stack **Role:** Building material for stone walls / floors; mortar aggregate.  
**Used by:** stone_wall, stone_floor blueprints.  
**Status:** Authored ([recipes/stone_block.json](../../packages/content/data/recipes/stone_block.json)).

**Recipe — Dress stone:**
| Input | Qty |
|---|---|
| stone | 2 |

**Station:** `bench` (mason_bench variant)  **Tool:** chisel  **Step:** `attack`  **Ticks:** 0  **Output:** stone_block ×1 + stone_chip ×1 (byproduct, discarded today)

---

### `charcoal`

**Kind:** stack **Role:** **Universal reducing fuel for metallurgy and high-temperature kiln work.** Nothing in the `furnace` family smelts without it.  
**Used by:** every metal smelt recipe (iron, copper, bronze, lead, brass); glass melt; pottery high-fire.  
**Status:** Referenced (every smelt recipe inputs `coal`; `coal` is a resource-node drop today — charcoal is a semantic gap).

**Recipe — Charcoal pit (outdoor, consumable):**
| Input | Qty |
|---|---|
| wood | 10 |

**Station:** `pyrolysis_pit`  **Tool:** —  **Step:** `time`  **Ticks:** 2400  **Output:** charcoal ×6 + wood_ash ×1  
**Engine gaps:** GAP-CONSUMED-STATION (historically the clamp was built, burned, and torn down). Workaround: the pyrolysis_pit is a deployable that despawns on recipe complete.

**Recipe — Charcoal kiln (permanent, batch-able):**
| Input | Qty |
|---|---|
| wood | 10 |

**Station:** `kiln`  **Tool:** —  **Step:** `time`  **Ticks:** 1800  **Output:** charcoal ×7 + wood_ash ×1  
**Lore gate:** `fragment_kiln_charcoal` — the permanent kiln is a post-Roman
efficiency upgrade.  
**Notes:** Higher yield justifies the building cost. Both paths coexist —
the pit is a peasant craft, the kiln a specialist installation.

---

### `iron_ingot`

**Kind:** stack **Role:** Base feedstock for every iron weapon, tool, nail, hinge.  
**Used by:** iron_sword, iron_axe, nail, hinge, plate_armour, horseshoe.  
**Status:** Authored ([recipes/iron_ingot.json](../../packages/content/data/recipes/iron_ingot.json)) — a one-step campfire smelt. This entry documents the full historical chain; the current recipe stays as a stub until replaced.

**Recipe — Full bloomery chain (proposed):**

Three-step chain via `chainNextRecipeId`; see the Metallurgy research for context.

**Step A — roast:**
| Input | Qty |
|---|---|
| iron_ore | 3 |
| wood | 2 |

**Station:** `furnace` (roasting variant)  **Tool:** —  **Step:** `time`  **Ticks:** 600  **Output:** roasted_ore ×3

**Step B — bloom:**
| Input | Qty |
|---|---|
| roasted_ore | 3 |
| charcoal | 4 |

**Station:** `furnace` (bloomery variant)  **Tool:** —  **Step:** `time`  **Ticks:** 800  **Output:** raw_bloom ×1 + slag ×2

**Step C — consolidate:**
| Input | Qty |
|---|---|
| raw_bloom | 1 |

**Station:** anvil (`bench` with hammer)  **Tool:** hammer  **Step:** `attack`  **Ticks:** 0  **Output:** iron_ingot ×1 + hammer_scale ×1

**Engine gaps:** GAP-PROCESS-PARAM (temperature / draught control is the
interesting step and is reduced to a timer); GAP-BATCH (real blooms are
5–10 kg, not ×1 units).  
**Notes:** Same `iron_ingot` output ID as today's simplification; bumping
the chain later is drop-in. Bog_ore variant substitutes as an `alternate`
input on step A.

---

### `copper_ingot`

**Kind:** stack **Role:** Base for copper/bronze tools, sheet, wire.  
**Used by:** copper_spear, bronze recipes.  
**Status:** Authored ([recipes/copper_ingot.json](../../packages/content/data/recipes/copper_ingot.json)) — one-step smelt.

**Recipe — Copper smelt (today):**
| Input | Qty |
|---|---|
| copper_ore | 1 |
| coal | 1 |

**Station:** `campfire`  **Tool:** —  **Step:** `time`  **Ticks:** 100  **Output:** copper_ingot ×1

**Recipe — Matte smelt + refine (proposed two-step):**
**Step A — matte:**
| Input | Qty |
|---|---|
| copper_ore | 3 |
| charcoal | 3 |

**Station:** `furnace`  **Step:** `time`  **Ticks:** 500  **Output:** copper_matte ×2 + slag ×1

**Step B — refine:**
| Input | Qty |
|---|---|
| copper_matte | 2 |
| charcoal | 2 |

**Station:** `furnace` (crucible variant)  **Step:** `time`  **Ticks:** 400  **Output:** copper_ingot ×2

### `bronze_ingot`

**Kind:** stack **Role:** Higher-grade alternative to copper for weapons / fittings.  
**Status:** Proposed.

**Recipe — Crucible alloy:**
| Input | Qty |
|---|---|
| copper_ingot | 4 |
| tin_ore | 1 |
| charcoal | 2 |

**Station:** `furnace` (crucible)  **Step:** `time`  **Ticks:** 300  **Output:** bronze_ingot ×4  
**Lore gate:** `fragment_bronze_alloy`.  
**Engine gaps:** GAP-PROCESS-PARAM (the copper:tin ratio is the whole
craft; today it's a fixed recipe).

---

## 3. Fuels, ashes, solvents

### `wood_ash`

**Kind:** stack **Role:** Byproduct of every wood fire; leach source for lye/potash.  
**Status:** Proposed.

Generated as a byproduct of: charcoal recipes (above), campfire cooking, bread baking, any sustained `cauldron` recipe. Not a primary recipe — it accumulates as output quantity on the station running a fire.

### `lye`

**Kind:** stack **Role:** Caustic solvent; saponifies fats into soap; dehairs hides; scours wool; part of woad vat chemistry.  
**Used by:** soap, scoured_wool, limed_hide (as alternative to lime).  
**Status:** Proposed.

**Recipe — Ash leach (cold):**
| Input | Qty |
|---|---|
| wood_ash | 4 |
| water | 2 |

**Station:** `vat` (ash-hopper variant)  **Step:** `time`  **Ticks:** 400  **Output:** lye ×1 + spent_ash ×1 (discarded)

**Recipe — Boiled lye (concentrated):**
| Input | Qty |
|---|---|
| lye | 2 |

**Station:** `cauldron`  **Step:** `time`  **Ticks:** 200  **Output:** concentrated_lye ×1

### `potash`

**Kind:** stack **Role:** Glass flux; dye mordant; stronger saponifier than plain lye.  
**Used by:** glass batch, dye recipes, high-grade soap.  
**Status:** Proposed.

**Recipe — Evaporate lye:**
| Input | Qty |
|---|---|
| concentrated_lye | 2 |

**Station:** `pan`  **Step:** `time`  **Ticks:** 800  **Output:** potash ×1

### `salt`

**Kind:** stack **Role:** Meat cure; cheese; tawing; alchemy.  
**Used by:** cured_meat, cheese recipes, salted_hide.  
**Status:** Proposed.

**Recipe — Boil brine (today-authorable):**
| Input | Qty |
|---|---|
| brine | 4 |

**Station:** `pan`  **Tool:** —  **Step:** `time`  **Ticks:** 600  **Output:** salt ×2

**Recipe — Solar salt (seasonal):**
| Input | Qty |
|---|---|
| brine | 8 |

**Station:** `pan`  **Step:** `time`  **Ticks:** 2400  **Output:** salt ×5  
**Engine gaps:** GAP-ENV — needs sun, no rain, coastal. Without the env check the solar variant is just "slower and better" which breaks regional differentiation.  
**Lore gate:** none — solar salt is common knowledge near coasts.

### `quicklime`

**Kind:** stack **Role:** Mortar base; dehair hide; whitewash; purification.  
**Used by:** slaked_lime, limed_hide.  
**Status:** Proposed.

**Recipe — Lime burn:**
| Input | Qty |
|---|---|
| limestone | 3 |
| charcoal | 2 |

**Station:** `furnace` (lime variant) or `kiln`  **Step:** `time`  **Ticks:** 900  **Output:** quicklime ×2 + flue_dust ×1 (discarded)

### `slaked_lime`

**Kind:** stack **Role:** Mortar; leather dehair; whitewash pigment base.  
**Status:** Proposed.

**Recipe — Slake:**
| Input | Qty |
|---|---|
| quicklime | 1 |
| water | 2 |

**Station:** `danger_pit`  **Step:** `time`  **Ticks:** 100  **Output:** slaked_lime ×1  
**Engine gaps:** GAP-DANGER-INPUT — slaking releases scalding steam and caustic splash; damages adjacent entities. Without the gap, slaking is indistinguishable from stirring. Can ship as a `cauldron` recipe for now and flag.

### `mortar_paste`

**Kind:** stack **Role:** Masonry binder between stone_block courses.  
**Used by:** stone_wall, stone_floor blueprints' material cost (proposed).  
**Status:** Proposed.

**Recipe — Mix lime mortar:**
| Input | Qty |
|---|---|
| slaked_lime | 1 |
| sand | 2 |
| water | 1 |

**Station:** `vat` (mortar-trough variant)  **Step:** `time`  **Ticks:** 60  **Output:** mortar_paste ×3

---

## 4. Tools (unique items)

### `hammer` (wooden / iron variants)

**Kind:** unique **Role:** Tool for construction (blueprints), iron working (anvil recipes), nail-heading.  
**Status:** The player starts with a `hammer` stack ([player.json](../../packages/content/data/prefabs/player.json)) — currently a stack, likely wrong long-term; document both variants.

**Recipe — Wooden hammer (today-authorable):**
| Input | Qty |
|---|---|
| plank | 2 |
| stone | 1 |

**Station:** `bench` (workbench)  **Tool:** knife  **Step:** `assembly`  **Ticks:** 0  **Output:** wooden_hammer ×1  
**Status:** Authored ([recipes/wooden_hammer.json](../../packages/content/data/recipes/wooden_hammer.json)).

**Recipe — Iron hammer (proposed):**
| Input | Qty |
|---|---|
| iron_ingot | 1 |
| plank | 1 |

**Station:** anvil (`bench`)  **Tool:** hammer  **Step:** `assembly`  **Ticks:** 0  **Output:** iron_hammer ×1  
**Notes:** The upgrade is straight-line mechanical better; GAP-QUALITY would make this more interesting.

### `axe` — `stone_axe`, `iron_axe`

**Kind:** unique **Role:** Fell trees; combat sidearm.  
**Status:** stone_axe authored ([recipes/stone_axe.json](../../packages/content/data/recipes/stone_axe.json)); iron_axe proposed.

**Recipe — Stone axe (today):**
| Input | Qty |
|---|---|
| plank | 1 |
| stone | 2 |

**Station:** `bench`  **Tool:** knife  **Step:** `assembly`  **Ticks:** 0  **Output:** stone_axe ×1

**Recipe — Iron axe (proposed):**
| Input | Qty |
|---|---|
| iron_ingot | 1 |
| plank | 2 |

**Station:** anvil  **Tool:** hammer  **Step:** `assembly`  **Ticks:** 0  **Output:** iron_axe ×1

### `pickaxe` — `stone_pickaxe`, `iron_pickaxe`

**Kind:** unique **Role:** Mine ore / stone nodes.  
**Status:** stone_pickaxe authored ([recipes/stone_pickaxe.json](../../packages/content/data/recipes/stone_pickaxe.json)).

**Recipe — Stone pickaxe:**
| Input | Qty |
|---|---|
| plank | 1 |
| stone | 3 |

**Station:** `bench`  **Tool:** knife  **Step:** `assembly`  **Ticks:** 0

**Recipe — Iron pickaxe:**
| Input | Qty |
|---|---|
| iron_ingot | 2 |
| plank | 1 |

**Station:** anvil  **Tool:** hammer  **Step:** `assembly`  **Ticks:** 0

### `shovel` — `stone_shovel`, `iron_shovel`

**Kind:** unique **Role:** Dig terrain; gather clay; expose bog_ore.  
**Status:** stone_shovel authored ([recipes/stone_shovel.json](../../packages/content/data/recipes/stone_shovel.json)).

Symmetric with pickaxe above; stone variant today, iron upgrade proposed.

### `knife`

**Kind:** unique **Role:** Butcher carcasses; leatherwork; whittling; combat sidearm.  
**Status:** Proposed (referenced as a required tool on several recipes but not authored).

**Recipe — Flint knife:**
| Input | Qty |
|---|---|
| flint_nodule | 1 |
| plank | 1 |

**Station:** `bench` (knapping_stump variant)  **Tool:** — (hand knapping)  **Step:** `attack`  **Ticks:** 0  **Output:** flint_knife ×1 + stone_chip ×2

**Recipe — Iron knife:**
| Input | Qty |
|---|---|
| iron_ingot | 1 |

**Station:** anvil  **Tool:** hammer  **Step:** `attack`  **Ticks:** 0  **Output:** iron_knife ×1

### `chisel`

**Kind:** unique **Role:** Dress stone (stone_block recipe); fine woodwork; stone sculpting.  
**Status:** Proposed.

**Recipe — Iron chisel:**
| Input | Qty |
|---|---|
| iron_ingot | 1 |
| plank | 1 |

**Station:** anvil  **Tool:** hammer  **Step:** `assembly`  **Ticks:** 0

### `shears`

**Kind:** unique **Role:** Shear wool from sheep (converts `raw_wool` node drops to more); cut cloth.  
**Status:** Proposed.

**Recipe — Iron shears:**
| Input | Qty |
|---|---|
| iron_ingot | 1 |

**Station:** anvil  **Tool:** hammer  **Step:** `attack`  **Ticks:** 0  **Output:** shears ×1

### `froe`

**Kind:** unique **Role:** Rive planks (alternative to axe, higher yield).  
**Status:** Proposed.

**Recipe — Iron froe:**
| Input | Qty |
|---|---|
| iron_ingot | 1 |
| plank | 2 |

**Station:** anvil  **Tool:** hammer  **Step:** `assembly`  **Ticks:** 0

---

## 5. Weapons

### `wooden_sword`, `wooden_spear`

**Kind:** unique **Role:** Starter melee weapons.  
**Status:** Both authored ([recipes/wooden_sword.json](../../packages/content/data/recipes/wooden_sword.json), [recipes/wooden_spear.json](../../packages/content/data/recipes/wooden_spear.json)).

**Recipe — Wooden sword:**
| Input | Qty |
|---|---|
| plank | 3 |

**Station:** `bench` (workbench)  **Tool:** knife  **Step:** `assembly`  **Ticks:** 0

### `copper_spear`

**Kind:** unique **Role:** Tier-2 melee weapon.  
**Status:** Authored ([recipes/copper_spear.json](../../packages/content/data/recipes/copper_spear.json)).

Current recipe: copper_ingot ×2 + wood ×2 at workbench with hammer. Works today.

### `iron_sword` (proposed full chain)

**Kind:** unique **Role:** Tier-3 primary melee.  
**Status:** Proposed.

Real historical blade-making is a multi-step chain. Each step below is a
separate recipe, linked via `chainNextRecipeId` where they share a
workstation.

**Step A — Forge blade stock:**
| Input | Qty |
|---|---|
| iron_ingot | 2 |
| charcoal | 1 |

**Station:** `furnace` (forge variant)  **Step:** `time`  **Ticks:** 200  **Output:** hot_iron_billet ×1

**Step B — Hammer to shape:**
| Input | Qty |
|---|---|
| hot_iron_billet | 1 |

**Station:** anvil (`bench`)  **Tool:** hammer  **Step:** `attack`  **Ticks:** 0  **Output:** raw_blade ×1 + hammer_scale ×1

**Step C — Harden (quench):**
| Input | Qty |
|---|---|
| raw_blade | 1 |
| water | 1 |

**Station:** `vat` (quench variant) OR `cauldron` filled with oil for higher-grade steel  **Step:** `attack`  **Tool:** tongs (new tool) **Ticks:** 0  **Output:** hard_blade ×1  
**Engine gaps:** GAP-CHECKPOINT — historically the blade is red-hot at the right moment and quenching off-timing shatters it; today it's a timerless resolve.

**Step D — Temper:**
| Input | Qty |
|---|---|
| hard_blade | 1 |
| charcoal | 1 |

**Station:** `furnace` (tempering variant, low heat)  **Step:** `time`  **Ticks:** 120  **Output:** tempered_blade ×1

**Step E — Haft:**
| Input | Qty |
|---|---|
| tempered_blade | 1 |
| plank | 1 |
| leather_strip | 1 |

**Station:** `bench` (workbench)  **Tool:** knife  **Step:** `assembly`  **Ticks:** 0  **Output:** iron_sword ×1  
**Engine gaps:** GAP-QUALITY across the whole chain — a master smith's sword is historically better than a novice's from identical inputs.

**Alternative simpler path (until the full chain ships):**

**Recipe — One-shot forge (placeholder):**
| Input | Qty |
|---|---|
| iron_ingot | 2 |
| plank | 1 |

**Station:** anvil (`bench`)  **Tool:** hammer  **Step:** `assembly`  **Ticks:** 0  **Output:** iron_sword ×1

### `wooden_bow`

**Kind:** unique **Role:** Ranged weapon; bandits carry one.  
**Status:** Authored ([recipes/wooden_bow_recipe.json](../../packages/content/data/recipes/wooden_bow_recipe.json)).

Current recipe: plank ×4 + linen_thread ×1 → wooden_bow. linen_thread is
**referenced but not produced** today — see Textiles section.

### `arrow`

**Kind:** stack **Role:** Ammo for bows.  
**Status:** Proposed.

**Recipe — Bundle arrows:**
| Input | Qty |
|---|---|
| plank | 1 |
| iron_ingot | 1 |
| feather | 2 |

**Station:** `bench`  **Tool:** knife  **Step:** `assembly`  **Ticks:** 0  **Output:** arrow ×10 (stackable)

---

## 6. Food & consumables

### `cooked_meat`

**Kind:** stack **Role:** Food (restores hunger).  
**Status:** Authored ([recipes/cooked_meat.json](../../packages/content/data/recipes/cooked_meat.json)).

**Recipe — Roast:**
| Input | Qty |
|---|---|
| raw_meat | 1 |

**Station:** `campfire`  **Step:** `time`  **Ticks:** 200  **Output:** cooked_meat ×1

### `cured_meat` (preserved)

**Kind:** stack **Role:** Food that survives long travel / trade.  
**Status:** Proposed.

**Recipe — Salt cure:**
| Input | Qty |
|---|---|
| raw_meat | 2 |
| salt | 1 |

**Station:** `vat` (brine_barrel variant)  **Step:** `time`  **Ticks:** 1800  **Output:** cured_meat ×2

**Recipe — Smoke cure:**
| Input | Qty |
|---|---|
| raw_meat | 2 |
| wood | 1 |

**Station:** `smokehouse`  **Step:** `time`  **Ticks:** 1200  **Output:** cured_meat ×2  
**Lore gate:** `fragment_smoke_cure`.  
**Engine gaps:** smokehouse-deferred from first wave (CONSOLIDATION §"First-wave authorable").

### `cooked_mushroom`

**Status:** Authored ([recipes/cooked_mushroom.json](../../packages/content/data/recipes/cooked_mushroom.json)).

### `flour`

**Kind:** stack **Role:** Bread dough input.  
**Status:** Proposed.

**Recipe — Quern grind:**
| Input | Qty |
|---|---|
| grain | 2 |

**Station:** `millstone` (hand_quern variant)  **Tool:** — or maul  **Step:** `attack`  **Ticks:** 0  **Output:** flour ×1 + bran ×1

**Recipe — Watermill grind (faster, higher yield):**
| Input | Qty |
|---|---|
| grain | 2 |

**Station:** `millstone` (watermill variant)  **Step:** `time`  **Ticks:** 80  **Output:** flour ×2 + bran ×1  
**Engine gaps:** GAP-ENV — watermill needs adjacent water.

### `dough`

**Kind:** stack **Role:** Bread precursor.  
**Status:** Proposed.

**Recipe — Knead:**
| Input | Qty |
|---|---|
| flour | 2 |
| water | 1 |

**Station:** `bench` (kneading_trough variant)  **Step:** `attack`  **Ticks:** 0  **Output:** dough ×2

### `bread`

**Kind:** stack **Role:** Staple food; stackable in bulk, long shelf life after baking.  
**Status:** Proposed.

**Recipe — Bake:**
| Input | Qty |
|---|---|
| dough | 2 |
| wood | 1 |

**Station:** `oven`  **Step:** `time`  **Ticks:** 400  **Output:** bread ×2

### `cheese`

**Kind:** stack **Role:** Preserved dairy; trade staple.  
**Status:** Proposed.

**Recipe — Fresh curd:**
| Input | Qty |
|---|---|
| milk | 3 |
| vinegar | 1 |

**Station:** `vat` (cheese_vat variant)  **Step:** `time`  **Ticks:** 600  **Output:** fresh_cheese ×1 + whey ×2 (byproduct — feeds animals)

**Recipe — Pressed + aged (aged variant):**
| Input | Qty |
|---|---|
| fresh_cheese | 1 |
| salt | 1 |

**Station:** `press` (cheese_press variant)  **Step:** `time`  **Ticks:** 200  **Output:** pressed_cheese ×1

Followed by aging in a `cellar` — engine-gap-deferred from first wave.

### `ale`

**Kind:** stack **Role:** Hydration substitute; morale (future); trade good.  
**Status:** Proposed.

**Recipe — Brew:**

Multi-step. Malt → mash → boil → ferment.

**Step A — Malt:**
| Input | Qty |
|---|---|
| grain | 3 |
| water | 1 |

**Station:** `vat` (steeping_cistern variant)  **Step:** `time`  **Ticks:** 1200  **Output:** malt ×3

**Step B — Mash:**
| Input | Qty |
|---|---|
| malt | 3 |
| water | 2 |

**Station:** `cauldron` (mash-tun variant)  **Step:** `time`  **Ticks:** 300  **Output:** wort ×3

**Step C — Ferment:**
| Input | Qty |
|---|---|
| wort | 3 |
| yeast | 1 |

**Station:** `vat` (fermenter variant)  **Step:** `time`  **Ticks:** 1800  **Output:** ale ×3

### `vinegar`

**Kind:** stack **Role:** Food souring; cheese setting; cleaning; chemistry (verdigris, oak-gall ink).  
**Status:** Proposed.

**Recipe — Ferment wine/ale (aerobic):**
| Input | Qty |
|---|---|
| ale | 2 |

**Station:** `vat` (vinegar_crock variant)  **Step:** `time`  **Ticks:** 2400  **Output:** vinegar ×2  
**Engine gaps:** GAP-STATE — the mother-of-vinegar living organism is the craft; today it flattens to "wait long enough."

---

## 7. Textiles

### `linen_cloth`

**Kind:** stack **Role:** Clothing; sails; gambeson stuffing; bandages; high-end parchment alternative; base for trade goods.  
**Used by:** wooden_bow's `linen_thread` (proxy), future armour, sail, tome-wrap.  
**Status:** Proposed. The chain is the classic "ten-step" reference authored as
six linked recipes:

**Step A — Ret flax:**
| Input | Qty |
|---|---|
| flax_stalks | 5 |
| water | 2 |

**Station:** `vat` (retting_pond variant)  **Step:** `time`  **Ticks:** 2000  **Output:** retted_flax ×5  
**Engine gaps:** GAP-ENV — historically done in pond water or on dew field; "pond water" is a flavour call.

**Step B — Break:**
| Input | Qty |
|---|---|
| retted_flax | 5 |

**Station:** `bench` (flax_brake variant)  **Tool:** flax_brake (tool? see note)  **Step:** `attack`  **Ticks:** 0  **Output:** broken_flax ×4 + flax_shive ×1 (byproduct, kindling)

**Step C — Scutch:**
| Input | Qty |
|---|---|
| broken_flax | 4 |

**Station:** `bench` (scutching_board variant)  **Tool:** scutching_knife  **Step:** `attack`  **Ticks:** 0  **Output:** scutched_flax ×3 + tow ×1 (byproduct, coarse stuffing)

**Step D — Heckle:**
| Input | Qty |
|---|---|
| scutched_flax | 3 |

**Station:** `bench` (heckling_comb variant)  **Step:** `attack`  **Ticks:** 0  **Output:** line_flax ×3 + tow ×1

**Step E — Spin:**
| Input | Qty |
|---|---|
| line_flax | 3 |

**Station:** `loom_device` (spinning_wheel)  **Step:** `time`  **Ticks:** 400  **Output:** linen_yarn ×2

**Step F — Weave:**
| Input | Qty |
|---|---|
| linen_yarn | 4 |

**Station:** `loom_device` (loom)  **Step:** `time`  **Ticks:** 800  **Output:** linen_cloth ×1

**Notes:** Every step is a recipe. Different NPCs can take different steps as
their craft jobs. A town with a retting pond, a brake-bench, a spinning wheel,
and a loom can run the chain end-to-end as labour; a player homestead can run
it slowly by hand. Perfect demonstration of `chainNextRecipeId` + NPC labour.

### `wool_cloth` (broadcloth)

**Kind:** stack **Role:** Warmer-than-linen clothing; armour padding; trade.  
**Status:** Proposed.

**Step A — Scour:**
| Input | Qty |
|---|---|
| raw_wool | 3 |
| lye | 1 |

**Station:** `vat` (scouring variant)  **Step:** `time`  **Ticks:** 300  **Output:** scoured_wool ×3 + lanolin ×1 (byproduct → soap, waterproofing)

**Step B — Card:**
| Input | Qty |
|---|---|
| scoured_wool | 3 |

**Station:** `bench` (carding_bench variant)  **Tool:** cards (tool)  **Step:** `attack`  **Ticks:** 0  **Output:** carded_wool ×3

**Step C — Spin:**
| Input | Qty |
|---|---|
| carded_wool | 3 |

**Station:** `loom_device` (spinning_wheel)  **Step:** `time`  **Ticks:** 400  **Output:** wool_yarn ×2

**Step D — Weave:**
| Input | Qty |
|---|---|
| wool_yarn | 4 |

**Station:** `loom_device` (loom)  **Step:** `time`  **Ticks:** 800  **Output:** raw_cloth ×1

**Step E — Full (thicken + felt-finish):**
| Input | Qty |
|---|---|
| raw_cloth | 1 |
| water | 1 |

**Station:** `vat` (fulling_trough variant)  **Step:** `time`  **Ticks:** 300  **Output:** wool_cloth ×1

**Alternative — Felted wool (shorter chain, coarser output):**
| Input | Qty |
|---|---|
| scoured_wool | 3 |
| lye | 1 |

**Station:** `vat` (felting variant)  **Step:** `time`  **Ticks:** 600  **Output:** felt ×2  
**Notes:** Felt is a lower-grade stackable; used for hats, stuffing, rough cloaks.

### `linen_thread` / `wool_yarn`

**Kind:** stack **Role:** Bowstrings, sewing thread.  
See `linen_cloth` Step E and `wool_cloth` Step C — each step yields `linen_yarn` or `wool_yarn` as its natural stacked output.

### `rope`

**Kind:** stack **Role:** Rigging, hoisting, snares, bindings.  
**Status:** Proposed.

**Recipe — Twist rope (linen or hemp):**
| Input | Qty |
|---|---|
| linen_yarn | 6 |

**Station:** `loom_device` (rope_walk variant)  **Step:** `time`  **Ticks:** 400  **Output:** rope ×2  
**Engine gaps:** GAP-ENV — historical rope walks are long outdoor tracks.

---

## 8. Leather

### `tanned_leather`

**Kind:** stack **Role:** Armour, boots, belts, straps, book binding, sheathing.  
**Used by:** leather_jerkin, boots, sheath, bound_tome.  
**Status:** Proposed.

Multi-step bark-tanning chain — represents the most commonly-authored leather
path historically. Alternative chains (alum-taw, brain-tan, smoke-tan) are
flagged below with shorter presentation.

**Step A — Salt hide (preserve):**
| Input | Qty |
|---|---|
| raw_hide | 1 |
| salt | 1 |

**Station:** `bench` (salting_floor variant)  **Step:** `time`  **Ticks:** 400  **Output:** salted_hide ×1

**Step B — Soak & dehair:**
| Input | Qty |
|---|---|
| salted_hide | 1 |
| slaked_lime | 1 |
| water | 1 |

**Station:** `vat` (lime_pit variant)  **Step:** `time`  **Ticks:** 2000  **Output:** limed_hide ×1 + hair ×1 (byproduct → felt, brush, stuffing)

**Step C — Flesh (scrape):**
| Input | Qty |
|---|---|
| limed_hide | 1 |

**Station:** `bench` (fleshing_beam variant)  **Tool:** fleshing_knife  **Step:** `attack`  **Ticks:** 0  **Output:** fleshed_hide ×1 + offal (discarded)

**Step D — Bate (soften):**
| Input | Qty |
|---|---|
| fleshed_hide | 1 |
| dung | 1 |

**Station:** `vat` (bating_tub variant)  **Step:** `time`  **Ticks:** 600  **Output:** bated_hide ×1

**Step E — Tan (bark liquor):**
| Input | Qty |
|---|---|
| bated_hide | 1 |
| oak_bark | 3 |
| water | 2 |

**Station:** `vat` (tanning_pit variant)  **Step:** `time`  **Ticks:** 3000  **Output:** tanned_leather ×1  
**Engine gaps:** GAP-BATCH — historical pits hold 20+ hides at varying liquor strengths; GAP-STATE — the liquor itself ages and is reused.

**Step F — Curry & finish:**
| Input | Qty |
|---|---|
| tanned_leather | 1 |
| tallow | 1 |

**Station:** `bench` (currying_bench variant)  **Step:** `attack`  **Ticks:** 0  **Output:** finished_leather ×1

**Alternative — Alum taw (faster, whiter, less durable):**
| Input | Qty |
|---|---|
| bated_hide | 1 |
| alum | 1 |
| salt | 1 |

**Station:** `vat` (tawing_drum variant)  **Step:** `time`  **Ticks:** 1200  **Output:** tawed_leather ×1  
**Lore gate:** `fragment_alum_taw`.  
**Notes:** Output has different stats than bark-tanned. Used for gloves, fine goods.

### `parchment`

**Kind:** stack **Role:** **Writing substrate — the physical embodiment of Lore.** Every tome in the game requires parchment + ink + scribe work.  
**Status:** Proposed.

Shares Steps A–D with `tanned_leather` (start from salt-cured hide, lime-dehair, flesh, bate). The parchment chain **diverges at step E**:

**Step E' — Stretch & scrape (parchment path):**
| Input | Qty |
|---|---|
| bated_hide | 1 |

**Station:** `bench` (parchment_frame variant)  **Tool:** lunellum (half-moon scraper)  **Step:** `attack`  **Ticks:** 0  **Output:** stretched_hide ×1

**Step F' — Dry on frame:**
| Input | Qty |
|---|---|
| stretched_hide | 1 |

**Station:** `rack` (drying)  **Step:** `time`  **Ticks:** 2400  **Output:** parchment ×2 (a single hide yields several sheets)

---

## 9. Lore physicals

### `oak_gall_ink`

**Kind:** stack **Role:** Writing ink used for inscribing lore tomes.  
**Status:** Proposed.

**Recipe — Gall & iron sulfate:**
| Input | Qty |
|---|---|
| oak_gall | 3 |
| iron_sulfate | 1 |
| water | 1 |
| ale | 1 |

**Station:** `bench` (ink_bench variant)  **Step:** `time`  **Ticks:** 600  **Output:** oak_gall_ink ×3  
**Notes:** `iron_sulfate` is itself a crafted input — made from iron_ore + sulfuric_vitriol (alchemy chain). In practice the simplest path is hammer_scale (iron byproduct) + vinegar → iron_vitriol.

### `iron_sulfate` (= iron vitriol, copperas)

**Kind:** stack **Role:** Ink mordant; pigment; dye.  
**Status:** Proposed.

**Recipe — Vinegar steep iron scale:**
| Input | Qty |
|---|---|
| hammer_scale | 2 |
| vinegar | 1 |

**Station:** `vat`  **Step:** `time`  **Ticks:** 800  **Output:** iron_sulfate ×1

### `inscribed_tome`

**Kind:** unique **Role:** **Physical Lore externalisation.** Per SPEC, writing a Lore fragment into an external object is the only way to preserve it across character death. A tome is the canonical container.  
**Status:** Proposed.

**Recipe — Scribe:**
| Input | Qty |
|---|---|
| parchment | 3 |
| oak_gall_ink | 1 |
| leather_strip | 2 |

**Station:** `bench` (scribe_desk variant)  **Tool:** quill  **Step:** `assembly`  **Ticks:** 1200  **Output:** inscribed_tome ×1  
**Engine gaps:** **GAP-PAYLOAD-ITEM** — the tome carries a `fragmentId` payload naming which Lore it contains. Today `Inscribed` (instance component) already supports this. The remaining work is the `Externalise`/`Internalise` command flow, which is partially wired.

### `blank_tome`

**Kind:** unique **Role:** Prepped tome waiting for a Lore inscription.  
**Status:** Proposed.

**Recipe — Bind parchment:**
| Input | Qty |
|---|---|
| parchment | 3 |
| leather_strip | 2 |
| linen_yarn | 1 |

**Station:** `bench` (bookbinding)  **Tool:** knife  **Step:** `assembly`  **Ticks:** 400  **Output:** blank_tome ×1

---

## 10. Light

### `torch`

**Kind:** stack **Role:** Held light source; night vision restoration.  
**Status:** Authored ([recipes/torch.json](../../packages/content/data/recipes/torch.json)).

**Recipe — Wrap torch:**
| Input | Qty |
|---|---|
| plank | 1 |
| kindling | 1 |

**Station:** `campfire`  **Step:** `time`  **Ticks:** 60  **Output:** torch ×1  
**Notes:** Current recipe is kindling-based. A pine-tar-soaked torch is historically more realistic and longer-burning — authorable later when the tar chain lands.

### `candle` (tallow)

**Kind:** stack **Role:** Indoor steady light; longer-burning than torch; table use.  
**Status:** Proposed.

**Recipe — Dip candle (tallow):**
| Input | Qty |
|---|---|
| tallow | 1 |
| linen_yarn | 1 |

**Station:** `bench` (chandler variant)  **Step:** `attack`  **Ticks:** 0  **Output:** tallow_candle ×3

**Recipe — Dip candle (beeswax, cleaner burn):**
| Input | Qty |
|---|---|
| beeswax | 1 |
| linen_yarn | 1 |

**Station:** `bench` (chandler variant)  **Step:** `attack`  **Ticks:** 0  **Output:** beeswax_candle ×3  
**Notes:** Different stats on lightFlicker / smoke. Socially-differentiated — beeswax is the rich person's candle.

### `tallow`

**Kind:** stack **Role:** Candle fat; soap fat; waterproofing; leather dub.  
**Status:** Proposed.

**Recipe — Render fat:**
| Input | Qty |
|---|---|
| animal_fat | 2 |
| water | 1 |

**Station:** `cauldron`  **Step:** `time`  **Ticks:** 400  **Output:** tallow ×2 + greaves ×1 (byproduct → feed / soap)

---

## 11. Alchemical / chemical products

### `soap`

**Kind:** stack **Role:** Hygiene; leather degreasing; wool scouring; household item.  
**Status:** Proposed.

**Recipe — Saponify (basic):**
| Input | Qty |
|---|---|
| tallow | 2 |
| lye | 1 |

**Station:** `cauldron`  **Step:** `time`  **Ticks:** 800  **Output:** curd_soap ×3

**Recipe — Hard soap (proposed upgrade):**
| Input | Qty |
|---|---|
| curd_soap | 3 |
| salt | 1 |

**Station:** `cauldron`  **Step:** `time`  **Ticks:** 300  **Output:** hard_soap ×3  
**Notes:** Salt-out step separates the soap curd from spent lye. Historically how real bar soap is made.

### `pine_tar` / `pine_pitch` / `rosin`

**Kind:** stacks **Role:** Waterproofing; rope preservation; boot-seam seal; torch fuel.  
**Status:** Proposed. Deferred — pyrolysis_pit is first-wave station but its consumed-station behaviour needs GAP-CONSUMED-STATION or the workaround.

**Recipe — Tar burn:**
| Input | Qty |
|---|---|
| resinous_pine | 6 |

**Station:** `pyrolysis_pit`  **Step:** `time`  **Ticks:** 3000  **Output:** pine_tar ×3 + charcoal ×2

---

## 12. Ceramics

### `clay_pot`

**Kind:** stack **Role:** Cooking; storage; brine fermentation; grain store.  
**Status:** Proposed.

**Step A — Throw pot:**
| Input | Qty |
|---|---|
| raw_clay | 2 |

**Station:** `loom_device` (potters_wheel)  **Step:** `time`  **Ticks:** 120  **Output:** greenware_pot ×1

**Step B — Dry:**
| Input | Qty |
|---|---|
| greenware_pot | 1 |

**Station:** `rack`  **Step:** `time`  **Ticks:** 1200  **Output:** dry_pot ×1

**Step C — Fire:**
| Input | Qty |
|---|---|
| dry_pot | 3 |
| charcoal | 2 |

**Station:** `kiln`  **Step:** `time`  **Ticks:** 1200  **Output:** clay_pot ×3

**Alternative — Bisque + gloss (glazed variant):**

Repeat kiln firing after a glaze dip — `vat` (glazing variant) between steps B and C. Glazed pots are used for wine/oil storage.

### `crucible`

**Kind:** stack (consumed single-use, but stacks in inventory) **Role:** Molten-metal vessel for copper/bronze/brass smelts.  
**Status:** Proposed.

**Recipe — Fireclay crucible:**
| Input | Qty |
|---|---|
| fireclay | 2 |
| sand | 1 |

**Station:** `kiln`  **Step:** `time`  **Ticks:** 1800  **Output:** crucible ×1  
**Notes:** Consumed as an *input* in the `furnace` crucible-melt recipes — the GAP-CONSUMED-STATION workaround.

### `brick`

**Kind:** stack **Role:** Masonry (alternative to stone_block); bread_oven construction.  
**Status:** Proposed.

**Step A — Mould brick:**
| Input | Qty |
|---|---|
| raw_clay | 1 |
| sand | 1 |

**Station:** `mould` (brick variant)  **Step:** `attack`  **Ticks:** 0  **Output:** green_brick ×1

**Step B — Fire:**
| Input | Qty |
|---|---|
| green_brick | 10 |
| charcoal | 3 |

**Station:** `kiln`  **Step:** `time`  **Ticks:** 2400  **Output:** brick ×10

---

## 13. Byproducts and secondary items

These aren't authored with their own primary recipe; they fall out of
other recipes. Listed here so downstream chains can cite them.

| id | Origin | Used by |
|---|---|---|
| `wood_ash` | every wood fire | lye, potash, ceramic flux |
| `hammer_scale` | iron consolidation / blade hammering | iron_sulfate → ink; pigment |
| `slag` | bloomery, copper_matte | masonry aggregate; glass flux |
| `lanolin` | wool scouring | soap, leather-dub, waterproofing |
| `whey` | cheese setting | animal feed; ricotta-second-make |
| `tow` | flax break / scutch / heckle | gambeson stuffing, caulking, coarse twine |
| `hair` | hide dehair | felt, brush bristle, mortar binder |
| `bran` | grain mill | animal feed, brewing second mash |
| `oil_cake` | oil press | animal feed |
| `spent_grain` | mash tun | animal feed |
| `offal` / `dung` | butchery / livestock | bate liquor, fertiliser |
| `flue_dust` | lime burn | discarded today (saltpeter reagent eventually) |
| `stone_chip` | stone_block dressing | mortar aggregate |
| `flax_shive` | flax break | kindling |

---

## Closing notes

**Authoring order (first wave).** Read top-down, but author the primary
materials layer before the tools that consume them, before the weapons /
items that consume those. A dependency-respecting sequence from this
catalogue:

1. Primitives (already resource-nodes; no authoring).
2. wood → `plank` (authored today, keep).
3. stone → `stone_block` (authored today, keep).
4. wood → `charcoal` (new — pyrolysis_pit).
5. `iron_ore` + `charcoal` → `iron_ingot` (replace current simplification).
6. Tools: `hammer`, `axe`, `pickaxe`, `shovel`, `knife`, `chisel`, `shears`.
7. Weapons: existing wooden_*, plus `iron_sword` via chain.
8. `limestone` → `quicklime` → `slaked_lime` → `mortar_paste`.
9. Raw hide → `salted_hide` → `limed_hide` → `bated_hide` → `tanned_leather`.
10. Parallel parchment chain branching at bated_hide.
11. Flax chain → `linen_yarn` → `linen_cloth`.
12. Wool chain → `wool_yarn` → `wool_cloth`.
13. Food: `flour` → `dough` → `bread`; `cheese`; `ale`; salt.
14. Lore: `oak_gall_ink` → `inscribed_tome`.
15. Ceramics: `clay_pot`, `crucible`, `brick`.
16. Light: `candle`, `torch` variants.

**Multi-recipe principle honoured.** Every item that has a plausible
historical alternative is authored with both paths. Examples:
`plank` (chop vs rive), `charcoal` (pit vs kiln), `salt` (boil vs solar),
`flour` (quern vs watermill), `wool_cloth` (broadcloth vs felt),
`tanned_leather` (bark vs alum), `candle` (tallow vs beeswax). Each
alternative has different throughput, different quality, and different
regional viability — the substance of regional specialisation.

**Excluded from first wave** (require engine gaps to read right): woad
dye, glass blowing, live-mother vinegar, aged cheese, solar salt,
verdigris, lead-white, saltpeter. Flagged in SUMMARY.md §9 with specific
blocking gaps.
