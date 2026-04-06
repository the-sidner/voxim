# Voxim2

> **Heavily WIP.** This is a personal project in active, early development. Large parts of the design exist only as plans. Expect nothing to be finished.

---

A medieval post-apocalyptic multiplayer action RPG. Something happened — a catastrophe that broke the old world and left the land infected. You survive in the aftermath.

The game is not a story you are told. It is an ecosystem you inhabit. A small number of simple systems compose into something that feels alive: survival pressure drives you to gather, gathering feeds crafting, crafting enables fighting, fighting creates the need to build, building attracts NPCs, NPCs need food and beds, food needs farms, farms need tools, tools need ore — and so it circles back around.

---

## The world

The map is procedurally generated from biome, elevation, moisture, and corruption data. Plains, forests, mountains, swamps, ruins, and corrupted zones each produce different terrain, different resources, different threats. Rivers trace downhill; roads connect city seeds; corruption radiates outward from the ground-zero points of whatever happened before.

Everything is voxels. Not Minecraft-style hollow cubes — a heightmap world rendered as stacked voxels, with vertex displacement applied to every surface at render time to break the rigid grid. The same displacement formula runs on terrain, structures, items, and characters. Everything is made of the same stuff, rendered by the same rules. A sword on the ground and the ground beneath it are visually continuous.

No 3D models are hand-authored. Characters are voxel assemblies animated through a skeleton. Items look like what they are made of — a steel blade looks different from a stone one because the material itself has a visual definition, not because anyone drew it.

---

## The systems

**Survival** is a light layer of pressure. Hunger and thirst accumulate; ignore them long enough and your health drains. Day and night shift the threat level. The world is hostile by default — undead, bandits, wolves, and worse. Spending time near the catastrophe's worst zones builds up corruption in your character, which opens access to powerful pre-catastrophe knowledge at a cost that compounds.

**Combat** is real-time, skill-based, and directional. Your character faces the cursor. Attacks arc forward. Blocking is directional. Getting flanked is punishing. Timing a parry staggers the enemy; surviving a crowd requires managing your facing and your stamina simultaneously. No pausing. The reference is Vermintide — weight, timing, reading telegraph animations, managing groups.

**Crafting** is a material chain. Items are composed of parts, and parts are made of materials. The properties of the output derive from what you put in. A sword made of poor iron is worse than one made of steel — not because a stat says so, but because iron and steel have different properties and those properties propagate up through the crafting tree. Alchemy, religious rites, and pre-catastrophe Lore produce coatings, blessings, and wards that attach to equipment rather than existing as standalone spells.

**Lore** is the skill system. There are no classes and no skill trees. Lore is knowledge — raw understanding of a domain (alchemical, supernatural, religious, martial). It exists as physical objects in the world: tomes, scrolls, carved stones. You internalise Lore by reading it, training it, or receiving it from another character. Internalised Lore is lost on death unless you wrote it down first. Abilities are composed from Lore fragments rather than assigned from a menu — what you can do depends on what you know and how those pieces combine.

**NPCs** run on the same systems as players. They gather, craft, fight, and have survival needs. You can hire them by building a workbench and recruiting from passing wanderers. Give them food and beds and they stay. Neglect their needs and they leave or die. Productivity follows from infrastructure, not from UI sliders.

---

## The idea

The design goal is emergence from composition. Political structures, economies, faction dynamics — none of this is scripted. It follows from the pressure the systems create and how players and NPCs respond. The catastrophe is not backstory; it is an ongoing force in the world. Corruption accumulates in the land and in you. The most powerful knowledge comes from the deepest infected zones. The temptation is the design.
