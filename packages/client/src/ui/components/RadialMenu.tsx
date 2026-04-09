/// <reference lib="dom" />
/**
 * RadialMenu — blueprint selector driven by hold-hover-release.
 *
 * Appears while RMB is held (≥ 300 ms). Moving over a sector highlights it.
 * Releasing RMB commits the hovered sector (or cancels if none hovered).
 * No click is required.
 *
 * Interaction model:
 *   1. InputController fires onBuildOpenMenu after 300 ms hold → patchUI({ radialMenu })
 *   2. This component renders; global mouseup listener waits for RMB release
 *   3. On release: if hoveredId is set → select_blueprint + close, else just close
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { computed } from "@preact/signals";
import { uiState, patchUI } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";

const STRUCTURE_OPTIONS: { id: string; label: string }[] = [
  { id: "wood_wall",  label: "Wood\nWall"  },
  { id: "wood_door",  label: "Door\nway"   },
  { id: "wood_floor", label: "Floor"       },
  { id: "stone_wall", label: "Stone\nWall" },
  { id: "dirt_ramp",  label: "Ramp"        },
];

const RADIUS    = 80;   // px from centre to sector midpoint
const ITEM_SIZE = 60;   // px — bounding box of each sector label

const radialMenu = computed(() => uiState.value.radialMenu);

export function RadialMenu({ onAction }: { onAction: (a: UIAction) => void }) {
  const menu = radialMenu.value;
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Keep a ref so the mouseup closure always reads the latest hovered item
  // without needing to re-register the listener on every hover change.
  const hoveredRef = useRef<string | null>(null);
  hoveredRef.current = hoveredId;

  useEffect(() => {
    if (!menu) return;
    // Reset hover each time the menu opens
    setHoveredId(null);
    hoveredRef.current = null;

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const id = hoveredRef.current;
      if (id) {
        console.log(`[Build] radial select type=${id}`);
        onAction({ type: "select_blueprint", structureType: id });
      }
      patchUI({ radialMenu: null });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") patchUI({ radialMenu: null });
    };

    window.addEventListener("mouseup",  onMouseUp);
    window.addEventListener("keydown",  onKey);
    return () => {
      window.removeEventListener("mouseup",  onMouseUp);
      window.removeEventListener("keydown",  onKey);
    };
  }, [menu]);  // only re-register when menu opens/closes

  if (!menu) return null;

  const count = STRUCTURE_OPTIONS.length;

  return (
    // Backdrop: pointer-events none so canvas still receives mousemove for facing.
    // Only the sector divs have pointer-events.
    <div style={{ position: "fixed", inset: 0, zIndex: 300, pointerEvents: "none" }}>

      {STRUCTURE_OPTIONS.map((opt, i) => {
        const angle = (2 * Math.PI * i) / count - Math.PI / 2;
        const cx    = menu.x + Math.cos(angle) * RADIUS;
        const cy    = menu.y + Math.sin(angle) * RADIUS;
        const isHovered = hoveredId === opt.id;

        return (
          <div
            key={opt.id}
            onMouseEnter={() => setHoveredId(opt.id)}
            onMouseLeave={() => setHoveredId((prev) => prev === opt.id ? null : prev)}
            style={{
              position:       "fixed",
              left:           cx - ITEM_SIZE / 2,
              top:            cy - ITEM_SIZE / 2,
              width:          ITEM_SIZE,
              height:         ITEM_SIZE,
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
              textAlign:      "center",
              whiteSpace:     "pre-line",
              pointerEvents:  "all",
              background:     isHovered ? "rgba(180,140,60,0.95)" : "rgba(30,25,20,0.88)",
              border:         isHovered ? "2px solid #e8c860" : "2px solid rgba(200,180,120,0.35)",
              borderRadius:   "8px",
              color:          isHovered ? "#fff" : "#bbb",
              fontSize:       "11px",
              fontFamily:     "sans-serif",
              lineHeight:     "1.3",
              padding:        "4px",
              userSelect:     "none",
              transition:     "background 80ms, border-color 80ms, color 80ms",
              boxShadow:      isHovered ? "0 0 10px rgba(232,200,96,0.55)" : "0 2px 6px rgba(0,0,0,0.5)",
            }}
          >
            {opt.label}
          </div>
        );
      })}

      {/* Centre dot */}
      <div style={{
        position:      "fixed",
        left:          menu.x - 5,
        top:           menu.y - 5,
        width:         10,
        height:        10,
        borderRadius:  "50%",
        background:    "rgba(232,200,96,0.85)",
        pointerEvents: "none",
      }} />
    </div>
  );
}
