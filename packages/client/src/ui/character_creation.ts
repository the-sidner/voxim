/// <reference lib="dom" />
/**
 * Character-creation overlay (T-071).
 *
 * Shown once before a fresh character's first connect: the player picks a
 * species (and, later, starting lore) which is carried into the join handshake
 * (`TileJoinRequest.speciesId`). The server validates the choice against
 * `game_config.species` and falls back to its default if absent/invalid, so
 * this screen is purely advisory — a convenience, never a trust boundary.
 *
 * Species options + their trait summaries come from the statically-bundled
 * `game_config.json` (the same import `game.ts` already uses for prediction
 * tuning), so the list is available *before* the bootstrap blob arrives — no
 * pre-join content round-trip. Restarting the tile-server with new species
 * picks them up on the next bundle, same as every other content value.
 *
 * Zero framework, mirroring `login.ts`: a one-screen modal rendered
 * imperatively before the game's Preact renderer boots.
 */
import gameConfigData from "../../../content/data/game_config.json" with { type: "json" };
import type { CharacterCreation } from "../connection/tile_connection.ts";

/** localStorage flag: set once the player has completed character creation. */
export const CHARACTER_CREATED_KEY = "voxim.character_created";

/** Has this device already created a character? Existing characters skip the screen. */
export function hasCreatedCharacter(): boolean {
  try { return localStorage.getItem(CHARACTER_CREATED_KEY) === "1"; }
  catch { return false; }
}

/** Mark character creation complete so future connects skip the screen. */
export function markCharacterCreated(): void {
  try { localStorage.setItem(CHARACTER_CREATED_KEY, "1"); } catch { /* ignore */ }
}

interface SpeciesModifier { stat: string; op: "add" | "mul"; value: number }
interface SpeciesEntry { id: string; modifiers: SpeciesModifier[] }

export interface CharacterCreationConfig {
  /** Mount point; contents are replaced. */
  container: HTMLElement;
  /** Fired with the chosen selections when the player confirms. */
  onCreated: (creation: CharacterCreation) => void;
}

/** Pull the playable species + their trait modifiers from bundled game config. */
function speciesOptions(): SpeciesEntry[] {
  // deno-lint-ignore no-explicit-any
  const species = (gameConfigData as any).species as
    | Record<string, { modifiers?: SpeciesModifier[] }>
    | undefined;
  if (!species) return [];
  return Object.entries(species).map(([id, def]) => ({ id, modifiers: def.modifiers ?? [] }));
}

/** Default selected species — `game_config.player.species`, else the first option, else "human". */
function defaultSpeciesId(options: SpeciesEntry[]): string {
  // deno-lint-ignore no-explicit-any
  const cfgDefault = (gameConfigData as any).player?.species as string | undefined;
  if (cfgDefault && options.some((o) => o.id === cfgDefault)) return cfgDefault;
  return options[0]?.id ?? "human";
}

/** Human-readable one-liner for a species' passive trait. "—" when inert. */
function traitSummary(mods: SpeciesModifier[]): string {
  if (mods.length === 0) return "No passive trait — the baseline.";
  return mods.map((m) => {
    const stat = m.stat.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (m.op === "mul") {
      const pct = Math.round((m.value - 1) * 100);
      return `${pct >= 0 ? "+" : ""}${pct}% ${stat}`;
    }
    return `${m.value >= 0 ? "+" : ""}${m.value} ${stat}`;
  }).join(", ");
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function showCharacterCreation(config: CharacterCreationConfig): void {
  const { container, onCreated } = config;
  container.innerHTML = "";
  container.appendChild(buildRoot(onCreated));
}

const STYLES = `
.cc-root {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--col-bg, #16130e);
  font-family: var(--font-body, 'Manrope', system-ui, sans-serif);
  color: var(--col-text, #d4c9a8);
  z-index: 100;
  pointer-events: auto;
}
.cc-card {
  background: var(--col-bg-raised, #1f1b14);
  border: 1px solid var(--col-border, #3d3428);
  padding: 32px;
  width: 420px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cc-card h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.cc-sub {
  margin: 0;
  font-size: 12px;
  color: var(--col-text-dim, #7a6f58);
}
.cc-species-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cc-species {
  text-align: left;
  padding: 10px 12px;
  background: var(--col-bg, #16130e);
  border: 1px solid var(--col-border, #3d3428);
  color: var(--col-text, #d4c9a8);
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cc-species.selected {
  border-color: var(--col-accent, #c8953a);
}
.cc-species-name {
  font-size: 14px;
  font-weight: 600;
}
.cc-species-trait {
  font-size: 12px;
  color: var(--col-text-dim, #7a6f58);
}
.cc-submit {
  padding: 10px;
  background: var(--col-accent, #c8953a);
  border: none;
  color: var(--col-bg, #16130e);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
}
.cc-submit:disabled { opacity: 0.5; cursor: not-allowed; }
`;

function buildRoot(onCreated: (creation: CharacterCreation) => void): HTMLElement {
  ensureStyles();

  const options = speciesOptions();
  let selected = defaultSpeciesId(options);

  const root = document.createElement("div");
  root.className = "cc-root";

  const card = document.createElement("div");
  card.className = "cc-card";
  root.appendChild(card);

  const title = document.createElement("h1");
  title.textContent = "Choose your kind";
  card.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "cc-sub";
  sub.textContent = "Your species carries a passive trait for life. Choose well.";
  card.appendChild(sub);

  const list = document.createElement("div");
  list.className = "cc-species-list";
  card.appendChild(list);

  const buttons: HTMLButtonElement[] = [];
  const refresh = () => {
    for (const b of buttons) b.classList.toggle("selected", b.dataset.id === selected);
  };

  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cc-species";
    b.dataset.id = opt.id;

    const name = document.createElement("span");
    name.className = "cc-species-name";
    name.textContent = titleCase(opt.id);
    b.appendChild(name);

    const trait = document.createElement("span");
    trait.className = "cc-species-trait";
    trait.textContent = traitSummary(opt.modifiers);
    b.appendChild(trait);

    b.addEventListener("click", () => { selected = opt.id; refresh(); });
    list.appendChild(b);
    buttons.push(b);
  }
  refresh();

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "cc-submit";
  submit.textContent = "Enter the world";
  submit.disabled = options.length === 0;
  submit.addEventListener("click", () => {
    markCharacterCreated();
    // Remove ourselves so the game's renderer gets the uncovered canvas.
    root.remove();
    onCreated({ speciesId: selected, initialFragmentIds: [] });
  });
  card.appendChild(submit);

  return root;
}

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  const s = document.createElement("style");
  s.textContent = STYLES;
  document.head.appendChild(s);
  stylesInjected = true;
}
