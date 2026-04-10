/// <reference lib="dom" />
/**
 * Voxel editor entry point — bundled by scripts/build_voxel_editor.ts
 */
import { render } from "preact";
import { App } from "./app.tsx";
import { loadContentBrowser } from "./content_loader.ts";

(async () => {
  const root = document.getElementById("app");
  if (!root) throw new Error("No #app element");

  // Show loading state
  root.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-family:monospace">Loading content...</div>`;

  let content;
  try {
    content = await loadContentBrowser();
  } catch (err) {
    root.innerHTML = `<div style="color:#c66;padding:20px;font-family:monospace">Failed to load content: ${err}</div>`;
    return;
  }

  root.innerHTML = "";
  render(<App content={content} />, root);
})();
