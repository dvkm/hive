import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { DiffFile, DiffResult, Task } from "../lib/api";
import { useStore } from "../lib/store";
import { CiBadge, toast } from "../lib/ui";
import { MAX_DIFF_LINES } from "../lib/api";

// One collapsible file in the diff viewer. Sticky header shows path + counts.
function DiffFileView({ f, wrap }: { f: DiffFile; wrap: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="diff-file">
      <button className="diff-file-head" onClick={() => setOpen((o) => !o)}>
        <span className="diff-caret">{open ? "▾" : "▸"}</span>
        <span className="diff-path">{f.path}</span>
        <span className="diff-counts">
          <span className="diff-add">+{f.additions}</span>
          <span className="diff-del">−{f.deletions}</span>
        </span>
      </button>
      {open &&
        (f.binary ? (
          <div className="diff-binary">Binary file — not shown</div>
        ) : (
          <div className={`diff-body ${wrap ? "wrap" : ""}`}>
            {f.hunks.map((h, hi) => (
              <div className="diff-hunk" key={hi}>
                <div className="diff-hunk-head">{h.header}</div>
                {h.lines.map((l, li) => (
                  <div className={`diff-line dl-${l.kind}`} key={li}>
                    <span className="dl-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                    <span className="dl-text">{l.text || " "}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

type ActionMode = null | "changes" | "reject";

// The one review surface, shared by the task page, the /review queue, and the
// morning brief. Renders: title/project/summary, PR+CI status, a compact diff
// stat with an expandable inline diff, and the three primary actions
// (approve & merge, request changes, reject). `onDone` lets the parent hide or
// refresh the card after an action resolves.
export function ReviewCard({
  task,
  onDone,
  defaultExpanded = false,
}: {
  task: Task;
  onDone?: () => void;
  defaultExpanded?: boolean;
}) {
  const { projects } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffErr, setDiffErr] = useState("");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [wrap, setWrap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ActionMode>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    let live = true;
    setDiff(null);
    setDiffErr("");
    api
      .diff(task.id)
      .then((d) => live && setDiff(d))
      .catch((e) => live && setDiffErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [task.id]);

  const stat = diff?.files.reduce(
    (a, f) => ({ files: a.files + 1, add: a.add + f.additions, del: a.del + f.deletions }),
    { files: 0, add: 0, del: 0 }
  );

  const merge = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.merge(task.id);
      toast("Merged → Verifying");
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const requestChanges = async () => {
    if (!notes.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.requestChanges(task.id, notes);
      toast(r.delivered ? "Changes requested — sent to agent" : "Changes requested (agent offline; recorded)");
      setNotes("");
      setMode(null);
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!notes.trim() || busy) return;
    setBusy(true);
    try {
      await api.transition(task.id, "cancelled", notes);
      toast("Rejected — task cancelled");
      setNotes("");
      setMode(null);
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="review-card">
      <div className="review-card-head">
        <div className="review-card-title">
          <Link to={`/tasks/${task.id}`}>{task.title}</Link>
          {project && <span className="chip">{project.name}</span>}
          <span className={`chip chip-kind chip-${task.kind}`}>{task.kind}</span>
        </div>
        <div className="review-status">
          {task.pr_url ? (
            <a className="pr" href={task.pr_url} target="_blank" rel="noreferrer">
              PR {"↗"}
            </a>
          ) : (
            <span className="muted mono-sm">branch {task.branch || "?"}</span>
          )}
          <CiBadge status={task.ci_status} />
        </div>
      </div>

      {task.summary && <p className="review-summary">{task.summary}</p>}

      <div className="review-diffstat">
        {diffErr ? (
          <span className="diff-err">Could not load diff: {diffErr}</span>
        ) : !diff ? (
          <span className="muted">Loading diff{"…"}</span>
        ) : stat && stat.files > 0 ? (
          <button className="diffstat-toggle" onClick={() => setExpanded((x) => !x)}>
            <span className="diff-caret">{expanded ? "▾" : "▸"}</span>
            {stat.files} file{stat.files === 1 ? "" : "s"}{" "}
            <span className="diff-add">+{stat.add}</span> <span className="diff-del">{"−"}{stat.del}</span>
          </button>
        ) : (
          <span className="muted">No changes to show.</span>
        )}
        {expanded && diff && diff.files.length > 0 && (
          <label className="wrap-toggle">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> wrap
          </label>
        )}
      </div>

      {expanded && diff && (
        <div className="diff-viewer">
          {diff.files.map((f) => (
            <DiffFileView key={f.path} f={f} wrap={wrap} />
          ))}
          {diff.truncated && (
            <div className="diff-trunc">Diff truncated (over {MAX_DIFF_LINES.toLocaleString()} lines). View the full diff in the PR.</div>
          )}
        </div>
      )}

      <div className="review-actions">
        <button className="btn btn-primary" onClick={merge} disabled={busy}>
          {busy ? "Working…" : "Approve & merge"}
        </button>
        <button className="btn" onClick={() => setMode(mode === "changes" ? null : "changes")}>
          Request changes
        </button>
        <button className="btn btn-danger" onClick={() => setMode(mode === "reject" ? null : "reject")}>
          Reject
        </button>
      </div>

      {mode && (
        <div className="review-notes">
          <textarea
            placeholder={
              mode === "changes"
                ? "What needs to change before merge? (sent to the agent)"
                : "Why reject this? (recorded as the cancellation reason)"
            }
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            autoFocus
          />
          <button
            className={`btn ${mode === "reject" ? "btn-danger" : "btn-primary"}`}
            onClick={mode === "changes" ? requestChanges : reject}
            disabled={!notes.trim() || busy}
          >
            {mode === "changes" ? "Send & return to In Progress" : "Reject & cancel task"}
          </button>
        </div>
      )}
    </section>
  );
}
