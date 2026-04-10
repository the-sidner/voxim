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

  // Scrub header background
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, W, HEAD_H);

  // Time ticks (0%, 25%, 50%, 75%, 100%)
  for (let i = 0; i <= 4; i++) {
    const x = PAD + (i / 4) * trackW;
    ctx.fillStyle = "#555";
    ctx.fillRect(x, 0, 1, HEAD_H);
    ctx.fillStyle = "#666";
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${i * 25}%`, x, HEAD_H - 3);
  }

  // Bone rows
  for (let ri = 0; ri < bones.length; ri++) {
    const bone = bones[ri];
    const y = HEAD_H + ri * ROW_H;
    const isSel = bone.id === selBoneId;

    // Row background
    ctx.fillStyle = isSel ? "#1e2b1e" : (ri % 2 === 0 ? "#202020" : "#1c1c1c");
    ctx.fillRect(0, y, W, ROW_H);

    // Row separator
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, y + ROW_H - 1, W, 1);

    // Track line
    ctx.fillStyle = "#333";
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
        ctx.fillStyle = isKfSel ? "#ffcc44" : (isSel ? "#88cc66" : "#5588aa");
        ctx.strokeStyle = isKfSel ? "#ffee88" : "#334455";
        ctx.lineWidth = 1;
        ctx.fillRect(-DIAMOND, -DIAMOND, DIAMOND * 2, DIAMOND * 2);
        ctx.strokeRect(-DIAMOND, -DIAMOND, DIAMOND * 2, DIAMOND * 2);
        ctx.restore();
      }
    }
  }

  // Scrub cursor (drawn last, on top)
  const sx = PAD + scrub * trackW;
  ctx.fillStyle = "#cc4444";
  ctx.fillRect(sx - 1, 0, 2, H);

  // Scrub head triangle
  ctx.fillStyle = "#ee5555";
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
    <div style={{ padding: 8, borderTop: "1px solid #333", color: "#555", fontSize: 11 }}>
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
    <div style={{ borderTop: "1px solid #333", background: "#1a1a1a", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "4px 8px", gap: 8, background: "#1e1e1e", borderBottom: "1px solid #2a2a2a" }}>
        <span style={{ fontSize: 11, color: "#888", fontWeight: "bold" }}>TIMELINE</span>
        <span style={{ fontSize: 10, color: "#555" }}>
          {clip ? `${clip.id} · ${Object.keys(clip.tracks).length} tracks` : "No clip selected"}
        </span>
        <span style={{ fontSize: 10, color: "#555", marginLeft: "auto" }}>dbl-click to add keyframe</span>
      </div>
      <div style={{ display: "flex", overflow: "auto" }}>
        {/* Bone name column */}
        <div style={{
          width: LABEL_W, flexShrink: 0,
          background: "#1a1a1a",
          borderRight: "1px solid #2a2a2a",
          paddingTop: HEAD_H, // align with header
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
                  padding: "0 8px", fontSize: 10, fontFamily: "monospace",
                  cursor: "pointer",
                  background: isSel ? "#1e2b1e" : (ri % 2 === 0 ? "#202020" : "#1c1c1c"),
                  color: hasKeys ? (isSel ? "#aec" : "#888") : (isSel ? "#68a" : "#444"),
                  borderBottom: "1px solid #2a2a2a",
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
