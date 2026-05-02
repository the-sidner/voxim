/**
 * AI manager HTTP server (T-143).
 *
 * Single endpoint:
 *   POST /agent/city  — body: CityContextPacket, returns AgentResponse.
 *
 * The current implementation always responds with a deterministic mock so
 * the coordinator integration can be exercised without LLM cost. A future
 * ticket replaces the dispatcher with a real Anthropic call.
 */
import { mockAgentResponse } from "./mock.ts";
import type { CityContextPacket } from "./types.ts";

export interface AiManagerServer {
  port: number;
  shutdown: () => Promise<void>;
}

export function startAiManager(port: number, hostname = "0.0.0.0"): AiManagerServer {
  const server = Deno.serve({ port, hostname }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/agent/city") {
      let packet: CityContextPacket;
      try {
        packet = await req.json() as CityContextPacket;
      } catch {
        return new Response("bad request", { status: 400 });
      }
      if (!packet?.cityId || !packet.trigger?.kind) {
        return new Response("missing required fields", { status: 400 });
      }
      const resp = mockAgentResponse(packet);
      console.log(
        `[AiManager] /agent/city city=${packet.cityId} trigger=${packet.trigger.kind} → ${resp.tool_calls.length} tool_calls`,
      );
      return Response.json(resp);
    }
    return new Response("not found", { status: 404 });
  });
  return {
    port,
    shutdown: () => server.shutdown(),
  };
}
