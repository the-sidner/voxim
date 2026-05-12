/// <reference lib="dom" />
/**
 * Top-level studio app — two routes (voxel / anim) sharing a top bar.
 * Hash-based routing keeps it simple; no router dep needed.
 */
import { useEffect, useState } from "preact/hooks";
import { VoxelEditor } from "./voxel-editor/VoxelEditor.tsx";
import { AnimationEditor } from "./animation-editor/AnimationEditor.tsx";

type Route = "voxel" | "anim";

function currentRoute(): Route {
  const h = (globalThis as { location?: Location }).location?.hash ?? "";
  return h === "#anim" ? "anim" : "voxel";
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
        {route === "voxel" ? <VoxelEditor /> : <AnimationEditor />}
      </div>
    </>
  );
}

function TopBar({ route, onPick }: { route: Route; onPick: (r: Route) => void }) {
  return (
    <div style={{
      flex: "0 0 40px",
      display: "flex",
      alignItems: "center",
      padding: "0 14px",
      gap: 14,
      borderBottom: "1px solid #2a2a30",
      background: "#101013",
    }}>
      <div style={{ fontWeight: 600, color: "#dcdce4", marginRight: 12 }}>Voxim Studio</div>
      <TabButton active={route === "voxel"} onClick={() => onPick("voxel")}>Voxel</TabButton>
      <TabButton active={route === "anim"}  onClick={() => onPick("anim")}>Animation</TabButton>
    </div>
  );
}

function TabButton({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: preact.ComponentChildren;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        cursor: "pointer",
        padding: "6px 12px",
        borderRadius: 4,
        background: active ? "#2a3a55" : "transparent",
        color: active ? "#fff" : "#aaa",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}
