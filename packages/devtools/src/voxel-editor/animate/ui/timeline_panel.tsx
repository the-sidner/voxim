/**
 * Timeline Panel — canvas-based animation timeline.
 *
 * Layout:
 *   Left column (LABEL_W px): bone names, vertically scrolled in sync.
 *   Right canvas: keyframe diamonds + scrub cursor, horizontally scrollable.
 *
 * Interactions:
 *   Click empty track area → set scrubTime to that normalized position.
 *   Click diamond          → select that keyframe.
 *   Drag diamond           → move keyframe time (moveKeyframeTime).
 *   Double-click track     → add keyframe at cursor position (addKeyframe).
 *   Drag scrub bar (top)   → set scrubTime.
 */
import { useRef, useEffect } from "preact/hooks";
import type { SkeletonDef, AnimationClip } from "@voxim/content";
import {
  editingSkeleton, editingClip, scrubTime, selectedBoneId, selectedKeyframeIdx,
  addKeyframe, moveKeyframeTime,
} from "../anim_state.ts";

const ROW_H    = 22;   // px per bone row
const LABEL_W  = 120;  // px for bone name column
const HEAD_H   = 20;   // px for scrub header
const DIAMOND  = 5;    // half-size of keyframe diamond
const PAD      = 8;    // horizontal padding each side

// ---- helpers ----

function drawTimeline(
  canvas: HTMLCanvasElement,
  sk: SkeletonDef,
  clip: AnimationClip | null,
  scrub: number,
  selBoneId: string | null,
  selKfIdx: number | null,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const bones = sk.bones;
  const trackW = W - PAD * 2;

  ctx.clearRect(0, 0, W, H);

  // Canvas palette — Dreamborn equivalents (these are baked here because
  // canvas API doesn't read CSS custom properties).
  const COL_MOSS     = "#13120b";
  const COL_MOSS_HI  = "#191811";
  const COL_MOSS_HOV = "#1e1d15";
  const COL_LINE     = "#1c1c14";
  const COL_BONE_F   = "#645f4d";
  const COL_BONE_D   = "#a39d80";
  const COL_EMBER    = "#d97826";
  const COL_EMBER_HI = "#ee9748";
  const COL_AETHER_D = "#5d7682";

  // Scrub header background
  ctx.fillStyle = COL_MOSS;
  ctx.fillRect(0, 0, W, HEAD_H);

  // Time ticks (0%, 25%, 50%, 75%, 100%)
  for (let i = 0; i <= 4; i++) {
    const x = PAD + (i / 4) * trackW;
    ctx.fillStyle = COL_BONE_F;
    ctx.fillRect(x, 0, 1, HEAD_H);
    ctx.fillStyle = COL_BONE_D;
    ctx.font = "9px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${i * 25}%`, x, HEAD_H - 3);
  }

  // Bone rows
  for (let ri = 0; ri < bones.length; ri++) {
    const bone = bones[ri];
    const y = HEAD_H + ri * ROW_H;
    const isSel = bone.id === selBoneId;

    // Row background
    ctx.fillStyle = isSel ? COL_MOSS_HOV : (ri % 2 === 0 ? COL_MOSS_HI : COL_MOSS);
    ctx.fillRect(0, y, W, ROW_H);

    // Row separator
    ctx.fillStyle = COL_LINE;
    ctx.fillRect(0, y + ROW_H - 1, W, 1);

    // Track line
    ctx.fillStyle = COL_LINE;
    ctx.fillRect(PAD, y + ROW_H / 2 - 0.5, trackW, 1);

    // Keyframes
    const track = clip?.tracks[bone.id];
    if (track) {
      for (let ki = 0; ki < track.length; ki++) {
        const kf = track[ki];
        const kx = PAD + kf.time * trackW;
        const ky = y + ROW_H / 2;
        const isKfSel = isSel && ki === selKfIdx;

        ctx.save();
        ctx.translate(kx, ky);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = isKfSel ? COL_EMBER : (isSel ? COL_EMBER_HI : COL_AETHER_D);
        ctx.strokeStyle = isKfSel ? COL_EMBER_HI : COL_MOSS;
        ctx.lineWidth = 1;
        ctx.fillRect(-DIAMOND, -DIAMOND, DIAMOND * 2, DIAMOND * 2);
        ctx.strokeRect(-DIAMOND, -DIAMOND, DIAMOND * 2, DIAMOND * 2);
        ctx.restore();
      }
    }
  }

  // Scrub cursor (drawn last, on top)
  const sx = PAD + scrub * trackW;
  ctx.fillStyle = COL_EMBER;
  ctx.fillRect(sx - 1, 0, 2, H);

  // Scrub head triangle
  ctx.fillStyle = COL_EMBER_HI;
  ctx.beginPath();
  ctx.moveTo(sx, HEAD_H);
  ctx.lineTo(sx - 6, 2);
  ctx.lineTo(sx + 6, 2);
  ctx.closePath();
  ctx.fill();
}

// ---- coordinate helpers ----

function xToTime(x: number, canvasW: number): number {
  return Math.max(0, Math.min(1, (x - PAD) / (canvasW - PAD * 2)));
}

function hitKfAt(
  x: number,
  y: number,
  sk: SkeletonDef,
  clip: AnimationClip | null,
  canvasW: number,
): { boneId: string; kfIdx: number } | null {
  if (!clip) return null;
  const trackW = canvasW - PAD * 2;
  for (let ri = 0; ri < sk.bones.length; ri++) {
    const rowY = HEAD_H + ri * ROW_H + ROW_H / 2;
    if (Math.abs(y - rowY) > ROW_H / 2) continue;
    const bone = sk.bones[ri];
    const track = clip.tracks[bone.id];
    if (!track) continue;
    for (let ki = 0; ki < track.length; ki++) {
      const kx = PAD + track[ki].time * trackW;
      if (Math.abs(x - kx) <= DIAMOND + 3) {
        return { boneId: bone.id, kfIdx: ki };
      }
    }
  }
  return null;
}

function rowAt(y: number, sk: SkeletonDef): string | null {
  const ri = Math.floor((y - HEAD_H) / ROW_H);
  if (ri < 0 || ri >= sk.bones.length) return null;
  return sk.bones[ri].id;
}

// ---- component ----

export function TimelinePanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragKf = useRef<{ boneId: string; kfIdx: number } | null>(null);
  const draggingScrub = useRef(false);

  const sk = editingSkeleton.value;
  const clip = editingClip.value;
  const scrub = scrubTime.value;
  const selBoneId = selectedBoneId.value;
  const selKfIdx = selectedKeyframeIdx.value;

  const bones = sk?.bones ?? [];
  const canvasH = HEAD_H + bones.length * ROW_H;

  // Redraw whenever state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sk) return;
    drawTimeline(canvas, sk, clip, scrub, selBoneId, selKfIdx);
  }, [sk, clip, scrub, selBoneId, selKfIdx]);

  if (!sk) return (
    <div class="dt-section flavour">
      No skeleton loaded.
    </div>
  );
  // Non-null after guard — captured by closures below
  const skDef: SkeletonDef = sk;

  function getPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: PointerEvent) {
    const canvas = canvasRef.current!;
    const { x, y } = getPos(e);

    // Click in header → drag scrub
    if (y < HEAD_H) {
      draggingScrub.current = true;
      scrubTime.value = xToTime(x, canvas.width);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // Hit a keyframe diamond?
    const hit = hitKfAt(x, y, skDef, clip, canvas.width);
    if (hit) {
      dragKf.current = hit;
      selectedBoneId.value = hit.boneId;
      selectedKeyframeIdx.value = hit.kfIdx;
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // Click empty track row → set scrub + select bone
    const boneId = rowAt(y, skDef);
    if (boneId) {
      scrubTime.value = xToTime(x, canvas.width);
      selectedBoneId.value = boneId;
      selectedKeyframeIdx.value = null;
    }
  }

  function onPointerMove(e: PointerEvent) {
    const canvas = canvasRef.current!;
    const { x } = getPos(e);

    if (draggingScrub.current) {
      scrubTime.value = xToTime(x, canvas.width);
      return;
    }
    if (dragKf.current) {
      moveKeyframeTime(dragKf.current.boneId, dragKf.current.kfIdx, xToTime(x, canvas.width));
      // Update dragKf.kfIdx in case sort moved it
      const clip2 = editingClip.value;
      if (clip2) {
        const track = clip2.tracks[dragKf.current.boneId];
        if (track) dragKf.current.kfIdx = selectedKeyframeIdx.value ?? 0;
      }
    }
  }

  function onPointerUp(e: PointerEvent) {
    canvasRef.current?.releasePointerCapture(e.pointerId);
    draggingScrub.current = false;
    dragKf.current = null;
  }

  function onDblClick(e: MouseEvent) {
    const canvas = canvasRef.current!;
    const { x, y } = getPos(e);
    const boneId = rowAt(y, skDef);
    if (boneId) {
      addKeyframe(boneId, xToTime(x, canvas.width));
    }
  }

  return (
    <div style={{ background: "var(--moss)", overflow: "auto" }}>
      <div class="dt-pane-header" style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
        <span>Timeline</span>
        <span class="text-dim" style={{ fontSize: 10, textTransform: "none", letterSpacing: 0 }}>
          {clip ? `${clip.id} · ${Object.keys(clip.tracks).length} tracks` : "No clip selected"}
        </span>
        <span class="text-dim" style={{ fontSize: 10, marginLeft: "auto", textTransform: "none", letterSpacing: 0 }}>
          dbl-click to add keyframe
        </span>
      </div>
      <div style={{ display: "flex", overflow: "auto" }}>
        {/* Bone name column */}
        <div style={{
          width: LABEL_W, flexShrink: 0,
          background: "var(--moss)",
          borderRight: "1px solid var(--line)",
          paddingTop: HEAD_H,
        }}>
          {bones.map((bone, ri) => {
            const isSel = bone.id === selBoneId;
            const hasKeys = !!(clip?.tracks[bone.id]?.length);
            return (
              <div
                key={bone.id}
                onClick={() => { selectedBoneId.value = bone.id; selectedKeyframeIdx.value = null; }}
                style={{
                  height: ROW_H, display: "flex", alignItems: "center",
                  padding: "0 var(--s-3)", fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  background: isSel ? "var(--moss-hov)" : (ri % 2 === 0 ? "var(--moss-hi)" : "var(--moss)"),
                  color: hasKeys
                    ? (isSel ? "var(--ember-hi)" : "var(--bone-dim)")
                    : (isSel ? "var(--aether-dim)" : "var(--bone-ghost)"),
                  borderBottom: "1px solid var(--line)",
                  boxSizing: "border-box",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                {bone.id}
              </div>
            );
          })}
        </div>

        {/* Canvas */}
        <canvas
          ref={canvasRef}
          width={600}
          height={canvasH}
          style={{ display: "block", cursor: "crosshair", imageRendering: "pixelated" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDblClick={onDblClick}
        />
      </div>
    </div>
  );
}
