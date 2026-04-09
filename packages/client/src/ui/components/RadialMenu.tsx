/// <reference lib="dom" />
/**
 * RadialMenu — circular blueprint selector shown on long RMB press.
 *
 * Renders up to 6 wedge sectors arranged around the press point.
 * The currently selected type is highlighted. Clicking a sector fires
 * select_blueprint and closes the menu. Clicking outside closes without
 * changing selection.
 */
import { useEffect, useRef } from "preact/hooks";
import { computed } from "@preact/signals";
import { uiState, patchUI } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";

const STRUCTURE_OPTIONS: { id: string; label: string }[] = [
  { id: "wood_wall",  label: "Wood Wall"  },
  { id: "wood_door",  label: "Doorway"    },
  { id: "wood_floor", label: "Floor"      },
  { id: "stone_wall", label: "Stone Wall" },
  { id: "dirt_ramp",  label: "Ramp"       },
];

const RADIUS = 72;  // distance from centre to sector midpoint (px)
const ITEM_SIZE = 56; // sector clickable box size (px)

const radialMenu = computed(() => uiState.value.radialMenu);
const selected   = computed(() => uiState.value.selectedBlueprint);

export function RadialMenu({ onAction }: { onAction: (a: UIAction) => void }) {
  const menu = radialMenu.value;
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") patchUI({ radialMenu: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  if (!menu) return null;

  const count = STRUCTURE_OPTIONS.length;

  const close = () => patchUI({ radialMenu: null });

  const pick = (id: string) => {
    onAction({ type: "select_blueprint", structureType: id });
    close();
  };

  return (
    <div
      ref={backdropRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
      }}
      onMouseDown={(e) => {
        // Close if clicking the backdrop (not a child sector)
        if (e.target === backdropRef.current) close();
      }}
    >
      {STRUCTURE_OPTIONS.map((opt, i) => {
        const angle = (2 * Math.PI * i) / count - Math.PI / 2;
        const cx = menu.x + Math.cos(angle) * RADIUS;
        const cy = menu.y + Math.sin(angle) * RADIUS;
        const isActive = selected.value === opt.id;

        return (
          <div
            key={opt.id}
            onMouseDown={(e) => { e.stopPropagation(); pick(opt.id); }}
            style={{
              position:     "fixed",
              left:         cx - ITEM_SIZE / 2,
              top:          cy - ITEM_SIZE / 2,
              width:        ITEM_SIZE,
              height:       ITEM_SIZE,
              display:      "flex",
              alignItems:   "center",
              justifyContent: "center",
              textAlign:    "center",
              background:   isActive ? "rgba(180,140,60,0.92)" : "rgba(30,25,20,0.88)",
              border:       isActive ? "2px solid #e8c860" : "2px solid rgba(200,180,120,0.4)",
              borderRadius: "8px",
              cursor:       "pointer",
              color:        isActive ? "#fff" : "#ccc",
              fontSize:     "11px",
              fontFamily:   "sans-serif",
              lineHeight:   "1.2",
              padding:      "4px",
              userSelect:   "none",
              boxShadow:    isActive ? "0 0 8px rgba(232,200,96,0.5)" : "0 2px 6px rgba(0,0,0,0.5)",
            }}
          >
            {opt.label}
          </div>
        );
      })}

      {/* Centre dot showing the press origin */}
      <div style={{
        position:     "fixed",
        left:         menu.x - 6,
        top:          menu.y - 6,
        width:        12,
        height:       12,
        borderRadius: "50%",
        background:   "rgba(232,200,96,0.8)",
        pointerEvents: "none",
      }} />
    </div>
  );
}
