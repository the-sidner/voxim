/**
 * Details panel — read-only inspector for whatever's selected in the data
 * tree.  Shows a compact header + the raw JSON for the selected node.
 *
 * v1 keeps it simple (JSON dump).  Specialized renderers (clip stats, prefab
 * field summary, etc.) live behind extension points so they can be added
 * without rewriting the dispatch.
 */
import type { BrowserContentStore } from "../../content_loader.ts";
import { selectedTreeNode } from "../inspect_state.ts";
import { libraryClips } from "../lib_state.ts";

interface Props { content: BrowserContentStore; }

const HEADER: preact.JSX.CSSProperties = {
  padding: "var(--s-2) var(--s-4)",
  background: "linear-gradient(180deg, var(--moss-hi), var(--moss))",
  borderBottom: "1px solid var(--line)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-eyebrow)",
  color: "var(--bone-dim)",
  textTransform: "uppercase",
  letterSpacing: "var(--ls-eyebrow)",
};

export function DetailsPanel({ content }: Props) {
  const sel = selectedTreeNode.value;
  if (!sel) {
    return (
      <div style={paneStyle()}>
        <div style={HEADER}>Details</div>
        <div class="flavour" style={{ padding: 12 }}>
          Pick a node in the tree on the left.
        </div>
      </div>
    );
  }

  const [kind, ...rest] = sel.split(":");
  const id = rest.join(":");

  let title = sel;
  let body: unknown = null;
  let summary: preact.JSX.Element | null = null;

  switch (kind) {
    case "skeleton": {
      const sk = content.skeletons.get(id);
      title = `skeleton · ${id}`;
      body = sk;
      if (sk) summary = (
        <KV pairs={[
          ["bones", String(sk.bones.length)],
          ["clips", String((sk.clips ?? []).length)],
          ["masks", String((sk.boneMasks ?? []).length)],
          ["IK chains", (sk.ikChains ?? []).map((c) => c.id).join(", ") || "—"],
        ]} />
      );
      break;
    }
    case "skel-clip": {
      const [skId, clipId] = id.split(":");
      const sk = content.skeletons.get(skId);
      const c = sk?.clips?.find((c) => c.id === clipId);
      title = `clip · ${clipId} (skeleton ${skId})`;
      body = c;
      if (c) {
        const totalKeys = Object.values(c.tracks).reduce((s, t) => s + t.length, 0);
        summary = <KV pairs={[
          ["loop", String(c.loop)],
          ["duration", `${c.durationSeconds ?? "—"}s`],
          ["bones tracked", String(Object.keys(c.tracks).length)],
          ["keyframes", String(totalKeys)],
        ]} />;
      }
      break;
    }
    case "skel-bone": {
      const [skId, boneId] = id.split(":");
      const sk = content.skeletons.get(skId);
      const b = sk?.bones.find((b) => b.id === boneId);
      title = `bone · ${boneId}`;
      body = b;
      if (b) summary = <KV pairs={[
        ["parent", b.parent ?? "(root)"],
        ["restX/Y/Z", `${b.restX} / ${b.restY} / ${b.restZ}`],
      ]} />;
      break;
    }
    case "model": {
      const m = content.models.get(id);
      title = `model · ${id}`;
      body = m;
      if (m) summary = <KV pairs={[
        ["skeleton", m.skeletonId ?? "—"],
        ["voxels", String(m.nodes.length)],
        ["sub-objects", String(m.subObjects.length)],
        ["materials", m.materials.join(", ")],
      ]} />;
      break;
    }
    case "prefab": {
      const p = content.prefabs.get(id);
      title = `prefab · ${id}`;
      body = p;
      if (p) {
        const slots = p.animationSlots ?? {};
        const slotEntries = Object.entries(slots);
        summary = <KV pairs={[
          ["modelId", p.modelId ?? "—"],
          ["modelScale", String(p.modelScale ?? 1)],
          ["category", p.category ?? "—"],
          ["animationSlots", slotEntries.length === 0 ? "(default)" :
            slotEntries.map(([k, v]) => `${k}→${v}`).join(", ")],
        ]} />;
      }
      break;
    }
    case "weapon-action": {
      const wa = content.weaponActions.get(id);
      title = `weapon action · ${id}`;
      body = wa;
      if (wa) summary = <KV pairs={[
        ["timing", `windup=${wa.windupTicks}, active=${wa.activeTicks}, winddown=${wa.winddownTicks}`],
        ["clip", wa.clipId ?? "—"],
        ["hold bone", wa.holdHand ?? "hand_r"],
        ["blade", wa.blade ? `tip=[${wa.blade.tipLocal.join(",")}] r=${wa.blade.radius}` : "—"],
        ["projectile", wa.projectile ? `modelId=${wa.projectile.modelId}, speed=${wa.projectile.speed}` : "—"],
      ]} />;
      break;
    }
    case "library-clip": {
      const lc = libraryClips.value.find((c) => c.id === id);
      title = `library · ${id}`;
      body = lc;
      if (lc) {
        const isCompound = "_kind" in lc;
        summary = <KV pairs={[
          ["skeleton", lc._skeleton],
          ["kind", isCompound ? lc._kind : "plain"],
          ["source", lc._source ?? "—"],
        ]} />;
      }
      break;
    }
  }

  return (
    <div style={paneStyle()}>
      <div style={HEADER}>{title}</div>
      {summary && (
        <div style={{ padding: "var(--s-3) var(--s-4)", borderBottom: "1px solid var(--line)" }}>
          {summary}
        </div>
      )}
      <pre style={{
        margin: 0, padding: "var(--s-3)", fontSize: 10,
        fontFamily: "var(--font-mono)",
        color: "var(--bone-dim)", overflow: "auto", whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>{body ? JSON.stringify(body, null, 2) : "(not found)"}</pre>
    </div>
  );
}

function KV({ pairs }: { pairs: [string, string][] }) {
  return (
    <div style={{
      fontSize: 11, lineHeight: "16px", color: "var(--bone-dim)",
      fontFamily: "var(--font-mono)",
    }}>
      {pairs.map(([k, v]) => (
        <div key={k}>
          <span style={{ color: "var(--bone-faint)", display: "inline-block", width: 110 }}>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

function paneStyle(): preact.JSX.CSSProperties {
  return {
    width: 320, flexShrink: 0, height: "100%", overflowY: "auto",
    background: "linear-gradient(180deg, var(--moss-hov), var(--moss))",
    borderLeft: "1px solid var(--line-strong)",
    color: "var(--bone)",
    fontFamily: "var(--font-body)",
    display: "flex", flexDirection: "column",
  };
}
