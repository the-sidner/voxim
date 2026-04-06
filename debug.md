# Voxim2 — Debug Reference

## Deno version

The project pins Deno **2.7.11** via `.dvmrc`.  DVM must be active in your shell for `deno` to resolve to the right binary.  If it isn't, prefix every command with the full path:

```
~/.dvm/versions/2.7.11/deno task …
```

In an interactive shell with DVM sourced, the tasks below work as-is.

---

## Starting the server

Run these in two separate terminals from the project root.

### Terminal 1 — tile server
```
deno task demo-server
```
Logs to **`/tmp/voxim-tile.log`** when redirected, or to stdout directly.  To capture:
```
deno task demo-server > /tmp/voxim-tile.log 2>&1
```

Endpoints exposed:
| URL | Purpose |
|-----|---------|
| `https://0.0.0.0:4434` | WebTransport (game clients) |
| `http://127.0.0.1:14434/game` | Game HTML + bundled JS (open in browser) |
| `http://127.0.0.1:14434/game.js` | Bundled client JS |
| `http://127.0.0.1:14434/cert-hash` | TLS cert SHA-256 (JSON) |
| `http://127.0.0.1:14434/health` | `{"status":"ok"}` |

### Terminal 2 — client bundle
```
deno task demo-client
```
Writes **`packages/client/dist/game.js`**.  Re-run after any client code change; no hot-reload.

### Play
Open **`http://127.0.0.1:14434/game`** in Chromium/Chrome.  The page injects `VOXIM_TILE_ADDRESS` automatically so no URL params are needed.

---

## Log files

| File | Written by |
|------|-----------|
| `/tmp/voxim-tile.log` | tile server (if you redirect stdout) |
| `/tmp/voxim-bundle.log` | bundle step (if you redirect stdout) |
| `/tmp/voxim-screenshot.png` | default playwright screenshot output |

Tail the server log live:
```
tail -f /tmp/voxim-tile.log
```

---

## Playwright screenshot tool

Requires the game server to be running and the client to be built.

### Basic usage
```
node scripts/screenshot.mjs
```
Saves to **`/tmp/voxim-screenshot.png`** by default.

### Options
| Flag | Default | Description |
|------|---------|-------------|
| `--skeleton` | off | Enable skeleton overlay before capturing |
| `--wait <n>` | `4` | Seconds to wait after connection before capture |
| `--out <path>` | `/tmp/voxim-screenshot.png` | Output PNG path |

### Examples
```bash
# Quick screenshot, no overlay
node scripts/screenshot.mjs

# Skeleton overlay visible, wait longer for NPCs to load
node scripts/screenshot.mjs --skeleton --wait 10

# Custom output path
node scripts/screenshot.mjs --skeleton --out /tmp/debug-pose.png
```

The script waits for `window._voxim_connected === true` (set by the game after the tile join handshake) before counting down the wait timer, so connection latency doesn't affect the result.

---

## Browser devtools helpers

These globals are available in the browser console after the game connects:

```js
// Toggle skeleton overlay on/off; returns new state (true = visible)
_voxim_game.toggleSkeletonOverlay()

// Check connection status
_voxim_connected   // true once joined

// Access renderer directly
_voxim_game.renderer.skeletonOverlay.enabled
```

---

## Playwright debug client (headless protocol client)

Connects via WebTransport and logs state message summaries to stdout.  Does **not** render — useful for checking server output without a browser.

```
deno task debug-client
```

Environment variables:
```
SERVER_URL=https://127.0.0.1:4434   # default
CERT_FILE=./certs/cert.pem          # default
PRINT_INTERVAL=20                   # print every N ticks
VERBOSE=1                           # print every tick
```

---

## TLS certificates

Self-signed certs live in `certs/`.  To regenerate:
```
deno task gen-certs
```

Chromium must be launched with `--ignore-certificate-errors` and `--origin-to-force-quic-on=127.0.0.1:4434` for WebTransport to work with self-signed certs.  The Playwright script already sets these flags.
