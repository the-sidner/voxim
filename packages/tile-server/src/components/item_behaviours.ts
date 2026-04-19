/**
 * Item-behaviour components — template components declared on any prefab that
 * represents a "thing you can have, hold, wear, swing, eat, or deploy".
 *
 * All are server-only: the client reconstructs item behaviour from the prefab
 * id it already has in its prefab store, so these never travel over the wire
 * as runtime deltas. Written onto the entity by the prefab spawner and stay
 * put for the entity's lifetime.
 *
 * Instance-lifetime components (Durability, Inscribed, QualityStamped,
 * History, Owned) live in instance.ts.
 */
import { defineComponent } from "@voxim/engine";
import { WireReader, WireWriter } from "@voxim/codecs";
import * as v from "valibot";
import type {
  EquipSlot, ItemSlotDef, StatContribution,
  EquippableData, SwingableData, ToolData, DeployableData,
  EdibleData, IlluminatorData, ArmorData, MaterialSourceData,
  ComposedData, StackableData, WeightData, RenderableData,
} from "@voxim/content";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const EQUIP_SLOT_VALUES = [
  "weapon",
  "offHand",
  "head",
  "chest",
  "legs",
  "feet",
  "back",
] as const;

const equipSlotSchema = v.picklist(EQUIP_SLOT_VALUES);

// ItemSlotDef used by Composed — named material slots that define the item's stat contributions.
const statContributionSchema = v.object({
  stat: v.string(),
  property: v.string(),
  multiplier: v.number(),
});

const itemSlotDefSchema = v.object({
  id: v.string(),
  materialCategories: v.array(v.string()),
  statContributions: v.array(statContributionSchema),
  modelSlotId: v.optional(v.string()),
});

// ---------------------------------------------------------------------------
// Equippable — item can be worn in a specific equipment slot
// ---------------------------------------------------------------------------

const equippableSchema = v.object({
  slot: equipSlotSchema,
});

export const Equippable = defineComponent({
  name: "equippable" as const,
  networked: false,
  schema: equippableSchema,
  codec: {
    encode(v: EquippableData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.slot);
      return w.toBytes();
    },
    decode(b: Uint8Array): EquippableData {
      const r = new WireReader(b);
      return { slot: r.readStr() as EquipSlot };
    },
  },
  default: (): EquippableData => ({ slot: "weapon" }),
});

// ---------------------------------------------------------------------------
// Swingable — item can be swung; drives ActionSystem + AnimationSystem
// ---------------------------------------------------------------------------

const swingableSchema = v.object({
  weaponActionId: v.string(),
});

export const Swingable = defineComponent({
  name: "swingable" as const,
  networked: false,
  schema: swingableSchema,
  codec: {
    encode(v: SwingableData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.weaponActionId);
      return w.toBytes();
    },
    decode(b: Uint8Array): SwingableData {
      const r = new WireReader(b);
      return { weaponActionId: r.readStr() };
    },
  },
  default: (): SwingableData => ({ weaponActionId: "" }),
});

// ---------------------------------------------------------------------------
// Tool — item is recognised as a tool by GatheringSystem and recipes that
// specify requiredTools. Mirrors the current ItemTemplate.toolType field.
// ---------------------------------------------------------------------------

const toolSchema = v.object({
  toolType: v.string(),
});

export const Tool = defineComponent({
  name: "tool" as const,
  networked: false,
  schema: toolSchema,
  codec: {
    encode(v: ToolData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.toolType);
      return w.toBytes();
    },
    decode(b: Uint8Array): ToolData {
      const r = new WireReader(b);
      return { toolType: r.readStr() };
    },
  },
  default: (): ToolData => ({ toolType: "" }),
});

// ---------------------------------------------------------------------------
// Deployable — item unfolds into a world entity when placed. The referenced
// prefab is spawned at the deploy location.
// ---------------------------------------------------------------------------

const deployableSchema = v.object({
  prefabId: v.string(),
});

export const Deployable = defineComponent({
  name: "deployable" as const,
  networked: false,
  schema: deployableSchema,
  codec: {
    encode(v: DeployableData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.prefabId);
      return w.toBytes();
    },
    decode(b: Uint8Array): DeployableData {
      const r = new WireReader(b);
      return { prefabId: r.readStr() };
    },
  },
  default: (): DeployableData => ({ prefabId: "" }),
});

// ---------------------------------------------------------------------------
// Edible — item can be consumed to restore needs / buffs. Replaces the
// foodValue / waterValue fields currently on DerivedItemStats.
// ---------------------------------------------------------------------------

const edibleSchema = v.object({
  food: v.number(),
  water: v.number(),
  health: v.number(),
  stamina: v.number(),
});

export const Edible = defineComponent({
  name: "edible" as const,
  networked: false,
  schema: edibleSchema,
  codec: {
    encode(v: EdibleData): Uint8Array {
      const w = new WireWriter();
      w.writeF32(v.food);
      w.writeF32(v.water);
      w.writeF32(v.health);
      w.writeF32(v.stamina);
      return w.toBytes();
    },
    decode(b: Uint8Array): EdibleData {
      const r = new WireReader(b);
      return {
        food: r.readF32(),
        water: r.readF32(),
        health: r.readF32(),
        stamina: r.readF32(),
      };
    },
  },
  default: (): EdibleData => ({ food: 0, water: 0, health: 0, stamina: 0 }),
});

// ---------------------------------------------------------------------------
// Illuminator — item emits light while equipped. Replaces light* fields
// currently on DerivedItemStats. Distinct from the runtime `lightEmitter`
// component which is attached to the equipper (EquipmentSystem reads the
// item's Illuminator and writes lightEmitter on the holder).
// ---------------------------------------------------------------------------

const illuminatorSchema = v.object({
  radius: v.number(),
  color: v.number(),
  intensity: v.number(),
  flicker: v.number(),
});

export const Illuminator = defineComponent({
  name: "illuminator" as const,
  networked: false,
  schema: illuminatorSchema,
  codec: {
    encode(v: IlluminatorData): Uint8Array {
      const w = new WireWriter();
      w.writeF32(v.radius);
      w.writeI32(v.color);
      w.writeF32(v.intensity);
      w.writeF32(v.flicker);
      return w.toBytes();
    },
    decode(b: Uint8Array): IlluminatorData {
      const r = new WireReader(b);
      return {
        radius: r.readF32(),
        color: r.readI32(),
        intensity: r.readF32(),
        flicker: r.readF32(),
      };
    },
  },
  default: (): IlluminatorData => ({
    radius: 0,
    color: 0xffaa44,
    intensity: 0,
    flicker: 0,
  }),
});

// ---------------------------------------------------------------------------
// Armor — item reduces incoming damage and applies a stamina regen penalty
// while worn. Replaces armor* fields currently on DerivedItemStats.
// ---------------------------------------------------------------------------

const armorSchema = v.object({
  reduction: v.number(),
  staminaPenalty: v.number(),
});

export const Armor = defineComponent({
  name: "armor" as const,
  networked: false,
  schema: armorSchema,
  codec: {
    encode(v: ArmorData): Uint8Array {
      const w = new WireWriter();
      w.writeF32(v.reduction);
      w.writeF32(v.staminaPenalty);
      return w.toBytes();
    },
    decode(b: Uint8Array): ArmorData {
      const r = new WireReader(b);
      return { reduction: r.readF32(), staminaPenalty: r.readF32() };
    },
  },
  default: (): ArmorData => ({ reduction: 0, staminaPenalty: 0 }),
});

// ---------------------------------------------------------------------------
// MaterialSource — when this item is used as a recipe input, it contributes
// this material identity into the recipe's output slots. Replaces
// ItemTemplate.materialName.
// ---------------------------------------------------------------------------

const materialSourceSchema = v.object({
  materialName: v.string(),
});

export const MaterialSource = defineComponent({
  name: "materialSource" as const,
  networked: false,
  schema: materialSourceSchema,
  codec: {
    encode(v: MaterialSourceData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.materialName);
      return w.toBytes();
    },
    decode(b: Uint8Array): MaterialSourceData {
      const r = new WireReader(b);
      return { materialName: r.readStr() };
    },
  },
  default: (): MaterialSourceData => ({ materialName: "" }),
});

// ---------------------------------------------------------------------------
// Composed — item has named material slots; each slot accepts materials of
// certain categories and contributes to derived stats. The slot *schema*
// lives on this template component; per-instance parts data (which material
// fills each slot on a specific item) will land as an instance component on
// the item entity when material-axis derivation is turned on.
// ---------------------------------------------------------------------------

const composedSchema = v.object({
  slots: v.array(itemSlotDefSchema),
});

export const Composed = defineComponent({
  name: "composed" as const,
  networked: false,
  schema: composedSchema,
  codec: {
    encode(v: ComposedData): Uint8Array {
      const w = new WireWriter();
      w.writeU8(v.slots.length);
      for (const s of v.slots) {
        w.writeStr(s.id);
        w.writeU8(s.materialCategories.length);
        for (const c of s.materialCategories) w.writeStr(c);
        w.writeU8(s.statContributions.length);
        for (const sc of s.statContributions) {
          w.writeStr(sc.stat as string);
          w.writeStr(sc.property as string);
          w.writeF32(sc.multiplier);
        }
        w.writeU8(s.modelSlotId !== undefined ? 1 : 0);
        if (s.modelSlotId !== undefined) w.writeStr(s.modelSlotId);
      }
      return w.toBytes();
    },
    decode(b: Uint8Array): ComposedData {
      const r = new WireReader(b);
      const slotCount = r.readU8();
      const slots: ItemSlotDef[] = [];
      for (let i = 0; i < slotCount; i++) {
        const id = r.readStr();
        const materialCategoriesCount = r.readU8();
        const materialCategories: string[] = [];
        for (let j = 0; j < materialCategoriesCount; j++) {
          materialCategories.push(r.readStr());
        }
        const statContributionsCount = r.readU8();
        const statContributions: StatContribution[] = [];
        for (let j = 0; j < statContributionsCount; j++) {
          statContributions.push({
            stat: r.readStr() as StatContribution["stat"],
            property: r.readStr() as StatContribution["property"],
            multiplier: r.readF32(),
          });
        }
        const hasModelSlot = r.readU8();
        const modelSlotId = hasModelSlot ? r.readStr() : undefined;
        slots.push({
          id,
          materialCategories,
          statContributions,
          ...(modelSlotId !== undefined ? { modelSlotId } : {}),
        });
      }
      return { slots };
    },
  },
  default: (): ComposedData => ({ slots: [] }),
});

// ---------------------------------------------------------------------------
// Stackable — marker component. Prefabs carrying this produce
// { prefabId, quantity } inventory slots; prefabs without it produce
// { entityId } slots backed by a real item entity.
// ---------------------------------------------------------------------------

const stackableSchema = v.object({});

export const Stackable = defineComponent({
  name: "stackable" as const,
  networked: false,
  schema: stackableSchema,
  codec: {
    encode(_v: StackableData): Uint8Array {
      return new Uint8Array(0);
    },
    decode(_b: Uint8Array): StackableData {
      return {};
    },
  },
  default: (): StackableData => ({}),
});

// ---------------------------------------------------------------------------
// Weight — base weight per unit. Material density (via Composed slots) may
// modulate the effective weight at derivation time.
// ---------------------------------------------------------------------------

const weightSchema = v.object({
  baseWeight: v.number(),
});

export const Weight = defineComponent({
  name: "weight" as const,
  networked: false,
  schema: weightSchema,
  codec: {
    encode(v: WeightData): Uint8Array {
      const w = new WireWriter();
      w.writeF32(v.baseWeight);
      return w.toBytes();
    },
    decode(b: Uint8Array): WeightData {
      const r = new WireReader(b);
      return { baseWeight: r.readF32() };
    },
  },
  default: (): WeightData => ({ baseWeight: 0 }),
});

// ---------------------------------------------------------------------------
// Renderable — visual model reference as a per-instance component. Not
// read by spawnPrefab today (the top-level Prefab.modelId / modelScale
// fields drive rendering via installVisualShell). Registered so prefabs
// can opt into per-instance visual overrides when we need them.
// ---------------------------------------------------------------------------

const renderableSchema = v.object({
  modelId: v.string(),
  scale: v.number(),
});

export const Renderable = defineComponent({
  name: "renderable" as const,
  networked: false,
  schema: renderableSchema,
  codec: {
    encode(v: RenderableData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.modelId);
      w.writeF32(v.scale);
      return w.toBytes();
    },
    decode(b: Uint8Array): RenderableData {
      const r = new WireReader(b);
      return { modelId: r.readStr(), scale: r.readF32() };
    },
  },
  default: (): RenderableData => ({ modelId: "", scale: 1 }),
});
