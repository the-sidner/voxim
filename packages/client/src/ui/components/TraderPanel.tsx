import { computed } from "@preact/signals";
import { uiState, closePanel } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";
import { Pane, Section, Btn } from "./primitives.tsx";

const trader = computed(() => uiState.value.trader);

export function TraderPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const tr = trader.value;
  if (!tr) return null;

  return (
    <Pane
      title={`${tr.npcName} — Trader`}
      defaultX={window.innerWidth / 2 - 200} defaultY={120}
      onClose={() => closePanel("trader")}
      style={{ width: "400px" }}
      foot={<span class="num">coins {tr.playerCoins}</span>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-5)" }}>
        <Section title="Buy">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            {tr.buyOffers.map((offer) => (
              <div
                key={offer.itemType}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  gap: "var(--s-3)", fontSize: "var(--fs-body)",
                }}
              >
                <span>{offer.displayName}</span>
                <Btn
                  kind="primary"
                  onClick={() => onAction({ type: "trade_buy", itemType: offer.itemType, quantity: 1 })}
                >
                  <span class="num">{offer.priceCoin}c</span>
                </Btn>
              </div>
            ))}
          </div>
        </Section>
        <Section title="Sell">
          {/* TODO: list player inventory items that trader accepts */}
          <span style={{ color: "var(--bone-faint)", fontSize: "var(--fs-body)" }}>
            Drag items here to sell
          </span>
        </Section>
      </div>
    </Pane>
  );
}
