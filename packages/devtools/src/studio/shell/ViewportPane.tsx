/// <reference lib="dom" />
/**
 * Preact wrapper around the imperative Viewport. Mounts on render,
 * hands the live viewport instance back via the `onReady` callback so
 * the consuming editor can attach its scene content.
 *
 * Stateless from Preact's POV — Three.js owns the render loop.
 */
import { useEffect, useRef } from "preact/hooks";
import { createViewport, type Viewport } from "./viewport.ts";

export function ViewportPane({ onReady }: { onReady: (vp: Viewport) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const vpRef   = useRef<Viewport | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const vp = createViewport();
    vp.attach(hostRef.current);
    vpRef.current = vp;
    onReady(vp);
    return () => {
      vp.dispose();
      vpRef.current = null;
    };
  }, []);

  return (
    <div
      ref={hostRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        background: "var(--peat-solid)",
        overflow: "hidden",
      }}
    />
  );
}
