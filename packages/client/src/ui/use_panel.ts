/// <reference lib="dom" />
/**
 * usePanel — draggable floating window behaviour.
 *
 * Returns { panelProps, titleProps } to spread onto the panel container and
 * its title bar respectively.  Drag starts on mousedown on the title bar,
 * moves the panel by updating inline style, ends on mouseup anywhere.
 *
 * Usage:
 *   const { panelProps, titleProps } = usePanel({ defaultX: 100, defaultY: 80 });
 *   return <div class="panel" {...panelProps}><div class="panel__title" {...titleProps}>Title</div>…</div>
 */
import { useRef, useEffect } from "preact/hooks";

interface PanelOptions {
  defaultX?: number;
  defaultY?: number;
}

export function usePanel({ defaultX = 120, defaultY = 80 }: PanelOptions = {}) {
  const panelRef  = useRef<HTMLDivElement>(null);
  const dragging  = useRef(false);
  const origin    = useRef({ mx: 0, my: 0, px: defaultX, py: defaultY });
  const pos       = useRef({ x: defaultX, y: defaultY });

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    el.style.left = pos.current.x + "px";
    el.style.top  = pos.current.y + "px";
  }, []);

  function onMouseDown(e: MouseEvent) {
    // Only start drag on the title bar itself, not child buttons
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dragging.current = true;
    origin.current = { mx: e.clientX, my: e.clientY, px: pos.current.x, py: pos.current.y };

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - origin.current.mx;
      const dy = ev.clientY - origin.current.my;
      pos.current.x = origin.current.px + dx;
      pos.current.y = origin.current.py + dy;
      const el = panelRef.current;
      if (el) { el.style.left = pos.current.x + "px"; el.style.top = pos.current.y + "px"; }
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }

  const panelProps = {
    ref: panelRef,
    style: {
      position: "fixed" as const,
      left: defaultX + "px",
      top:  defaultY + "px",
      zIndex: "var(--z-panel)",
    },
  };

  const titleProps = {
    onMouseDown,
    style: { cursor: "grab" as const },
  };

  return { panelProps, titleProps };
}
