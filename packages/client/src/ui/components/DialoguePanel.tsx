import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";

const dialogue = computed(() => uiState.value.dialogue);

export function DialoguePanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const dlg = dialogue.value;
  if (!dlg) return null;

  return (
    <div
      class="panel interactive"
      style={{
        position: "absolute", bottom: "var(--gap-xl)", left: "50%",
        transform: "translateX(-50%)",
        zIndex: "var(--z-modal)",
        width: "420px",
        maxWidth: "90vw",
      }}
    >
      <div class="panel__title">{dlg.npcName}</div>
      <p style={{ fontSize: "var(--text-sm)", marginBottom: "var(--gap-md)", lineHeight: "1.6" }}>
        {dlg.speakerText}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--gap-xs)" }}>
        {dlg.choices.map((choice) => (
          <button
            key={choice.index}
            class="btn interactive"
            style={{ textAlign: "left" }}
            onClick={() => onAction({ type: "dialogue_choice", npcId: dlg.npcId, choiceIndex: choice.index })}
          >
            {choice.text}
          </button>
        ))}
        <button
          class="btn interactive"
          style={{ color: "var(--col-text-dim)" }}
          onClick={() => onAction({ type: "dialogue_close", npcId: dlg.npcId })}
        >
          [Leave]
        </button>
      </div>
    </div>
  );
}
