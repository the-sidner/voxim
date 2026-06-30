/**
 * Pipeline metadata — single source of truth for stage order, transformer
 * references, and the `GenParams` slice each stage consumes.
 *
 * `generateTile()` uses an explicit `pipe(bind(noiseField, …), …)` chain
 * so the compiler enforces stage ordering. The instrumented runner
 * (server-side inspector use) iterates this array instead, threading
 * each transformer with the matching params slice. Both paths produce
 * byte-identical output (T-204 snapshot test asserts).
 *
 * Adding a stage means adding it here, in `generate.ts`'s `pipe()`, and
 * in the state type chain. The compiler will yell if any of those drift.
 */

import type { Transformer } from "@voxim/levelgen";
import { noiseField } from "./noise_field.ts";
import { junctions } from "./junctions.ts";
import { network } from "./network.ts";
import { rooms } from "./rooms.ts";
import { portalPlacement } from "./portal_placement.ts";
import { boundaryKinds } from "./boundary_kinds.ts";
import { rivers } from "./rivers.ts";
import { terrain } from "./terrain.ts";
import { materials } from "./materials.ts";
import { zoneGraph } from "./zone_graph.ts";
import { poiNetwork } from "./poi_network.ts";
import { fieldsStage } from "./fields.ts";
import type { GenParams } from "../../genparams.ts";

export type StageId =
  | "noiseField" | "junctions" | "network" | "rooms" | "portalPlacement"
  | "boundaryKinds" | "rivers" | "terrain" | "materials" | "zoneGraph"
  | "poiNetwork" | "fields";

export interface StageMeta {
  id: StageId;
  /** Erased to `unknown` here — the typed chain lives in `generate.ts`. */
  transformer: Transformer<unknown, unknown, unknown>;
  /** Which `GenParams` slice this stage consumes. */
  paramsKey: keyof GenParams;
  /** Human label for the trace panel. */
  label: string;
}

export const ORDERED_STAGES: ReadonlyArray<StageMeta> = [
  { id: "noiseField",      transformer: noiseField      as Transformer<unknown, unknown, unknown>, paramsKey: "noise",     label: "Noise field" },
  { id: "junctions",       transformer: junctions       as Transformer<unknown, unknown, unknown>, paramsKey: "room",      label: "Junctions" },
  { id: "network",         transformer: network         as Transformer<unknown, unknown, unknown>, paramsKey: "network",   label: "Network" },
  { id: "rooms",           transformer: rooms           as Transformer<unknown, unknown, unknown>, paramsKey: "room",      label: "Rooms" },
  { id: "portalPlacement", transformer: portalPlacement as Transformer<unknown, unknown, unknown>, paramsKey: "network",   label: "Portal placement" },
  { id: "boundaryKinds",   transformer: boundaryKinds   as Transformer<unknown, unknown, unknown>, paramsKey: "kinds",     label: "Boundary kinds" },
  { id: "rivers",          transformer: rivers          as Transformer<unknown, unknown, unknown>, paramsKey: "river",     label: "Rivers" },
  { id: "terrain",         transformer: terrain         as Transformer<unknown, unknown, unknown>, paramsKey: "terrain",   label: "Terrain" },
  { id: "materials",       transformer: materials       as Transformer<unknown, unknown, unknown>, paramsKey: "materials", label: "Materials" },
  { id: "zoneGraph",       transformer: zoneGraph       as Transformer<unknown, unknown, unknown>, paramsKey: "zoneGraph",  label: "Zone graph" },
  { id: "poiNetwork",      transformer: poiNetwork      as Transformer<unknown, unknown, unknown>, paramsKey: "poiNetwork", label: "POI network" },
  { id: "fields",          transformer: fieldsStage     as Transformer<unknown, unknown, unknown>, paramsKey: "fields",     label: "Render fields" },
];
