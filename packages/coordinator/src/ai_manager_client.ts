/**
 * Thin HTTP client for the ai-manager service (T-143). The client validates
 * the HTTP response shape — anything malformed becomes a null response so
 * the coordinator silently falls back to its utility AI.
 *
 * Significant-event rate limiting is the *coordinator's* responsibility, not
 * this client's: we only translate Promise → Promise here.
 */
import type { AgentResponse, CityContextPacket } from "@voxim/ai-manager";

export class AIManagerClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * POST /agent/city. Returns null on any network or shape error.
   */
  async dispatchCity(packet: CityContextPacket): Promise<AgentResponse | null> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/agent/city`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(packet),
      });
    } catch (err) {
      console.warn(`[AIManagerClient] fetch failed: ${(err as Error).message}`);
      return null;
    }
    if (!resp.ok) {
      console.warn(`[AIManagerClient] /agent/city returned ${resp.status}`);
      return null;
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return null;
    }
    if (!isAgentResponse(body)) {
      console.warn("[AIManagerClient] response missing tool_calls — discarding");
      return null;
    }
    return body;
  }
}

function isAgentResponse(x: unknown): x is AgentResponse {
  return typeof x === "object" && x !== null
    && Array.isArray((x as { tool_calls?: unknown }).tool_calls);
}
