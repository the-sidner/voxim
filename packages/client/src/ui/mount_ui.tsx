/// <reference lib="dom" />
import { render } from "preact";
import { UIManager } from "./ui_manager.tsx";
import type { UIAction } from "./ui_actions.ts";

/**
 * Mount the Preact UI tree into <div id="ui">.
 * Called once from game.ts after the canvas and connection are ready.
 */
export function mountUI(onAction: (a: UIAction) => void): void {
  const root = document.getElementById("ui");
  if (!root) {
    console.warn("[UI] No #ui element found — UI will not render.");
    return;
  }
  render(<UIManager onAction={onAction} />, root);
}
