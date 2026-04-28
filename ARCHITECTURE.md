# Voxim2 — System Architecture

This document describes the cross-process architecture: which services exist,
who owns what state, and how they talk to each other. For per-package internals
(ECS, codecs, tile tick loop, etc.) see [CLAUDE.md](CLAUDE.md).

---

## Process landscape

```
                             ┌──────────────────┐
                             │   AI Manager     │
                             │  (LLM service)   │
                             └────────▲─────────┘
                                      │ HTTP (request/response)
                                      │
                             ┌────────┴─────────┐
                             │ World Coordinator│
                             │  ECS + tickloop  │
                             │ (macro entities) │
                             └────────▲─────────┘
                                      │ WebTransport (privileged)
                                      │ events ↑   commands ↓
                                      ▼
   ┌──────────┐   WT    ┌──────────────────────┐   WT    ┌──────────────┐
   │  Client  │────────▶│       Gateway        │◀───────▶│ Tile Servers │
   │ (browser)│  HTTPS  │   (edge: auth +      │  events │   (1..N)     │
   └──────────┘         │    routing only)     │ commands│              │
                        └──────────┬───────────┘         └──────┬───────┘
                                   │                            │
                                   ▼                            ▼
                         ┌──────────────────────────────────────────┐
                         │              Postgres                    │
                         └──────────────────────────────────────────┘
```

Five process roles. All persistent state in Postgres. Tile-servers and
coordinator are stateless on disk — kill the container, bring up another with
the same identity, it picks up where the old one left off.

### Per-process responsibilities

| Process | Owns | Talks to | Persists to |
|---------|------|----------|-------------|
| **Client** | Render, input, UI, local interpolation | Gateway (HTTPS auth + handshake), Tile (WT gameplay) | `localStorage` token only |
| **Gateway** | Auth, sessions, tile registry, handoff proxy, event routing, **(stub) tile-server orchestration** | Client (HTTPS + WT), Tile Servers (WT), Coordinator (WT), DB | `users`, `heritage`, `sessions`, `tile_registry` |
| **Tile Server** | One 512×512 world tile: physics, NPCs, players, terrain, combat | Gateway (WT) | `tile_saves` (own row only) |
| **World Coordinator** | World map, cities, caravans, trade, macro events. ECS with slow tick (≤1 Hz) reusing `@voxim/engine` | Gateway (WT), AI Manager (HTTP), DB | `world_map`, `cities` |
| **AI Manager** | LLM API calls, prompt assembly, response parsing, rate limiting | Coordinator (HTTP responses), Anthropic API | Stateless (or short cache) |

---

## Why split this way

Three independent concerns that scale on different axes:

- **Edge** (gateway) — request-rate bound. Auth, session lookup, routing. No
  heavy compute, ever. Scales by replication if it ever needs to.
- **Macro sim** (coordinator) — tick-rate bound, but slow ticks (1 Hz). One
  authoritative process. Reuses ECS/tickloop because we already wrote them.
- **LLM** (AI Manager) — request-rate bound, latency-tolerant (seconds), API
  rate-limited. Isolated so an LLM stall can't block edge or macro work.

Tile-servers are sharded by tile geometry (one tile = one process) and never
hold global state.

---

## Communication patterns

### Client ↔ Gateway

- **HTTPS** for `/account/*` (register, login, me) — request/response, JSON.
- **HTTPS** `POST /gateway/connect { token }` → returns the tile address the
  client should connect to.
- After handshake, gateway is **out of the data path** for gameplay.

### Client ↔ Tile

- **WebTransport** direct connection. Reliable stream for join handshake +
  state messages. Datagrams for input.
- Client may be told to switch tiles via a `GateCrossing` event in the state
  stream — closes WT, opens new WT to the destination tile.

### Tile ↔ Gateway

- **WebTransport reliable stream** opened by tile on startup. Identifies as
  `kind: "tile"` with `X-Voxim-Service-Secret`.
- Tile publishes `WorldEvent`s up the stream.
- Gateway pushes `TileCommand`s down the stream (e.g., from coordinator).
- Tile **registers** via `POST /register` and **heartbeats** every 10s
  (`POST /heartbeat`). Gateway evicts after 30s without a ping.
- Player handoffs are still HTTP `POST /handoff` (gateway proxies the entity
  payload between source and destination tiles).

### Coordinator ↔ Gateway

- **WebTransport reliable stream** opened by coordinator on startup. Identifies
  as `kind: "coordinator"`. Same routing primitives as tile streams — the only
  difference is privilege (coordinator can broadcast to any tile, tiles can
  only publish events).

### Coordinator ↔ AI Manager

- **HTTP request/response.** Coordinator assembles a context packet, POSTs to
  AI Manager, gets back a structured response (tool calls). Async, may take
  seconds. Rate-limited per city.

### Tile ↔ Tile

- **Never directly.** All cross-tile state changes flow through the gateway
  (handoffs) or the coordinator (macro events).

---

## Data ownership

| Data | Owner | Mutable by | Readable by |
|------|-------|------------|-------------|
| User account, password hash, settings | Gateway (`users` table) | Gateway only | Gateway only |
| Heritage binary blob | Gateway (`heritage`) | Gateway via `/internal/user/{id}/death` | Gateway → tile via `/internal/user/{id}/heritage` |
| Session token (hashed) | Gateway (`sessions`) | Gateway only | Gateway only |
| Tile registry | Gateway (`tile_registry`) | Tile self-register / heartbeat | Gateway only |
| World map (immutable post-gen) | Coordinator (`world_map`) | Coordinator (write once) | Tile via gateway-proxied lookup |
| City state | Coordinator (`cities`) | Coordinator (in response to events) | Coordinator only |
| Tile snapshot | Tile-server (`tile_saves`, one row) | Owning tile-server only | Owning tile-server only |
| In-flight handoff | Gateway (in-memory) | Gateway only | — |
| Player position / inventory | Tile-server (in-memory + included in tile snapshot) | Tile-server only | — |

**World map is immutable post-generation.** Tile-servers consume their cell as
input to local terrain gen; player edits live in the tile snapshot. Macro-level
mutations (city falls, trade route severed) are tracked in `cities`, not in the
world map. No per-tile world-map override layer.

---

## Database

Postgres. Single instance for now; can replicate later if read-heavy.

Tables:

```sql
users (
  user_id           uuid primary key,
  login_name        text unique not null,
  password_hash     text not null,
  created_at        timestamptz not null default now(),
  last_login_at     timestamptz,
  active_dynasty_id uuid not null,
  last_tile_id      text,
  hearth_anchor     jsonb,
  settings          jsonb not null default '{}'
)

heritage (
  user_id     uuid primary key references users,
  payload     bytea not null,
  updated_at  timestamptz not null default now()
)

sessions (
  token_hash  text primary key,
  user_id     uuid not null references users,
  expires_at  timestamptz not null
)

tile_registry (
  tile_id            text primary key,
  address            text not null,
  admin_url          text not null,
  last_heartbeat_at  timestamptz not null default now()
)

tile_saves (
  tile_id    text primary key,
  payload    bytea not null,
  saved_at   timestamptz not null default now(),
  size_bytes integer not null
)

world_map (
  world_id      text primary key default 'default',
  seed          bigint not null,
  payload       bytea not null,
  generated_at  timestamptz not null default now()
)

cities (
  city_id     uuid primary key,
  name        text not null,
  tile_id     text not null,
  state       jsonb not null,
  event_log   jsonb not null default '[]',
  updated_at  timestamptz not null default now()
)
```

JSONB for shapes that will keep changing during macro design (CityState,
settings, hearth_anchor).

### Repository pattern

Only `packages/db` touches SQL. Every other package imports a typed repository
(`UserRepo`, `TileRepo`, `CityRepo`, etc.). This keeps schema concerns in one
place and makes test fakes trivial.

```
packages/db/
  client.ts          — Postgres pool
  migrate.ts         — tiny in-house forward migrator
  migrations/        — numbered .sql files
  repos/
    user_repo.ts
    heritage_repo.ts
    session_repo.ts
    tile_repo.ts
    tile_save_repo.ts
    world_map_repo.ts
    city_repo.ts
```

### Migrations

Forward-only, numbered SQL files. A `_migrations` table tracks applied
versions. Run via `deno task migrate`. No rollbacks — for breaking changes
during development the DB volume is wiped (`docker compose down -v`). Pre-1.0,
data is regeneratable.

---

## Deployment

### Local dev (docker-compose)

```
docker-compose.yml          base: postgres, certs init, named volumes
docker-compose.dev.yml      overrides: bind-mount packages/, --watch
```

Services:

| Service | Image | Ports (host:container) | Purpose |
|---------|-------|------------------------|---------|
| `postgres` | postgres:16 | 5432:5432 | DB |
| `certs-init` | local Dockerfile | — | Generates self-signed ECDSA P-256 cert into shared volume on first run |
| `gateway` | local Dockerfile | 8080:8080/udp, 8081:8081 | WT + HTTP admin |
| `coordinator` | local Dockerfile | — (internal only) | Macro sim |
| `tile-1` | local Dockerfile | 4433:4433/udp, 14434:14434 | First tile |
| `tile-2` | local Dockerfile | 4434:4433/udp, 14435:14434 | Optional |
| `tile-3` | local Dockerfile | 4435:4433/udp, 14436:14434 | Optional |
| `tile-4` | local Dockerfile | 4436:4433/udp, 14437:14434 | Optional |
| `client-dev` | local Dockerfile | 3000:3000 | Static-serves bundled client |

Tiles share a YAML anchor (`x-tile-base`) — adding tile-N is a few lines.

```bash
docker compose up -d postgres            # start DB
deno task migrate                        # run pending migrations from host
docker compose up -d                     # bring up everything
docker compose up -d tile-3              # add a tile mid-flight
docker compose stop tile-3               # remove (heartbeat eviction follows)
docker compose down -v                   # wipe everything incl. DB volume
```

`deno task dev` becomes a thin wrapper over the above.

### Certs

Shared volume `voxim-certs` populated by a one-shot `certs-init` container that
runs the existing `scripts/gen_certs.ts` (ECDSA P-256, 14-day validity for
WebTransport `serverCertificateHashes`). Recreated when the volume is empty.
**Never committed.**

### Adding tile-servers at runtime

WebTransport is end-to-end (gateway is out of the data path), so each tile
needs a host-reachable UDP port. `docker compose --scale` is awkward with
distinct UDP ports per replica, so:

**Today (manual):** declare tile slots statically (`tile-1`..`tile-4`), bring
them up as needed (`docker compose up -d tile-3`). To add `tile-5`, edit
`docker-compose.yml`, save, `up -d tile-5`. ~5 seconds.

**Later (automated):** `TileSpawner` interface in
`packages/gateway/src/edge/tile_orchestrator.ts`. Implementations:
- `NoopSpawner` — current; throws "not implemented".
- `DockerSocketSpawner` — gateway has Docker socket mounted, calls
  `docker run` for a tile container with a generated TILE_ID and an assigned
  port from a pool.
- `K8sSpawner` / `NomadSpawner` — for prod orchestration.

Switching to dynamic spawn is gated on a future ticket. Until then, slot-based
scaling is fine for solo dev.

### Production

Out of scope for this document. Gateway and coordinator each become a single
managed instance; tiles run on whatever orchestrator is chosen. Postgres
becomes a managed DB (RDS / Cloud SQL / similar). The architecture above does
not change — only the spawner implementation and the cert source.

---

## Service identification & secrets

- **`VOXIM_SERVICE_SECRET`** — shared between gateway, coordinator, and tiles.
  Used in `X-Voxim-Service-Secret` header and as the privileged-handshake key
  on tile↔gateway and coordinator↔gateway WT streams. Constant-time compared.
  Min 16 chars. Never logged.
- **Service handshake on WT stream:** first frame is JSON
  `{ kind: "tile" | "coordinator", id?: string, secret: string }`. Gateway
  validates, then the stream is a multiplexed event/command channel. Streams
  identified as `coordinator` are privileged to send commands to any tile.

---

## Failure modes

| Failure | Effect | Recovery |
|---------|--------|----------|
| Postgres down | Gateway can't auth new logins; tile saves stop persisting; coordinator can't read world map | Restart Postgres; existing connected players keep playing on cached state. Heartbeat-based registry decays naturally. |
| Gateway down | New logins blocked; existing client↔tile WT sessions keep playing (gateway is off the data path); cross-tile handoffs blocked; coordinator commands queued (or dropped — TBD). | Restart gateway; tiles reconnect their WT stream; coordinator reconnects. Sessions table persists, tokens still valid. |
| Coordinator down | Macro sim freezes; tiles keep running; players keep playing local-tile gameplay; cross-tile caravans stall | Restart; ECS state rebuilt from `world_map` + `cities`. |
| Tile down | Connected players disconnect; tile evicted from registry after 30s | Bring up replacement with same TILE_ID; loads from `tile_saves`. Players re-login → re-routed to revived tile. |
| AI Manager down | LLM-driven city decisions fall back to utility AI (T-047) | Restart anytime. |

---

## Out of scope (deferred)

- Multi-gateway (horizontal scaling of edge).
- Multi-coordinator (sharded macro sim).
- Per-tile world-map overrides (no use case yet).
- Durable event log replay (`world_events` table) — events are routed
  in-memory; if a subscriber misses, it's gone.
- Live tile migration (move a tile from host A to host B mid-game).

These are real concerns for later — none block the work in this document.

---

## See also

- [CLAUDE.md](CLAUDE.md) — per-package internals, ECS rules, content pipeline.
- [TICKETS.md](TICKETS.md) — phased work plan implementing this architecture.
