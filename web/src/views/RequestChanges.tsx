import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { toast } from "../lib/ui";

// "I don't like what shipped." The note IS the brief: filing it queues a
// follow-up task that carries what the original built (PR, commit, files,
// explanation), and leaves the original done. See requestChangesOnShipped in
// server/src/api.ts.
export function RequestChanges({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState<{ id: string; label: string } | null>(null);

  const submit = async () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.requestChanges(taskId, note.trim());
      // The filed line below IS the confirmation — no toast to chase.
      setFiled({ id: r.followup_task_id!, label: r.followup_label ?? "the follow-up" });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (filed)
    return (
      <p className="request-changes-filed">
        Filed <Link to={`/tasks/${filed.id}`}>{filed.label}</Link>
      </p>
    );
  if (!open)
    return (
      <button className={`btn ${compact ? "btn-mini" : ""}`} onClick={() => setOpen(true)} title="File a follow-up task with this task's context">
        Request changes
      </button>
    );

  return (
    <div className="request-changes">
      <textarea
        autoFocus
        placeholder="What should be different?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="request-changes-actions">
        <button className="btn btn-primary btn-mini" disabled={!note.trim() || busy} onClick={submit}>
          {busy ? "Filing…" : "File follow-up"}
        </button>
        <button className="link-btn" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
