import { computed } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { uiState, closePanel } from "../ui_store.ts";
import { Pane, Section } from "./primitives.tsx";

const jobBoard = computed(() => uiState.value.jobBoard);

/**
 * Job-board panel (T-076). Read-only for v1: lists the hiring workbench's
 * pending jobs (goal · item · priority · claim status). game.ts mirrors the
 * board's networked `jobBoard.pending` into uiState, so the panel stays purely
 * reactive — sorted by priority so the next-to-pull job reads top.
 */
export function JobBoardPanel() {
  const jb = jobBoard.value;
  if (!jb) return null;

  const jobs = [...jb.jobs].sort((a, b) => b.priority - a.priority);

  return (
    <Pane
      title={`${jb.stationName} — Jobs`}
      defaultX={window.innerWidth / 2 - 200} defaultY={120}
      onClose={() => closePanel("job_board")}
      style={{ width: "400px" }}
      foot={<span class="num">{jobs.length} pending</span>}
    >
      <Section title="Pending work">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
          {jobs.length === 0 && <Empty>No jobs posted</Empty>}
          {jobs.map((job) => (
            <Row
              key={job.id}
              label={`${job.goal} ${job.itemName}`}
              sub={job.claimedBy ? "claimed" : "unclaimed"}
            >
              <span class="num">P{job.priority}</span>
            </Row>
          ))}
        </div>
      </Section>
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
