import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Checkpoint, CheckpointPlan, Event } from "../lib/api";
import { useStore } from "../lib/store";
import { useProjectFilter, inProjectFilter } from "../lib/projectFilter";
import { taskLabel } from "../lib/references";
import { toast } from "../lib/ui";

// Live build-time checkboxes: agents emit `checkpoint` events while working;
// the director ticks (ok) or flags them here. A flag steers the agent
// immediately. Both views share one row component so the inbox and the task
// page behave identically.

interface Row {
  id: string;
  task_id: string;
  ts: string;
  note: string;
  verdict?: "ok" | "flag"; // acked state (task-page view only)
  flagNote?: string | null;
  blocking?: boolean; // agent is parked until this is acked
  plan?: CheckpointPlan;
  concerns?: { severity: "note" | "veto"; text: string }[];
}

// A blocking plan is approved from the card itself, so the card carries the
// whole plan and the critic's concerns. Everything the director needs to say
// yes is on screen; no task page, no digging.
function PlanBody({ plan, concerns }: { plan: CheckpointPlan; concerns?: Row["concerns"] }) {
  return (
    <div className="cp-plan">
      <div className="cp-plan-line"><b>Goal</b> {plan.goal}</div>
      <div className="cp-plan-line"><b>Approach</b> {plan.approach}</div>
      {plan.files_expected.length > 0 && (
        <div className="cp-plan-line"><b>Files</b> <code>{plan.files_expected.join(", ")}</code></div>
      )}
      <div className="cp-plan-line"><b>Check</b> {plan.verification_planned}</div>
      {concerns && concerns.length > 0 && (
        <ul className="cp-concerns">
          {concerns.map((c, i) => (
            <li key={i} className={c.severity === "veto" ? "cp-concern-veto" : ""}>
              {c.severity === "veto" ? "VETO" : "Note"}: {c.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CheckpointRow({
  row,
  taskLabel,
  onAcked,
}: {
  row: Row;
  taskLabel?: string; // "#52 fix(cms): …" — inbox view only
  onAcked?: (id: string, verdict: "ok" | "flag") => void;
}) {
  const [busy, setBusy] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState("");
  const acked = !!row.verdict;

  const ack = async (verdict: "ok" | "flag") => {
    if (busy) return;
    setBusy(true);
    try {
      const r = (await api.ackCheckpoint(row.task_id, row.id, verdict, verdict === "flag" ? note : undefined)) as {
        delivered: boolean;
        followup_task_id?: string | null;
      };
      if (verdict === "flag")
        toast(
          r.delivered
            ? "Flag sent to the agent"
            : r.followup_task_id
              ? "Already shipped — corrective task queued"
              : "Flagged (recorded)"
        );
      setFlagging(false);
      setNote("");
      onAcked?.(row.id, verdict);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`cp-row ${acked ? `cp-acked cp-${row.verdict}` : ""}`}>
      <button
        className="cp-box"
        title={acked ? `${row.verdict}` : "Approve"}
        disabled={busy || acked}
        onClick={() => ack("ok")}
      >
        {row.verdict === "ok" ? "✓" : row.verdict === "flag" ? "⚑" : ""}
      </button>
      <div className="cp-body">
        {taskLabel && (
          <Link className="cp-task" to={`/tasks/${row.task_id}`}>
            {taskLabel}
          </Link>
        )}
        <span className="cp-note">{row.note}</span>
        {row.blocking && !acked && <span className="chip cp-waiting" title="The agent posted this plan and stopped. It starts editing when you approve.">waiting on you</span>}
        {row.verdict === "flag" && row.flagNote && <span className="cp-flag-note">— {row.flagNote}</span>}
        {row.plan && <PlanBody plan={row.plan} concerns={row.concerns} />}
      </div>
      {!acked && (
        <button className="cp-flag" title="Flag: send back to the agent" disabled={busy} onClick={() => setFlagging((f) => !f)}>
          ⚑ flag
        </button>
      )}
      {flagging && (
        <div className="cp-flag-form">
          <input
            autoFocus
            placeholder="Why is this wrong / what should the agent do instead?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && note.trim() && ack("flag")}
          />
          <button className="btn btn-danger" disabled={!note.trim() || busy} onClick={() => ack("flag")}>
            Flag
          </button>
        </div>
      )}
    </div>
  );
}

// Per-task checklist, derived from the task's own events (checkpoint +
// checkpoint_ack). Rendered on the task page and the review card.
export function CheckpointList({ events }: { events: Event[] }) {
  const [local, setLocal] = useState<Record<string, "ok" | "flag">>({});
  const acks = new Map<string, { verdict: "ok" | "flag"; note: string | null }>();
  for (const e of events)
    if (e.type === "checkpoint_ack" && e.payload?.checkpoint_id)
      acks.set(String(e.payload.checkpoint_id), {
        verdict: e.payload.verdict as "ok" | "flag",
        note: (e.payload.note as string) ?? null,
      });
  const rows: Row[] = events
    .filter((e) => e.type === "checkpoint")
    .map((e) => {
      const ack = acks.get(e.id);
      return {
        id: e.id,
        task_id: e.task_id,
        ts: e.ts,
        note: String(e.payload?.note ?? ""),
        verdict: local[e.id] ?? ack?.verdict,
        flagNote: ack?.note,
      };
    });
  if (!rows.length) return null;
  const open = rows.filter((r) => !r.verdict).length;
  return (
    <section className="cp-panel">
      <div className="cp-head">
        Checkpoints {open > 0 && <span className="cp-count">{open} open</span>}
      </div>
      {rows.map((r) => (
        <CheckpointRow key={r.id} row={r} onAcked={(id, v) => setLocal((m) => ({ ...m, [id]: v }))} />
      ))}
    </section>
  );
}

// Cross-task inbox section: every un-acked checkpoint, grouped per task, with
// an approve-all per group. Live via the store's SSE-driven checkpoint list.
// Un-acked checkpoints survive task completion (marked "shipped") — a late
// flag becomes a corrective follow-up task instead of a dead steer.
export function CheckpointsInbox({ taskId, heading = true }: { taskId?: string; heading?: boolean } = {}) {
  const { checkpoints, reloadCheckpoints, tasks } = useStore();
  const projectFilter = useProjectFilter();
  const [busy, setBusy] = useState(false);
  const scoped = checkpoints.filter((c) => inProjectFilter(c.project_id, projectFilter) && (!taskId || c.task_id === taskId));
  if (!scoped.length) return null;

  const groups = new Map<string, Checkpoint[]>();
  for (const c of scoped) {
    const g = groups.get(c.task_id) ?? [];
    g.push(c);
    groups.set(c.task_id, g);
  }
  const visibleGroups = [...groups.values()];

  const approveAll = async (items: Checkpoint[]) => {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all(items.map((c) => api.ackCheckpoint(c.task_id, c.id, "ok")));
      toast(`Approved ${items.length} checkpoint${items.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      reloadCheckpoints();
    }
  };

  return (
    <section className="cp-inbox">
      {heading && (
        <div className="cp-inbox-head">
          Checkpoints <span className="cp-count">{scoped.length}</span>
          <span className="muted"> — agents&apos; judgment calls; tick to approve, flag to steer (or spawn a fix if already shipped)</span>
        </div>
      )}
      {visibleGroups.map((items) => {
        const c0 = items[0];
        const finished = ["done", "failed"].includes(c0.task_state);
        return (
          <div className="cp-group" key={c0.task_id}>
            <div className="cp-group-head">
              <Link className="cp-task" to={`/tasks/${c0.task_id}`}>
                {taskLabel(tasks.find((task) => task.id === c0.task_id) ?? { number: c0.task_number })} {c0.task_title}
              </Link>
              {finished && <span className="chip" title="Task already finished — flags spawn a corrective task">shipped</span>}
              {items.length > 1 && (
                <button className="cp-approve-all" disabled={busy} onClick={() => approveAll(items)}>
                  ✓ approve all {items.length}
                </button>
              )}
            </div>
            {items.map((c) => (
              <CheckpointRow
                key={c.id}
                row={{ id: c.id, task_id: c.task_id, ts: c.ts, note: c.note, blocking: c.blocking, plan: c.plan, concerns: c.concerns }}
                onAcked={() => reloadCheckpoints()}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}
