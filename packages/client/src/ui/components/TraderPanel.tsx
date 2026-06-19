import { computed } from "@preact/signals";
import type { ComponentChildren } from "preact";
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
            {tr.buyOffers.length === 0 && <Empty>Nothing for sale</Empty>}
            {tr.buyOffers.map((offer) => {
              const soldOut = offer.stock === 0;
              const tooPoor = tr.playerCoins < offer.priceCoin;
              return (
                <Row key={offer.slot} label={offer.displayName} sub={offer.stock === null ? null : `${offer.stock} left`}>
                  <Btn
                    kind="primary"
                    disabled={soldOut || tooPoor}
                    onClick={() => onAction({ type: "trade_buy", slot: offer.slot })}
                  >
                    <span class="num">{offer.priceCoin}c</span>
                  </Btn>
                </Row>
              );
            })}
          </div>
        </Section>
        <Section title="Sell">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            {tr.sellOffers.length === 0 && <Empty>You hold nothing this trader wants</Empty>}
            {tr.sellOffers.map((offer) => (
              <Row key={offer.slot} label={offer.displayName} sub={offer.stock === null ? null : `you have ${offer.stock}`}>
                <Btn kind="ghost" onClick={() => onAction({ type: "trade_sell", slot: offer.slot })}>
                  <span class="num">+{offer.priceCoin}c</span>
                </Btn>
              </Row>
            ))}
          </div>
        </Section>
      </div>
    </Pane>
  );
}

function Row({ label, sub, children }: { label: string; sub: string | null; children: ComponentChildren }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--s-3)", fontSize: "var(--fs-body)" }}>
      <span>
        {label}
        {sub && <span style={{ color: "var(--bone-faint)", marginLeft: "var(--s-2)" }}>{sub}</span>}
      </span>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ComponentChildren }) {
  return <span style={{ color: "var(--bone-faint)", fontSize: "var(--fs-body)" }}>{children}</span>;
}
