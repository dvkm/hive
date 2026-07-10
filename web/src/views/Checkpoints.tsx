import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Checkpoint, Event } from "../lib/api";
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
      const r = await api.ackCheckpoint(row.task_id, row.id, verdict, verdict === "flag" ? note : undefined);
      if (verdict === "flag")
        toast(r.delivered ? "Flag sent to the agent" : "Flagged (agent offline; recorded)");
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
        {row.verdict === "flag" && row.flagNote && <span className="cp-flag-note">— {row.flagNote}</span>}
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

// Cross-task inbox section: every un-acked checkpoint on a live task. Sits on
// the /decisions page so ticking through them is part of inbox zero.
export function CheckpointsInbox() {
  const [items, setItems] = useState<Checkpoint[] | null>(null);
  const load = () =>
    api
      .checkpoints()
      .then((r) => setItems(r.checkpoints))
      .catch(() => setItems([]));
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!items?.length) return null;
  return (
    <section className="cp-inbox">
      <div className="cp-inbox-head">
        Checkpoints <span className="cp-count">{items.length}</span>
        <span className="muted"> — live judgment calls from working agents; tick to approve, flag to steer</span>
      </div>
      {items.map((c) => (
        <CheckpointRow
          key={c.id}
          row={{ id: c.id, task_id: c.task_id, ts: c.ts, note: c.note }}
          taskLabel={`#${c.task_number}`}
          onAcked={(id) => setItems((xs) => (xs ?? []).filter((x) => x.id !== id))}
        />
      ))}
    </section>
  );
}
