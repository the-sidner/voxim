export interface TickLoopConfig {
  tickRateHz: number;
}

/**
 * Fixed-timestep tick loop.
 *
 * Runs at the configured Hz. Each tick invokes tickFn with the fixed dt (in seconds)
 * and the current tick counter. After tickFn returns, sleeps for the remaining
 * budget time (tickMs - elapsed). If a tick overruns its budget, the next tick
 * runs immediately — inputs continue accumulating in ring buffers during the overrun
 * and the game catches up naturally on the next drain.
 */
export class TickLoop {
  private running = false;
  private tick = 0;

  get currentTick(): number {
    return this.tick;
  }

  start(
    tickFn: (dt: number, tick: number) => void,
    config: TickLoopConfig,
  ): void {
    if (this.running) return;
    this.running = true;
    const dt = 1 / config.tickRateHz;
    const budgetMs = 1000 / config.tickRateHz;

    const loop = async () => {
      while (this.running) {
        const t0 = performance.now();
        try {
          tickFn(dt, this.tick++);
        } catch (err) {
          console.error("[TickLoop] error in tick", this.tick - 1, err);
        }
        const elapsed = performance.now() - t0;
        const sleep = Math.max(0, budgetMs - elapsed);
        await new Promise<void>((r) => setTimeout(r, sleep));
      }
    };

    loop().catch((err) => console.error("[TickLoop] loop crashed", err));
  }

  stop(): void {
    this.running = false;
  }
}
