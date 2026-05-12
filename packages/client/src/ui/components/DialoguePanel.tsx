import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";
import { Btn } from "./primitives.tsx";

const dialogue = computed(() => uiState.value.dialogue);

export function DialoguePanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const dlg = dialogue.value;
  if (!dlg) return null;

  return (
    <div
      class="interactive"
      style={{
        position: "fixed", bottom: "var(--s-9)", left: "50%",
        transform: "translateX(-50%)",
        zIndex: "var(--z-modal)",
        width: "440px",
        maxWidth: "90vw",
        background: "linear-gradient(180deg, var(--moss-hov), var(--moss))",
        border: "1px solid var(--line-strong)",
        boxShadow: "var(--inset-raise), var(--sh-card)",
        padding: "var(--s-4) var(--s-5)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-4)",
      }}
    >
      <div style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-eyebrow)",
        letterSpacing: "var(--ls-eyebrow)",
        textTransform: "uppercase",
        color: "var(--bone-dim)",
        borderBottom: "1px solid var(--line)",
        paddingBottom: "var(--s-2)",
      }}>
        {dlg.npcName}
      </div>

      <p class="ds-prose" style={{ margin: 0 }}>
        {dlg.speakerText}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
        {dlg.choices.map((choice) => (
          <Btn
            key={choice.index}
            style={{ textAlign: "left" }}
            onClick={() => onAction({ type: "dialogue_choice", npcId: dlg.npcId, choiceIndex: choice.index })}
          >
            {choice.text}
          </Btn>
        ))}
        <Btn
          kind="ghost"
          onClick={() => onAction({ type: "dialogue_close", npcId: dlg.npcId })}
        >
          [Leave]
        </Btn>
      </div>
    </div>
  );
}
