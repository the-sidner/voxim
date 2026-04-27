/**
 * IntentRouter — registry of priority-ordered handlers; the first that
 * claims an intent wins.
 *
 * The router has no game knowledge. It just dispatches; handlers do the
 * work. `register()` returns an unregister fn for clean teardown.
 *
 * Claim semantics: a handler returns `true` to consume the intent (stops
 * propagation), `false` to pass. UI handlers register at high priority and
 * usually claim ui-* intents; world handlers register at lower priority and
 * claim world-* intents. Intents with no claimer are silently dropped.
 */
import type { Intent } from "./intents.ts";

export interface IntentHandler {
  /** Stable id — useful for unregistering, logs, debugging. */
  id: string;
  /** Higher numbers run first. */
  priority: number;
  /** Return true to consume the intent and stop propagation. */
  claim(intent: Intent): boolean;
}

export class IntentRouter {
  private handlers: IntentHandler[] = [];

  register(handler: IntentHandler): () => void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => b.priority - a.priority);
    return () => this.unregister(handler.id);
  }

  unregister(id: string): void {
    this.handlers = this.handlers.filter((h) => h.id !== id);
  }

  /**
   * Dispatch an intent through the chain. Returns the id of the handler that
   * claimed it, or null when nothing claimed.
   */
  dispatch(intent: Intent): string | null {
    for (const h of this.handlers) {
      if (h.claim(intent)) return h.id;
    }
    return null;
  }
}
