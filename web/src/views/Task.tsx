import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDiamond } from "@fortawesome/free-solid-svg-icons";
import { api } from "../lib/api";
import { RequestChanges } from "./RequestChanges";
import type { Decision, Evidence, JiraTaskState, TaskDetail, UsageTotals } from "../lib/api";
import { useStore } from "../lib/store";
import { splitAttachments } from "../lib/attachments";
import { Attach, BlockedBy, CiBadge, HEALTH_LABEL, NEXT, PriorityChip, STATE_LABEL, StatusDot, toast } from "../lib/ui";
import { ReviewAudit, ReviewCard, ReviewUnderstanding } from "./ReviewCard";
import { CheckpointList } from "./Checkpoints";
import { DecisionCard } from "./DecisionCard";
import { ReportView } from "./ReportView";
import { UnderstandingQuiz } from "./UnderstandingQuiz";
import { relTime } from "../lib/time";
import { useLightbox } from "../lib/lightbox";
import type { LightboxImage } from "../lib/lightbox";
import { fmtTokens, fmtUsd } from "./Analytics";
import { buildTimeline } from "../lib/timeline";
import { ANSWERED_BY_LABEL } from "../lib/labels";
import type { TimelineItem } from "../lib/timeline";
import { eventText } from "../lib/eventText";
import { isJiraMirror, isTrackingOnly, trackedSubtasks } from "../lib/needsYou";
import { PrReference, ReferenceText, TaskRef, prLabel } from "../lib/references";

// Compact per-task usage line: tokens + estimated cost, only when usage exists.
function UsageLine({ id, rev }: { id: string; rev: number }) {
  const [tot, setTot] = useState<UsageTotals | null>(null);
  useEffect(() => {
    let live = true;
    api.taskUsage(id).then((d) => live && setTot(d.totals)).catch(() => {});
    return () => {
      live = false;
    };
  }, [id, rev]);
  if (!tot || tot.calls === 0) return null;
  return (
    <div className="task-usage" title={`${tot.calls} LLM call(s)`}>
      <span className="tu-tok">{fmtTokens(tot.total_tokens)} processed</span>
      <span className="tu-breakdown">{fmtTokens(tot.input_tokens)} fresh · {fmtTokens(tot.cache_read_tokens)} cached · {fmtTokens(tot.output_tokens)} output · {fmtTokens(tot.cache_write_tokens)} cache write</span>
      <span className="tu-cost">
        {tot.unpriced > 0 && tot.cost_usd === 0 ? "unpriced" : `~${fmtUsd(tot.cost_usd)}`}
      </span>
    </div>
  );
}

function EvidenceItem({ e, onOpen }: { e: Evidence; onOpen?: () => void }) {
  if (e.kind === "screenshot" && e.url) {
    return (
      <button className="ev-img" onClick={onOpen} title="Open">
        <img src={e.url} alt={e.caption || "screenshot"} />
        <span className="ev-cap">{e.caption}</span>
      </button>
    );
  }
  const href = e.url || undefined;
  const viewable = !!href && ["report", "log", "test_run"].includes(e.kind);
  const [open, setOpen] = useState(false);
  const head = (
    <div className="ev-card-head">
      <span className={`chip chip-kind`}>{e.kind}</span>
      <span className="ev-cap">{e.caption || e.path || e.url}</span>
      {href && (
        <a className="ev-ext" href={href} target="_blank" rel="noreferrer" title="Open raw file" onClick={(ev) => ev.stopPropagation()}>
          ↗
        </a>
      )}
    </div>
  );
  // Clicking a text-evidence card opens the inline viewer; the ↗ opens the raw
  // file. Link evidence keeps the whole card as an external anchor.
  if (viewable) {
    return (
      <div className={`ev-card ev-viewable ${open ? "ev-open" : ""}`} onClick={() => setOpen((o) => !o)}>
        {head}
        {e.preview && !open && <pre className="ev-preview">{e.preview}</pre>}
        {open && (
          <div onClick={(ev) => ev.stopPropagation()}>
            <ReportView url={href!} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="ev-card">
      {href ? (
        <a className="ev-card-link" href={href} target="_blank" rel="noreferrer">
          {head}
        </a>
      ) : (
        head
      )}
      {e.preview && <pre className="ev-preview">{e.preview}</pre>}
    </div>
  );
}

function DecisionMini({ d }: { d: Decision }) {
  const answered = d.status !== "open";
  return (
    <div className={`dmini ${answered ? "dmini-done" : "dmini-open"}`}>
      <div className="dmini-head">
        <strong><ReferenceText text={d.title} taskId={d.task_id} bundle={d.bundle} /></strong>
        <span className={`chip chip-risk risk-${d.risk || "unknown"}`}>{d.risk || "?"}</span>
      </div>
      {answered ? (
        <div className="dmini-answer">
          Answered: <code>{d.answer_key}</code>
          {d.answer_note && <> — {d.answer_note}</>}
        </div>
      ) : (
        <Link className="btn btn-primary" to="/decisions">
          Answer in inbox →
        </Link>
      )}
    </div>
  );
}

// One timeline row, dispatched on the folded item kind. Transcript text and
// decision prompts render as prominent blocks; grouped tools collapse into an
// expandable "used N tools" row; everything else stays a quiet one-liner.
function TimelineRow({ it }: { it: TimelineItem }) {
  if (it.kind === "text") {
    return (
      <li className="tl-text">
        <div className="tl-text-head">
          <span className={`src src-${it.source}`}>{it.source}</span>
          <span className="tl-age" title={it.ts}>{relTime(it.ts)}</span>
        </div>
        <div className="tl-bubble">{it.text}</div>
      </li>
    );
  }

  if (it.kind === "tools") {
    return (
      <li className="tl-tools">
        <details>
          <summary>
            <span className="tl-tools-count">used {it.tools.length} tool{it.tools.length === 1 ? "" : "s"}</span>
            <span className="tl-chips">
              {it.tools.map((tl, i) => (
                <span key={i} className="chip chip-tool">{tl.tool}</span>
              ))}
            </span>
            <span className="tl-age" title={it.ts}>{relTime(it.ts)}</span>
          </summary>
          <ul className="tl-tool-list">
            {it.tools.map((tl, i) => (
              <li key={i}>
                <span className="chip chip-tool">{tl.tool}</span>
                {tl.summary && <code className="tl-tool-sum">{tl.summary}</code>}
              </li>
            ))}
          </ul>
        </details>
      </li>
    );
  }

  if (it.kind === "decision") {
    const d = it.decision;
    return (
      <li className="tl-decision">
        <div className="tl-decision-head">
          <span className="tl-decision-badge"><FontAwesomeIcon icon={faDiamond} /> {it.open ? "Awaiting your decision" : "Decision requested"}</span>
          <span className="tl-age" title={it.ts}>{relTime(it.ts)}</span>
        </div>
        <div className="tl-decision-q">{d.title}</div>
        {d.context && <div className="tl-decision-ctx">{d.context}</div>}
        {d.options && d.options.length > 0 && (
          <ul className="tl-decision-opts">
            {d.options.map((o) => (
              <li key={o.key} className={!it.open && o.key === d.answer_key ? "opt-chosen" : ""}>
                {o.label || o.key}
              </li>
            ))}
          </ul>
        )}
        {it.open ? (
          <Link className="btn btn-primary btn-mini" to="/decisions">Answer in inbox →</Link>
        ) : (
          <div className="tl-decision-answer">
            {d.answered_by && ANSWERED_BY_LABEL[d.answered_by] ? ANSWERED_BY_LABEL[d.answered_by] : "✓ You"}
            {d.answered_actor && <> ({d.answered_actor})</>} answered:{" "}
            <strong>{it.answerLabel}</strong>
            {d.answer_note && <> — {d.answer_note}</>}
            {d.answered_at && <span className="tl-age"> · {relTime(d.answered_at)}</span>}
          </div>
        )}
      </li>
    );
  }

  const ev = it.ev;
  const actor = typeof ev.payload.actor === "string" && ev.payload.actor.trim() ? ev.payload.actor : null;
  return (
    <li>
      <span className={`src src-${ev.source}`}>{ev.source}{actor && ` · ${actor}`}</span>
      <span className="tl-type">{ev.type}</span>
      <span className="tl-note">{eventText(ev)}</span>
      <span className="tl-age" title={ev.ts}>{relTime(ev.ts)}</span>
    </li>
  );
}

export default function TaskPage() {
  const { id = "" } = useParams();
  return <TaskBody id={id} />;
}

// Embedded read-only terminal: the agent's live pane, polled while visible.
// Input stays on the steer box — watching is the missing piece, not typing.
function PaneTerminal({ taskId }: { taskId: string }) {
  const [text, setText] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [open, setOpen] = useState(true);
  const boxRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const tick = () =>
      api
        .pane(taskId)
        .then((r) => {
          if (!live) return;
          setText(r.text);
          setError("");
          // Follow the tail unless the user scrolled up to read something.
          const el = boxRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
        })
        .catch((e) => live && setError(e.message));
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [taskId, open]);
  return (
    <section className="panel">
      <button className="panel-head panel-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="panel-caret">{open ? "▾" : "▸"}</span>
        Terminal
        <span className="head-count">live</span>
      </button>
      {open &&
        (error ? (
          <div className="muted">pane unavailable: {error}</div>
        ) : (
          <pre className="term" ref={boxRef}>
            {text || "…"}
          </pre>
        ))}
    </section>
  );
}

// The task detail content, shared by the standalone /tasks/:id route and the
// What a director needs to know about a mirrored Jira ticket without asking:
// where it is, whether the automatic sync is actually running, what has not gone
// out yet, and any error that is still true. Everything here derives from
// delivery receipts rather than an optimistic local flag, so the panel cannot
// claim something reached Jira that did not.
type JiraSyncMode = "loading" | "invalid" | "unconfigured" | "paused" | "shadow" | "live";

function jiraSyncMode(jira: JiraTaskState | null): JiraSyncMode {
  if (!jira) return "loading";
  // An invalid config is NOT the same as an absent one: the server refuses to
  // run the automatic cycle for it, and the director needs the actual reason
  // rather than "not configured", which sends them looking for a missing setup.
  if (jira.config_error) return "invalid";
  if (jira.configured === false) return "unconfigured";
  if (jira.configured !== true) return "loading";
  if (jira.enabled === false) return "paused";
  if (jira.enabled !== true) return "loading";
  if (jira.write === false) return "shadow";
  return jira.write === true ? "live" : "loading";
}

export function jiraMoveHint(from: string, to: string, jira: JiraTaskState | null): string {
  const state = to as TaskDetail["state"];
  const label = STATE_LABEL[state];
  const mode = jiraSyncMode(jira);
  if (mode === "loading")
    return `Moves this task to ${label} in Hive; Jira sync state is still loading, so its Jira effect is unknown.`;
  if (mode === "invalid")
    return `Moves this task to ${label} in Hive; the Jira config is invalid, so no cycle runs and Jira will not change.`;
  if (mode === "unconfigured")
    return `Moves this task to ${label} in Hive; Jira sync is unconfigured or not allow-listed, so Jira will not change.`;
  if (mode === "paused")
    return `Moves this task to ${label} in Hive; Jira sync is paused, so no Jira cycle will run.`;
  if (from === "in_review" && state === "verifying")
    return `Moves this task to ${label}; Jira stays at In Review, so no Jira change is needed.`;
  if (from === "needs_decision" && state !== "needs_decision")
    return mode === "shadow"
      ? `Moves this task to ${label}; shadow mode logs removal of the Jira needs-decision label but does not send it.`
      : `Moves this task to ${label}; Jira keeps its status and removes the needs-decision label on the next sync.`;
  if (state === "failed" || state === "cancelled")
    return `Moves this task to ${label} in Hive only; Jira will not change.`;
  if (state === "needs_decision")
    return mode === "shadow"
      ? `Moves this task to ${label}; shadow mode logs the Jira needs-decision label but does not add it.`
      : `Moves this task to ${label}; Jira keeps its status and gains the needs-decision label.`;
  const jiraStatus = state === "queued" ? "To Do" : state === "in_progress" ? "In Progress" : state === "done" ? "Done" : "In Review";
  if (mode === "shadow")
    return `Moves this task to ${label}; shadow mode logs Jira status ${jiraStatus} but does not send it.`;
  return `Moves this task to ${label} and sets Jira to ${jiraStatus} on the next sync.`;
}

export function jiraMoveSummary(from: string, jira: JiraTaskState | null): string {
  const mode = jiraSyncMode(jira);
  if (mode === "loading") return "Jira sync state is still loading; move effects in Jira are not known yet.";
  if (mode === "invalid") return "The Jira config is invalid, so no cycle will run; moves stay in Hive.";
  if (mode === "unconfigured") return "Jira sync is unconfigured or not allow-listed; moves stay in Hive.";
  if (mode === "paused") return "Jira sync is paused; no automatic cycle will send these moves.";
  if (mode === "shadow") return from === "needs_decision"
    ? "Shadow mode logs removal of the Jira needs-decision label for every move out of this state, but sends nothing."
    : "Shadow mode logs mapped status and label changes without sending them; Hive-only moves never change Jira.";
  return from === "needs_decision"
    ? "Mapped moves sync Jira; every move out of Needs decision also removes its Jira label."
    : "Mapped moves sync Jira; Needs decision changes only its label; Failed and Cancelled stay Hive-only.";
}

export function jiraPanelNotice(jira: JiraTaskState | null): string | null {
  const mode = jiraSyncMode(jira);
  if (mode === "loading") return "Jira sync state is still loading.";
  // The error box below names the invalid setting, so a generic notice here
  // would only say the same thing twice.
  if (mode === "invalid") return null;
  if (mode === "unconfigured") return "Jira sync is unconfigured or not allow-listed, so no cycle will run.";
  if (mode === "paused") return "Jira sync is paused, so no cycle will run.";
  if (mode === "shadow") return "Shadow mode: hive computes and logs every outbound change but sends none.";
  return null;
}

export function jiraNextAutomaticText(jira: JiraTaskState | null): string {
  const mode = jiraSyncMode(jira);
  if (mode === "loading") return "sync state loading";
  if (mode === "invalid") return "off (config invalid)";
  if (mode === "unconfigured") return "not configured";
  if (mode === "paused") return "paused (sync disabled)";
  return jira?.sync?.next_due_at ? relTime(jira.sync.next_due_at) : "—";
}

export function trackingBindingNotice(task: TaskDetail): string | null {
  if (!isTrackingOnly(task) || (!task.agent_target && !task.worktree_path && !task.branch)) return null;
  const location = task.worktree_path ?? task.branch ?? task.agent_target;
  return `Inspect the preserved work at ${location} before cancelling; terminal tasks can then use cleanup.`;
}

export function JiraPanel({
  task,
  jira,
  onSynced,
}: {
  task: TaskDetail;
  jira: JiraTaskState | null;
  onSynced: (s: JiraTaskState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const key = jira?.issue_key ?? task.jira_key ?? String(task.source_ref ?? "").replace(/^jira:/, "");
  const sync = jira?.sync;
  const pending = jira?.pending;
  const pendingTotal = (pending?.comments ?? 0) + (pending?.receipts ?? 0);
  const unknown = pending?.unknown ?? [];
  const configError = jira?.config_error ?? null;
  const failing = !!configError || ((sync?.consecutive_failures ?? 0) > 0 && !!sync?.last_error);
  const modeNotice = jiraPanelNotice(jira);

  const retry = async () => {
    setBusy(true);
    try {
      const r = await api.jiraSync(task.id);
      toast(r.ok ? "Synced with Jira" : `Sync failed: ${r.error ?? "unknown error"}`);
      onSynced(await api.jira(task.id));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resolveUnknown = async (action: "comment_push" | "receipt", sourceId: string) => {
    setResolving(sourceId);
    try {
      onSynced(await api.jiraResolveDelivery(task.id, action, sourceId));
      toast("Jira delivery marked resolved");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setResolving(null);
    }
  };

  return (
    <section className="panel jira-panel">
      <h2>Jira</h2>

      {jira?.browse_url ? (
        <a className="pr pr-lg" href={jira.browse_url} target="_blank" rel="noreferrer" title={`Open ${key} in Jira`}>
          Open {key} in Jira ↗
        </a>
      ) : (
        <div className="muted">{key || "linked ticket"}</div>
      )}

      <dl className="jira-facts">
        <dt>Assignee</dt>
        <dd>{jira?.assignee ?? <span className="muted">unassigned</span>}</dd>
        <dt>Last synced</dt>
        <dd>{sync?.last_success_at ? relTime(sync.last_success_at) : <span className="muted">never</span>}</dd>
        <dt>Next automatic</dt>
        <dd>{jiraNextAutomaticText(jira)}</dd>
        <dt>Unresolved outbound</dt>
        <dd>
          {pendingTotal === 0 ? (
            <span className="muted">nothing unresolved</span>
          ) : (
            <span className="chip chip-pending">
              {pending?.comments ? `${pending.comments} comment${pending.comments > 1 ? "s" : ""}` : ""}
              {pending?.comments && pending?.receipts ? ", " : ""}
              {pending?.receipts ? `${pending.receipts} report/evidence` : ""}
            </span>
          )}
        </dd>
      </dl>

      {(jira?.linked_subtasks?.length ?? 0) > 0 && (
        <div>
          <strong>Linked sub-tasks</strong>
          <ul className="breakdown">
            {jira!.linked_subtasks!.map((subtask) => (
              <li key={subtask.id}>
                <StatusDot state={subtask.state} />
                <Link to={`/tasks/${subtask.id}`}>{subtask.display_id} · {subtask.title}</Link>
                {subtask.browse_url ? (
                  <a className="chip chip-jira" href={subtask.browse_url} target="_blank" rel="noreferrer">{subtask.jira_key} ↗</a>
                ) : (
                  <span className="chip chip-jira">{subtask.jira_key}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unknown.length > 0 && (
        <div className="jira-error" role="alert">
          <strong>Delivery outcome unknown</strong>
          <p>Jira can accept a comment after Hive stops waiting. Hive will not retry because Jira does not enforce idempotency-key uniqueness. Check Jira, then resolve the item here.</p>
          <ul>
            {unknown.map((item) => (
              <li key={`${item.action}:${item.source_id}`}>
                <span className="chip">{item.action === "receipt" ? "report/evidence" : "comment"}</span>{" "}
                <span className="muted">{item.text || item.error || item.source_id}</span>{" "}
                <button
                  className="btn btn-mini"
                  onClick={() => resolveUnknown(item.action, item.source_id)}
                  disabled={resolving === item.source_id}
                >
                  {resolving === item.source_id ? "Resolving…" : "I checked Jira · resolve"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {modeNotice && <p className="muted">{modeNotice}</p>}

      {/* A failure stays on screen until a later attempt actually succeeds. */}
      {failing && (
        <div className="jira-error" role="alert">
          <strong>{configError ? "Jira config invalid" : "Sync failing"}</strong>
          <p>{configError ?? sync?.last_error}</p>
          <p className="muted">
            {configError ? (
              "The automatic sync is off until this is fixed. Sync now returns the same error."
            ) : (
              <>
                {sync?.consecutive_failures} consecutive failure{(sync?.consecutive_failures ?? 0) > 1 ? "s" : ""}
                {sync?.last_error_at ? ` \u00b7 since ${relTime(sync.last_error_at)}` : ""}
              </>
            )}
          </p>
        </div>
      )}

      {/* Manual retry runs the SAME cycle the timer runs: a way to go sooner,
          never a second code path that could succeed while the real one fails. */}
      <button className="btn btn-mini" onClick={retry} disabled={busy}>
        {busy ? "Syncing\u2026" : failing ? "Retry sync now" : "Sync now"}
      </button>

      {/* Delivery receipts: proof hive's reports and comments reached Jira, so
          nobody re-sends something that already landed. */}
      {!!jira?.delivered?.length && (
        <div className="jira-receipts">
          <h3>Delivered to Jira</h3>
          <ul>
            {jira.delivered.map((d, i) => (
              <li key={i}>
                <span className="chip">{String(d.action) === "receipt" ? "report/evidence" : "comment"}</span>{" "}
                {d.jira_comment_id ? <span className="muted">#{String(d.jira_comment_id)}</span> : null}
                {d.recovered ? <span className="muted"> &middot; receipt recovered</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// board modal (see App.tsx / views/TaskModal.tsx).
export function TaskBody({ id }: { id: string }) {
  const { rev, projects, tasks, quizzes, reloadQuizzes } = useStore();
  const lightbox = useLightbox();
  const [t, setT] = useState<TaskDetail | null>(null);
  const [jira, setJira] = useState<JiraTaskState | null>(null);
  const [err, setErr] = useState<string>("");
  const [steer, setSteer] = useState("");
  const [steerFiles, setSteerFiles] = useState<File[]>([]);
  const [planning, setPlanning] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const refresh = () => api.task(id).then(setT).catch(() => {});

  useEffect(() => {
    let live = true;
    api
      .task(id)
      .then((d) => live && setT(d))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [id, rev[id]]);

  // Sync state for a mirrored Jira ticket. Re-polled on a short timer as well as
  // on task changes, because "last synced 40s ago" is only reassuring if the
  // number actually moves — a frozen timestamp is what makes people re-submit.
  useEffect(() => {
    let live = true;
    const load = () => {
      api
        .jira(id)
        .then((d) => live && setJira(d))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, rev[id]]);

  if (err) return <div className="pad">Task not found: {err}</div>;
  if (!t) return <div className="pad">Loading…</div>;

  const project = projects.find((p) => p.id === t.project_id);
  const timeline = buildTimeline(t.events, t.decisions);
  const openDecisions = t.decisions.filter((d) => d.status === "open");
  const pastDecisions = t.decisions.filter((d) => d.status !== "open");
  const children = isTrackingOnly(t) ? trackedSubtasks(t, tasks) : tasks.filter((x) => x.parent_task_id === t.id);
  const parent = t.parent_task_id ? tasks.find((x) => x.id === t.parent_task_id) : undefined;
  // Attached files live in the brief as absolute paths (that's what the agent
  // reads); show them as a gallery instead and keep the paths out of the prose.
  const { body: briefBody, files: attachments } = splitAttachments(t.brief);
  const isJira = String(t.source_ref ?? "").startsWith("jira:");
  const trackingOnly = isTrackingOnly(t);
  const jiraMirror = isJiraMirror(t);
  const codeReview = t.state === "in_review" && !trackingOnly;
  const bindingNotice = trackingBindingNotice(t);
  // ReviewCard already renders the quiz for in_review; this covers the states
  // the API also accepts answers in (verifying/done/failed) where no review
  // card exists — the task page used to hide a quiz the Understanding column
  // still counted as pending (hive-1028).
  const postShipQuiz = !codeReview ? quizzes.find((q) => q.task_id === t.id) : undefined;

  const doTransition = async (to: string) => {
    try {
      await api.transition(t.id, to as TaskDetail["state"]);
      toast(`→ ${STATE_LABEL[to as TaskDetail["state"]]}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const sendSteer = async () => {
    if (!steer.trim()) return;
    try {
      const r = await api.send(t.id, steer, steerFiles);
      // Never a bare "sent" — a queued steer that read as delivered is what made
      // the director re-send the same message three times.
      const files = r.attachments?.length ? ` with ${r.attachments.length} file(s)` : "";
      toast(
        isJira
          ? "Comment queued for Jira"
          : r.delivered
          ? `Steer delivered${files}`
          : r.delivery === "failed"
            ? `Steer undelivered: ${r.error || "task is finished"}`
            : `No live agent — steer queued for the next spawn${files}`
      );
      setSteer("");
      setSteerFiles([]);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const planBreakdown = async () => {
    if (planning) return;
    setPlanning(true);
    try {
      const r = await api.plan(t.id);
      toast(r.ok ? "Breakdown proposed — answer in Decisions" : `Planner failed: ${r.error}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };
  // Done tasks only: the endpoint 409s otherwise, and the button is hidden.
  const promoteToPlaybook = async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      const r = await api.playbook(t.id);
      toast(`Playbook saved: ${r.playbook.title}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setPromoting(false);
    }
  };
  const dispatch = async () => {
    if (!t) return;
    try {
      await api.spawn(t.id);
      toast("Agent dispatched");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const viewAgent = async () => {
    try {
      const r = await api.focusAgent(t.id);
      toast(r.ok ? "Focused agent tab in herdr" : `Can't focus: ${r.error}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const nudge = async () => {
    try {
      const r = await api.send(t.id, "hive: status? Reply with what you just did / are doing, or what's blocking you.");
      // Same reasoning as sendSteer: a bare "sent" toast would lie when the
      // agent is dead (hive-1097) — report the actual delivery outcome.
      toast(
        r.delivered
          ? "Status nudge delivered"
          : r.delivery === "failed"
          ? `Nudge undelivered: ${r.error || "task is finished"}`
          : "No live agent — nudge queued for the next spawn"
      );
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const failRequeue = async () => {
    try {
      await api.requeue(t.id);
      toast("Failed & requeued as a fresh task");
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const health = t.health;
  // A review has already left the agent's hands. A gone worker is expected at
  // this point, not a recovery action for the director.
  const unhealthy = !codeReview && health && health.status !== "healthy";

  return (
    <div className={`task ${codeReview ? "task-reviewing" : ""}`}>
      <div className="task-main">
        <div className="crumbs">
          <Link to="/work">← Work</Link>
          {parent && (
            <>
              {" · "}
              <Link to={`/tasks/${parent.id}`}>↰ Parent: {parent.title}</Link>
            </>
          )}
        </div>
        {!codeReview && (
          <>
            <h1 className="task-title">
              <StatusDot state={t.state} health={t.health} />{" "}
              <TaskRef task={t} self className="task-num" /> {t.title}
            </h1>
            <div className="task-sub">
              {project && <span className="chip">{project.name}</span>}
              <span className={`chip chip-kind chip-${t.kind}`}>{t.kind}</span>
              <span className="chip">{STATE_LABEL[t.state]}</span>
              <span className="task-prio">
                Priority <PriorityChip task={t} />
              </span>
              {/* At a glance: this row IS a Jira ticket, and one click opens it.
                  The link used to be plain text buried in the brief. */}
              {(isJira || t.jira_key) && (
                jira?.browse_url ? (
                  <a className="chip chip-jira" href={jira.browse_url} target="_blank" rel="noreferrer" title="Open this ticket in Jira">
                    {jira.issue_key} ↗
                  </a>
                ) : (
                  <span className="chip chip-jira">{t.jira_key ?? String(t.source_ref ?? "").replace(/^jira:/, "")}</span>
                )
              )}
              <BlockedBy depends_on={t.depends_on} tasks={tasks} />
              {t.duplicate_of && (
                <Link
                  className="chip chip-duplicate"
                  to={`/tasks/${t.duplicate_of}`}
                  title="This task was cancelled as a duplicate; open the task it was folded into"
                >
                  ⧉ duplicate of {tasks.find((x) => x.id === t.duplicate_of)?.title ?? `#${t.duplicate_of}`}
                </Link>
              )}
              <UsageLine id={t.id} rev={rev[t.id] || 0} />
            </div>
          </>
        )}

        {unhealthy && (
          <div className={`health-banner banner-${health!.status}`}>
            <div className="health-banner-text">
              <strong>{HEALTH_LABEL[health!.status]}</strong>
              {health!.reason ? ` — ${health!.reason}` : ""} · since {relTime(health!.since)}
            </div>
            <div className="health-banner-actions">
              {!jiraMirror && t.agent_target && (
                <button className="btn btn-mini" onClick={viewAgent}>
                  View agent
                </button>
              )}
              {!jiraMirror && t.agent_target && (
                <button className="btn btn-mini" onClick={nudge}>
                  Nudge
                </button>
              )}
              {!trackingOnly && (
                <button className="btn btn-mini btn-danger" onClick={failRequeue}>
                  Fail + requeue
                </button>
              )}
            </div>
          </div>
        )}

        {bindingNotice && (
          <div className="health-banner banner-stuck" role="alert">
            <div className="health-banner-text">
              <strong>Legacy Hive work attached</strong> — {bindingNotice}
            </div>
          </div>
        )}

        {codeReview && <ReviewCard task={t} onDone={refresh} />}

        {postShipQuiz && (
          <section className="panel understanding-quiz-panel">
            <h2>Understanding check</h2>
            <details className="review-details" open>
              <summary>
                <span>{postShipQuiz.task_kind === "scout" ? "Explain report" : "Understand this change"}</span>
                <small>Read before answering</small>
              </summary>
              <div className="review-details-body">
                {postShipQuiz.report.understanding && (
                  <ReviewUnderstanding
                    packet={postShipQuiz.report.understanding}
                    report={postShipQuiz.task_kind === "scout"}
                    caveats={postShipQuiz.report.iffy}
                  />
                )}
                <ReviewAudit r={postShipQuiz.report} />
              </div>
            </details>
            {/* no allowDefer/onDeferred: done/failed tasks block nothing, so there's no approval to unlock early */}
            <UnderstandingQuiz quiz={postShipQuiz} label="Confirm you understood the change" onPassed={reloadQuizzes} />
          </section>
        )}

        {!codeReview && <CheckpointList events={t.events} />}

        <section className="panel">
          <h2>Brief</h2>
          <pre className="brief">{briefBody || "(no brief)"}</pre>
        </section>

        {attachments.length > 0 && (() => {
          // Attached images share one lightbox set, same as evidence.
          const imgs = attachments.filter((a) => a.image);
          const lb: LightboxImage[] = imgs.map((a) => ({ url: a.url, caption: a.name, taskId: t.id, taskTitle: t.title }));
          return (
            <section className="panel">
              <h2>Attachments ({attachments.length})</h2>
              <div className="ev-gallery">
                {attachments.map((a) =>
                  a.image ? (
                    <button key={a.path} className="ev-img" title={a.name} onClick={() => lightbox.open(lb, imgs.indexOf(a))}>
                      <img src={a.url} alt={a.name} />
                      <span className="ev-cap">{a.name}</span>
                    </button>
                  ) : (
                    <div key={a.path} className="ev-card">
                      <a className="ev-card-link" href={a.url} target="_blank" rel="noreferrer">
                        <div className="ev-card-head">
                          <span className="chip chip-kind">file</span>
                          <span className="ev-cap">{a.name}</span>
                        </div>
                      </a>
                    </div>
                  )
                )}
              </div>
            </section>
          );
        })()}

        {!jiraMirror && t.agent_target && !["done", "cancelled", "failed"].includes(t.state) && <PaneTerminal taskId={t.id} />}

        {children.length > 0 && (
          <section className="panel">
            <h2>Breakdown ({children.length})</h2>
            <ul className="breakdown">
              {children.map((c) => (
                <li key={c.id}>
                  <StatusDot state={c.state} />
                  <Link to={`/tasks/${c.id}`}>{c.title}</Link>
                  <span className={`chip chip-kind chip-${c.kind}`}>{c.kind}</span>
                  <span className="chip">{STATE_LABEL[c.state]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(openDecisions.length > 0 || pastDecisions.length > 0) && (
          <section className="panel">
            <h2>Decisions</h2>
            {/* Open cards are ANSWERABLE here — radios + note + submit, the same
                component as the inbox, so nobody is bounced to another page. */}
            {openDecisions.map((d) => (
              <DecisionCard key={d.id} d={d} onDone={() => refresh()} />
            ))}
            {pastDecisions.map((d) => (
              <DecisionMini key={d.id} d={d} />
            ))}
          </section>
        )}

        {t.evidence.length > 0 && (() => {
          // Image evidence forms one lightbox set; each thumbnail opens at its
          // own position so the arrows walk the whole task's images.
          const imgs = t.evidence.filter((e) => e.kind === "screenshot" && e.url);
          const lb: LightboxImage[] = imgs.map((e) => ({
            url: e.url!,
            caption: e.caption,
            taskId: t.id,
            taskTitle: t.title,
            ts: e.ts,
          }));
          return (
            <section className="panel">
              <h2>Evidence ({t.evidence.length})</h2>
              <div className="ev-gallery">
                {t.evidence.map((e) => (
                  <EvidenceItem
                    key={e.id}
                    e={e}
                    onOpen={
                      e.kind === "screenshot" && e.url
                        ? () => lightbox.open(lb, imgs.findIndex((x) => x.id === e.id))
                        : undefined
                    }
                  />
                ))}
              </div>
            </section>
          );
        })()}

        <section className="panel">
          <h2>Timeline</h2>
          <ul className="timeline">
            {timeline.map((it) => (
              <TimelineRow key={it.id} it={it} />
            ))}
          </ul>
        </section>
      </div>

      {!codeReview && <aside className="task-side">
        {/* A mirrored Jira ticket is tracking-only: hive never builds it, so
            there is no branch, no PR and no CI to report. Showing "No PR yet"
            there reads as work pending rather than work that will never exist. */}
        {(isJira || t.jira_key) ? (
          <JiraPanel task={t} jira={jira} onSynced={setJira} />
        ) : !trackingOnly ? (
          <section className="panel">
            <h2>PR / CI</h2>
            {t.pr_url ? (
              <PrReference className="pr pr-lg" url={t.pr_url} label={`View ${prLabel(t.pr_url)} ↗`} />
            ) : (
              <div className="muted">No PR yet</div>
            )}
            <div className="ci-row">
              <CiBadge status={t.ci_status} />
            </div>
          </section>
        ) : null}

        {t.summary && (
          <section className="panel">
            <h2>Summary</h2>
            <p>{t.summary}</p>
          </section>
        )}

        {/* One primary per view. A queued task's one obvious action is to
            dispatch it; for anything already running it's to steer it. Every
            other control here is neutral, and only the destructive transitions
            (cancel / fail) get danger styling. */}
        {(() => {
          // Two separate reasons the steer box has nothing to reach, and they
          // are NOT the same question. A never-dispatched external task (see
          // supervision.ts) has no agent yet but a manual dispatch could still
          // give it one. A tracking-only task never gets one at all. Jira is
          // the exception in both cases: the box posts a COMMENT to the ticket,
          // which always delivers, so it stays.
          const undispatchable = (!!t.never_dispatched || jiraMirror) && !isJira;
          const dispatchIsPrimary = t.state === "queued" && !isJira && !jiraMirror && !t.never_dispatched;
          return (
            <section className="panel">
              <h2>Actions</h2>
              {!undispatchable && (
                <div className="steer">
                  {isJira ? (
                    <textarea
                      placeholder="Add a Jira comment…"
                      value={steer}
                      onChange={(e) => setSteer(e.target.value)}
                    />
                  ) : (
                    <Attach files={steerFiles} onChange={setSteerFiles}>
                      <textarea
                        placeholder="Steer message to the agent…"
                        value={steer}
                        onChange={(e) => setSteer(e.target.value)}
                      />
                    </Attach>
                  )}
                  <button className={`btn ${dispatchIsPrimary ? "" : "btn-primary"}`} onClick={sendSteer}>
                    {isJira ? "Comment in Jira" : "Send steer"}
                  </button>
                </div>
              )}
              {!jiraMirror && t.agent_target && (
                <button className="btn" onClick={viewAgent} title="Focus this agent's tab in herdr">
                  View agent
                </button>
              )}
              {dispatchIsPrimary && (
                <button className="btn btn-primary" onClick={dispatch}>
                  Dispatch now
                </button>
              )}
              {!trackingOnly && (
                <button className="btn" onClick={planBreakdown} disabled={planning}>
                  {planning ? "Planning…" : "Plan breakdown"}
                </button>
              )}
              {t.state === "done" && (
                <button
                  className="btn"
                  onClick={promoteToPlaybook}
                  disabled={promoting}
                  title="Distil this finished task into a reusable playbook, saved under References"
                >
                  {promoting ? "Distilling…" : "Promote to playbook"}
                </button>
              )}
              {t.state === "done" && !trackingOnly && <RequestChanges taskId={t.id} />}
              <div className="transitions">
                {(NEXT[t.state] || []).filter((to) => !(trackingOnly && t.state === "failed" && to === "queued")).map((to) => (
                  <button
                    key={to}
                    className={`btn ${to === "cancelled" || to === "failed" ? "btn-danger" : ""}`}
                    onClick={() => doTransition(to)}
                    title={isJira ? jiraMoveHint(t.state, to, jira) : undefined}
                  >
                    {STATE_LABEL[to]}
                  </button>
                ))}
              </div>
              {/* Moving a linked ticket writes to Jira. Saying so on the control
                  itself is the difference between a deliberate action and a
                  surprise a colleague notices in their ticket feed. */}
              {isJira && (
                <p className="muted jira-move-note">
                  {jiraMoveSummary(t.state, jira)}
                </p>
              )}
            </section>
          );
        })()}
      </aside>}
    </div>
  );
}
