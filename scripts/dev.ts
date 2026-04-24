/**
 * dev.ts — single entry point for local development.
 *
 * 1. Builds client bundle and voxel editor bundle in parallel.
 * 2. Starts tile server and devtools static server concurrently.
 *
 * Usage:
 *   deno task dev
 */

const root = new URL("..", import.meta.url);

function run(cmd: string[]): Deno.ChildProcess {
  return new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: root.pathname,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
}

// --- Step 1: build both bundles in parallel ---
console.log("[dev] building client + devtools...");

const buildClient = run([
  "deno", "run", "-A", "--node-modules-dir=auto", "scripts/build_client.ts",
]);
const buildDevtools = run([
  "deno", "run", "-A", "--node-modules-dir=auto", "scripts/build_voxel_editor.ts",
]);

const [clientStatus, devtoolsStatus] = await Promise.all([
  buildClient.output(),
  buildDevtools.output(),
]);

if (!clientStatus.success) {
  console.error("[dev] client build failed");
  Deno.exit(1);
}
if (!devtoolsStatus.success) {
  console.error("[dev] devtools build failed");
  Deno.exit(1);
}

console.log("[dev] builds complete — starting servers...");

// --- Step 2: start tile server + gateway + devtools server concurrently ---
const tileServer = run([
  "deno", "run",
  "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--unstable-net",
  "packages/tile-server/main.ts",
]);

const gatewayServer = run([
  "deno", "run",
  "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--unstable-net",
  "packages/gateway/main.ts",
]);

const devtoolsServer = run([
  "deno", "run", "--allow-net", "--allow-read",
  "scripts/serve_devtools.ts",
]);

// Forward Ctrl-C to all child processes.
Deno.addSignalListener("SIGINT", () => {
  tileServer.kill("SIGINT");
  gatewayServer.kill("SIGINT");
  devtoolsServer.kill("SIGINT");
});

await Promise.all([tileServer.output(), gatewayServer.output(), devtoolsServer.output()]);
