import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";

const trader = computed(() => uiState.value.trader);

export function TraderPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const tr = trader.value;
  if (!tr) return null;

  return (
    <div
      class="panel interactive"
      style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: "var(--z-modal)",
        width: "340px",
      }}
    >
      <div class="panel__title">{tr.npcName} — Trader</div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--col-text-dim)", marginBottom: "var(--gap-sm)" }}>
        Coins: {tr.playerCoins}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap-md)" }}>
        <div>
          <div class="panel__title">Buy</div>
          {tr.buyOffers.map((offer) => (
            <div
              key={offer.itemType}
              style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-sm)", marginBottom: "var(--gap-xs)" }}
            >
              <span>{offer.displayName}</span>
              <button
                class="btn interactive"
                onClick={() => onAction({ type: "trade_buy", itemType: offer.itemType, quantity: 1 })}
              >
                {offer.priceCoin}c
              </button>
            </div>
          ))}
        </div>

        <div>
          <div class="panel__title">Sell</div>
          {/* TODO: list player inventory items that trader accepts */}
          <span style={{ fontSize: "var(--text-sm)", color: "var(--col-text-dim)" }}>
            Drag items here to sell
          </span>
        </div>
      </div>
    </div>
  );
}
