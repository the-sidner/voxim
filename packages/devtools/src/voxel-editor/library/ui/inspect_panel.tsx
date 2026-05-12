/// <reference lib="dom" />
/**
 * Inspect panel — the new default Library sub-tab.
 *
 * Layout:
 *
 *   ┌──────────────┬──────────────────────────────┬────────────────┐
 *   │              │                              │                │
 *   │  Data tree   │  3D preview canvas (its own  │ Selected-node  │
 *   │  (left)      │  three.js renderer)          │ details panel  │
 *   │              │                              │                │
 *   │              ├──────────────────────────────┤                │
 *   │              │  Preview controls bar        │                │
 *   └──────────────┴──────────────────────────────┴────────────────┘
 *
 * The preview scene is owned per-mount: created on mount, disposed on
 * unmount, and reactively driven by the inspect_state signals.
 */
import { useEffect, useRef } from "preact/hooks";
import { effect } from "@preact/signals";
import type { BrowserContentStore } from "../../content_loader.ts";
import { DataTree } from "./data_tree.tsx";
import { DetailsPanel } from "./details_panel.tsx";
import { PreviewControls } from "./preview_controls.tsx";
import {
  previewPrefabId, previewWeaponPrefabId, previewLocomotion,
  previewSpeed, activeSwing, previewPlaying, selectedTreeNode,
} from "../inspect_state.ts";
import { createPreviewScene, type PreviewScene } from "../preview_scene.ts";

interface Props { content: BrowserContentStore; }

export function InspectPanel({ content }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PreviewScene | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const sc = createPreviewScene(hostRef.current, content);
    sceneRef.current = sc;

    // Reactive bindings — each signal change pushes into the scene.
    const disposers: Array<() => void> = [];
    disposers.push(effect(() => {
      sc.setPrefab(previewPrefabId.value, previewWeaponPrefabId.value);
    }));
    disposers.push(effect(() => sc.setLocomotion(previewLocomotion.value)));
    disposers.push(effect(() => sc.setSpeed(previewSpeed.value)));
    disposers.push(effect(() => sc.setSwing(activeSwing.value)));
    disposers.push(effect(() => sc.setPlaying(previewPlaying.value)));

    // Tree selection → preview shortcuts: clicking a prefab autoselects it,
    // clicking a clip on the prefab's skeleton plays it as locomotion.  This
    // keeps "click around to inspect" feeling natural without modal switches.
    disposers.push(effect(() => {
      const sel = selectedTreeNode.value;
      if (!sel) return;
      const [kind, ...rest] = sel.split(":");
      const id = rest.join(":");
      if (kind === "prefab") {
        previewPrefabId.value = id;
      } else if (kind === "skel-clip") {
        const [skId, clipId] = id.split(":");
        const cur = previewPrefabId.value
          ? content.prefabs.get(previewPrefabId.value)
          : null;
        const curSk = cur?.modelId ? content.models.get(cur.modelId)?.skeletonId : null;
        // Only auto-play if the selected clip belongs to the previewed
        // prefab's skeleton; otherwise just leave selection in the tree.
        if (curSk === skId) {
          if (clipId === "idle" || clipId === "walk" || clipId === "crouch" || clipId === "crouch_walk") {
            previewLocomotion.value = clipId;
          }
        }
      }
    }));

    return () => {
      for (const d of disposers) d();
      sc.dispose();
      sceneRef.current = null;
    };
  }, []);

  return (
    <div style={{ display: "flex", flex: 1, height: "100%", overflow: "hidden" }}>
      <DataTree content={content} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div ref={hostRef} style={{ flex: 1, position: "relative", minHeight: 200 }} />
        <PreviewControls content={content} />
      </div>

      <DetailsPanel content={content} />
    </div>
  );
}
