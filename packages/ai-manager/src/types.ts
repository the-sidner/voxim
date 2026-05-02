/**
 * Wire shapes for the coordinator ↔ ai-manager HTTP API.
 *
 * Stable enough to be the contract of `POST /agent/city`. Adding new fields
 * is fine; renaming or removing requires bumping both sides in lockstep.
 */

/**
 * Snapshot of a city's recent state, sent to the AI manager so it can decide
 * what the city should do next. The coordinator builds this on each
 * "significant event" — a major change in the city's situation that warrants
 * spending an LLM call on.
 */
export interface CityContextPacket {
  cityId: string;
  /** Macro-grid tile this city sits on. */
  tileId: string;
  /** Display name (so the LLM can refer to it). */
  name: string;
  /** Free-form personality string from CityState. */
  personality: string;
  /** Current numeric snapshot of the city. Coordinator-defined shape. */
  state: Record<string, unknown>;
  /** The most recent events from the city's log (oldest first, capped). */
  recentEvents: Array<{ tick: number; kind: string; detail?: Record<string, unknown> }>;
  /** The discrete event that triggered this call (matches recentEvents[-1]). */
  trigger: { tick: number; kind: string; detail?: Record<string, unknown> };
}

/**
 * Tool calls the AI manager wants the coordinator to execute. The
 * coordinator validates each call against a small allow-list before
 * dispatching it as a TileCommand. Unknown kinds are dropped.
 */
export type AgentToolCall =
  | { kind: "spawn_role"; role: "farmer" | "guard"; count: number }
  | { kind: "dispatch_caravan"; toTileId: string; cargo: { itemType: string; quantity: number }[] }
  | { kind: "log_note"; note: string };

export interface AgentResponse {
  /** Tool calls to execute, in order. */
  tool_calls: AgentToolCall[];
  /** Optional model-facing rationale for inclusion in the city event log. */
  rationale?: string;
}
