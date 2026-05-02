/**
 * AI manager entry point (T-143).
 *
 * Environment variables:
 *   PORT      Listening port. Default: 8090
 *   HOSTNAME  Bind address. Default: 0.0.0.0
 *
 * Stub LLM dispatcher: returns deterministic mock tool_calls per trigger
 * kind. A follow-up ticket replaces this with a real Anthropic call.
 */
import { startAiManager } from "./src/server.ts";

const port = parseInt(Deno.env.get("PORT") ?? "8090");
const hostname = Deno.env.get("HOSTNAME") ?? "0.0.0.0";

const server = startAiManager(port, hostname);
console.log(`[AiManager] listening on ${hostname}:${server.port}`);

await new Promise(() => {});
