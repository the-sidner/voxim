/// <reference lib="dom" />
/**
 * Top-level studio app — two routes (voxel / anim) sharing a top bar.
 * Hash-based routing keeps it simple; no router dep needed.
 */
import { useEffect, useState } from "preact/hooks";
import { VoxelEditor } from "./voxel-editor/VoxelEditor.tsx";
import { AnimationEditor } from "./animation-editor/AnimationEditor.tsx";
import { MaterialEditor } from "./material-editor/MaterialEditor.tsx";

type Route = "voxel" | "anim" | "material";

function currentRoute(): Route {
  const h = (globalThis as { location?: Location }).location?.hash ?? "";
  if (h === "#anim") return "anim";
  if (h === "#material") return "material";
  return "voxel";
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute());

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    globalThis.addEventListener("hashchange", onHash);
    return () => globalThis.removeEventListener("hashchange", onHash);
  }, []);

  const go = (r: Route) => {
    location.hash = `#${r}`;
    setRoute(r);
  };

  return (
    <>
      <TopBar route={route} onPick={go} />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {route === "voxel" ? <VoxelEditor /> : route === "anim" ? <AnimationEditor /> : <MaterialEditor />}
      </div>
    </>
  );
}

function TopBar({ route, onPick }: { route: Route; onPick: (r: Route) => void }) {
  return (
    <div class="dt-topbar" style={{ minHeight: 40, alignItems: "center" }}>
      <span class="dt-brand">Voxim · Studio</span>
      <button
        class={`dt-tab ${route === "voxel" ? "is-active" : ""}`}
        onClick={() => onPick("voxel")}
      >Voxel</button>
      <button
        class={`dt-tab ${route === "anim" ? "is-active" : ""}`}
        onClick={() => onPick("anim")}
      >Animation</button>
      <button
        class={`dt-tab ${route === "material" ? "is-active" : ""}`}
        onClick={() => onPick("material")}
      >Material</button>
    </div>
  );
}
