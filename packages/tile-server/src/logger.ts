/**
 * Structured logger for the tile server.
 *
 * Usage:
 *   const log = createLogger("CombatSystem");
 *   log.info("entity %s dealt %f damage to %s", sourceId, amount, targetId);
 *
 * Configuration via environment variables (requires --allow-env):
 *   VOXIM_LOG_LEVEL    — minimum level: "debug" | "info" | "warn" | "error" | "silent"
 *                        default: "info"
 *   VOXIM_LOG_CHANNELS — comma-separated allowlist of channel names.
 *                        omit to enable all channels.
 *                        e.g. "CombatSystem,NpcAiSystem"
 *
 * Programmatic control:
 *   import { setLogLevel, setLogChannels } from "./logger.ts";
 *   setLogLevel("debug");
 *   setLogChannels(["CombatSystem"]); // null to re-enable all
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

let minLevel: LogLevel = "info";
let channelFilter: Set<string> | null = null;

// Read initial config from environment (best-effort; silently ignored if env unavailable)
try {
  const envLevel = Deno.env.get("VOXIM_LOG_LEVEL");
  if (envLevel && envLevel in LEVEL_RANK) minLevel = envLevel as LogLevel;

  const envChannels = Deno.env.get("VOXIM_LOG_CHANNELS");
  if (envChannels) {
    channelFilter = new Set(envChannels.split(",").map((c) => c.trim()).filter(Boolean));
  }

} catch {
  // --allow-env not granted; use defaults
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** Pass null to re-enable all channels. */
export function setLogChannels(channels: string[] | null): void {
  channelFilter = channels ? new Set(channels) : null;
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ── Rotating file writer ──────────────────────────────────────────────────────

const FILE_DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const FILE_DEFAULT_MAX_FILES = 5;

class RotatingFileWriter {
  private file: Deno.FsFile | null = null;
  private currentBytes = 0;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {}

  open(): void {
    const dir = this.path.replace(/[/\\][^/\\]+$/, "");
    if (dir && dir !== this.path) {
      try { Deno.mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    }
    try {
      this.file = Deno.openSync(this.path, { write: true, append: true, create: true });
      this.currentBytes = this.file.statSync().size;
    } catch {
      this.file = null;
      this.currentBytes = 0;
    }
  }

  write(line: string): void {
    if (!this.file) return;
    const bytes = new TextEncoder().encode(line + "\n");
    if (this.currentBytes + bytes.byteLength > this.maxBytes) this.rotate();
    if (!this.file) return;
    try {
      this.file.writeSync(bytes);
      this.currentBytes += bytes.byteLength;
    } catch { /* best-effort */ }
  }

  private rotate(): void {
    try { this.file?.close(); } catch { /* ok */ }
    this.file = null;
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? this.path : `${this.path}.${i - 1}`;
      const dst = `${this.path}.${i}`;
      try { Deno.renameSync(src, dst); } catch { /* ok */ }
    }
    try {
      this.file = Deno.openSync(this.path, { write: true, create: true, truncate: true });
      this.currentBytes = 0;
    } catch { /* disable file logging */ }
  }

  close(): void {
    try { this.file?.close(); } catch { /* ok */ }
    this.file = null;
  }
}

let fileWriter: RotatingFileWriter | null = null;

/**
 * Enable rotating file logging. Safe to call multiple times (re-opens).
 *
 * Can also be configured via env vars before the first `createLogger()` call:
 *   VOXIM_LOG_FILE       — path to log file  (e.g. "./logs/tile.log")
 *   VOXIM_LOG_MAX_BYTES  — rotate threshold in bytes  (default: 5242880 = 5 MB)
 *   VOXIM_LOG_MAX_FILES  — number of rotated files to keep  (default: 5)
 */
export function openLogFile(
  path: string,
  opts?: { maxBytes?: number; maxFiles?: number },
): void {
  fileWriter?.close();
  fileWriter = new RotatingFileWriter(
    path,
    opts?.maxBytes ?? FILE_DEFAULT_MAX_BYTES,
    opts?.maxFiles ?? FILE_DEFAULT_MAX_FILES,
  );
  fileWriter.open();
}

// Init file logging from env (must run after openLogFile is declared)
try {
  const envFile = Deno.env.get("VOXIM_LOG_FILE");
  if (envFile) {
    const maxBytes = parseInt(Deno.env.get("VOXIM_LOG_MAX_BYTES") ?? "0") || FILE_DEFAULT_MAX_BYTES;
    const maxFiles = parseInt(Deno.env.get("VOXIM_LOG_MAX_FILES") ?? "0") || FILE_DEFAULT_MAX_FILES;
    openLogFile(envFile, { maxBytes, maxFiles });
  }
} catch { /* --allow-env not granted or --allow-write missing */ }

// ── printf-style formatter ────────────────────────────────────────────────────

/** Minimal printf-style formatter. Supports %s, %d, %i, %f, %.Nf. */
function sprintfArgs(msg: string, args: unknown[]): string {
  let i = 0;
  return msg.replace(/%(\.\d+)?([sdifeE%])/g, (_m, prec: string | undefined, spec: string) => {
    if (spec === "%") return "%";
    if (i >= args.length) return _m;
    const val = args[i++];
    switch (spec) {
      case "s": return String(val);
      case "d":
      case "i": return String(Math.trunc(Number(val)));
      case "f":
      case "e":
      case "E": {
        const n = Number(val);
        const precision = prec ? parseInt(prec.slice(1)) : 6;
        return spec === "f" ? n.toFixed(precision) : n.toExponential(precision);
      }
      default: return String(val);
    }
  });
}

export function createLogger(channel: string): Logger {
  function emit(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    if (channelFilter !== null && !channelFilter.has(channel)) return;

    // HH:MM:SS.mmm — compact timestamp without the date
    const ts = new Date().toISOString().slice(11, 23);
    const formatted = args.length > 0 ? sprintfArgs(msg, args) : msg;
    const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${channel}] ${formatted}`;

    fileWriter?.write(line);

    if (level === "warn") {
      console.warn(line);
    } else if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, ...args) => emit("debug", msg, args),
    info: (msg, ...args) => emit("info", msg, args),
    warn: (msg, ...args) => emit("warn", msg, args),
    error: (msg, ...args) => emit("error", msg, args),
  };
}
