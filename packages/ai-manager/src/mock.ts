/**
 * Deterministic stub agent. Returns plausible tool calls based on the
 * trigger kind so the coordinator integration is fully testable without
 * reaching out to a real LLM. T-143 only proves the wiring; a follow-up
 * ticket swaps this for an Anthropic call.
 */
import type { AgentResponse, CityContextPacket } from "./types.ts";

export function mockAgentResponse(packet: CityContextPacket): AgentResponse {
  const trig = packet.trigger;
  switch (trig.kind) {
    case "gate_approached":
      return {
        tool_calls: [{ kind: "log_note", note: `${packet.name} noted a traveller crossing` }],
        rationale: "stub: travellers logged but no action taken",
      };
    case "food_shortfall":
      return {
        tool_calls: [{ kind: "spawn_role", role: "farmer", count: 1 }],
        rationale: "stub: shortfall → another farmer",
      };
    case "guard_understaffed":
      return {
        tool_calls: [{ kind: "spawn_role", role: "guard", count: 1 }],
        rationale: "stub: understaffed → another guard",
      };
    default:
      return {
        tool_calls: [{ kind: "log_note", note: `unhandled trigger ${trig.kind}` }],
      };
  }
}
