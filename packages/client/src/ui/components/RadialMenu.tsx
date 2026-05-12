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
 *
 * Visuals: pressed-metal sectors arranged on a 80-px circle. Hover lifts the
 * border to ember and adds an ember-glow ring. No rounded corners.
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

const RADIUS    = 84;
const ITEM_SIZE = 64;

const radialMenu = computed(() => uiState.value.radialMenu);

export function RadialMenu({ onAction }: { onAction: (a: UIAction) => void }) {
  const menu = radialMenu.value;
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const hoveredRef = useRef<string | null>(null);
  hoveredRef.current = hoveredId;

  useEffect(() => {
    if (!menu) return;
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

    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!menu) return null;

  const count = STRUCTURE_OPTIONS.length;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-modal)", pointerEvents: "none" }}>
      {STRUCTURE_OPTIONS.map((opt, i) => {
        const angle = (2 * Math.PI * i) / count - Math.PI / 2;
        const cx    = menu.x + Math.cos(angle) * RADIUS;
        const cy    = menu.y + Math.sin(angle) * RADIUS;
        const on    = hoveredId === opt.id;

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
              background:     on
                ? "linear-gradient(180deg, var(--ember-warm), var(--ember-deep))"
                : "linear-gradient(180deg, var(--moss-hov), var(--moss))",
              border:         `1px solid ${on ? "var(--ember)" : "var(--line-strong)"}`,
              boxShadow: on
                ? "var(--inset-raise), 0 0 18px var(--ember-glow)"
                : "var(--inset-raise), 0 4px 12px rgba(0,0,0,0.5)",
              color:          on ? "var(--bone-hi)" : "var(--bone)",
              fontFamily:     "var(--font-body)",
              fontSize:       "var(--fs-small)",
              lineHeight:     1.25,
              padding:        "var(--s-1)",
              userSelect:     "none",
              transition:     "background 80ms var(--ease-grim), border-color 80ms var(--ease-grim), color 80ms var(--ease-grim), box-shadow 80ms var(--ease-grim)",
            }}
          >
            {opt.label}
          </div>
        );
      })}

      {/* Centre — single ember pixel inside a hairline ring */}
      <div style={{
        position: "fixed",
        left:     menu.x - 4,
        top:      menu.y - 4,
        width:    8,
        height:   8,
        border:   "1px solid var(--bone-faint)",
        pointerEvents: "none",
      }}>
        <div style={{
          position: "absolute", left: "50%", top: "50%",
          width: 2, height: 2,
          marginLeft: -1, marginTop: -1,
          background: "var(--ember)",
        }} />
      </div>
    </div>
  );
}
