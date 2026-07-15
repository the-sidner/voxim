/**
 * AccountClient request timeout (T-361).
 *
 * A gateway that accepts the connection but never answers must produce a
 * REJECTION, not a forever-pending promise — teardownSession's account
 * bookkeeping is sequenced behind these awaits, and a never-settling fetch
 * has no `.catch` to fall into. Pinned with a local server that stalls.
 */

import { assert, assertRejects } from "jsr:@std/assert";
import { AccountClient } from "./account_client.ts";

const SECRET = "0123456789abcdef";

/** Serve on an ephemeral port; the handler decides stall vs answer. */
function stallServer(): { url: string; shutdown: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    // Never resolves — the request hangs until the client aborts.
    () => new Promise<Response>(() => {}),
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
  };
}

Deno.test("a hung gateway rejects saveFog within the timeout instead of wedging", async () => {
  const { url, shutdown } = stallServer();
  try {
    const client = new AccountClient(url, SECRET, 100);
    const t0 = performance.now();
    await assertRejects(() => client.saveFog("user-1", "0_0", new Uint8Array(8)));
    assert(performance.now() - t0 < 5_000, "rejected via the abort timeout, not a transport error");
  } finally {
    await shutdown();
  }
});

Deno.test("a hung gateway rejects recordDeath and updateLocation too", async () => {
  const { url, shutdown } = stallServer();
  try {
    const client = new AccountClient(url, SECRET, 100);
    await assertRejects(() => client.recordDeath("user-1", "damage"));
    await assertRejects(() => client.updateLocation("user-1", "0_0"));
  } finally {
    await shutdown();
  }
});
