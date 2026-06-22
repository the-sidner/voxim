/// <reference lib="dom" />
/**
 * InputCapture — single source of truth for raw browser events.
 *
 * Listens at `document` so it sees every event regardless of target. Knows
 * nothing about game semantics, modes, or charge timing. Emits typed
 * RawEvents to a sink, which the IntentTranslator consumes.
 *
 * Why document and not canvas: T-130 needs to know whether a click hit a
 * UI overlay or the world. Canvas-only listeners would never see UI clicks
 * at all, leaving the consume rule implicit. Document listening lets the
 * translator inspect event.target and decide explicitly.
 */

interface MouseEventBase {
  button: number;             // 0 LMB, 2 RMB
  canvasX: number;            // canvas-relative
  canvasY: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
  t: number;                  // performance.now() at event time
}

interface MouseMoveEvent {
  kind: "mouse-move";
  canvasX: number;
  canvasY: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
  t: number;
}

interface KeyEventBase {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  target: EventTarget | null;
  t: number;
}

export type RawEvent =
  | ({ kind: "mouse-down" } & MouseEventBase)
  | ({ kind: "mouse-up"   } & MouseEventBase)
  | MouseMoveEvent
  | ({ kind: "key-down" } & KeyEventBase)
  | ({ kind: "key-up"   } & KeyEventBase);

export type RawEventSink = (e: RawEvent) => void;

export class InputCapture {
  private readonly _onMouseDown: (e: MouseEvent) => void;
  private readonly _onMouseUp:   (e: MouseEvent) => void;
  private readonly _onMouseMove: (e: MouseEvent) => void;
  private readonly _onKeyDown:   (e: KeyboardEvent) => void;
  private readonly _onKeyUp:     (e: KeyboardEvent) => void;
  private readonly _onContext:   (e: Event) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sink: RawEventSink,
    // Policy deciding which key events to swallow from the browser
    // (preventDefault) so game keys don't trigger the page's own defaults —
    // Space/arrows scrolling, Tab stealing focus, '/' quick-find, etc. Kept as
    // an injected predicate so InputCapture stays game-agnostic; the caller owns
    // the game-key set and the "don't hijack a focused text field" rule.
    private readonly preventDefaultFor?: (e: KeyboardEvent) => boolean,
  ) {
    const canvasPos = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { canvasX: e.clientX - r.left, canvasY: e.clientY - r.top };
    };

    this._onMouseDown = (e) => sink({
      kind: "mouse-down", button: e.button, ...canvasPos(e),
      clientX: e.clientX, clientY: e.clientY, target: e.target, t: performance.now(),
    });
    this._onMouseUp = (e) => sink({
      kind: "mouse-up", button: e.button, ...canvasPos(e),
      clientX: e.clientX, clientY: e.clientY, target: e.target, t: performance.now(),
    });
    this._onMouseMove = (e) => sink({
      kind: "mouse-move", ...canvasPos(e),
      clientX: e.clientX, clientY: e.clientY, target: e.target, t: performance.now(),
    });
    this._onKeyDown = (e) => {
      if (this.preventDefaultFor?.(e)) e.preventDefault();
      sink({
        kind: "key-down", code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
        target: e.target, t: performance.now(),
      });
    };
    this._onKeyUp = (e) => {
      if (this.preventDefaultFor?.(e)) e.preventDefault();
      sink({
        kind: "key-up", code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
        target: e.target, t: performance.now(),
      });
    };
    this._onContext = (e) => e.preventDefault();

    document.addEventListener("mousedown",   this._onMouseDown);
    document.addEventListener("mouseup",     this._onMouseUp);
    document.addEventListener("mousemove",   this._onMouseMove);
    document.addEventListener("keydown",     this._onKeyDown);
    document.addEventListener("keyup",       this._onKeyUp);
    canvas.addEventListener("contextmenu",   this._onContext);
  }

  dispose(): void {
    document.removeEventListener("mousedown",   this._onMouseDown);
    document.removeEventListener("mouseup",     this._onMouseUp);
    document.removeEventListener("mousemove",   this._onMouseMove);
    document.removeEventListener("keydown",     this._onKeyDown);
    document.removeEventListener("keyup",       this._onKeyUp);
    this.canvas.removeEventListener("contextmenu", this._onContext);
  }
}

/**
 * True when the event's target is inside the `#ui` div AND on a node that
 * opted into pointer events (`.interactive` class). Used by the translator
 * to suppress world intents when a click was actually consumed by UI.
 *
 * Mirrors the existing CSS rule (#ui has pointer-events:none; .interactive
 * children opt back in). Making it explicit here means the canvas doesn't
 * need to pretend the event never happened.
 */
export function targetIsInteractiveUI(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const ui = document.getElementById("ui");
  if (!ui || !ui.contains(target)) return false;
  return target.closest(".interactive") !== null;
}
