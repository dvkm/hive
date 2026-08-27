// Deployments: what is live in production, what is waiting on the branch, and
// the two buttons that move it.
//
// Both buttons run GitHub workflows through the hive server, which holds the
// GitHub credential. The browser only ever names a commit or a release tag.
// Pressing either needs the hive API token, so the server 401s and the shared
// api helper prompts for it — that prompt is the confirmation of last resort on
// top of the typed one below.
//
// A project appears here only if it has a config.deployments block.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DeploymentsStatus, Project, Release } from "../lib/api";
import { useStore } from "../lib/store";
import { useProjectFilter, inProjectFilter } from "../lib/projectFilter";
import { relTime } from "../lib/time";
import { Empty, toast } from "../lib/ui";

// A production change is worth a deliberate pause, so the confirm asks for the
// release name to be typed rather than accepting a stray Enter on a dialog.
function Confirm({
  title,
  detail,
  phrase,
  onCancel,
  onConfirm,
}: {
  title: string;
  detail: string;
  phrase: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="dep-confirm-detail">{detail}</p>
        <label className="fld">
          <span>
            Type <code>{phrase}</code> to confirm
          </span>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="modal-foot">
          <div className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-danger" disabled={typed.trim() !== phrase} onClick={onConfirm}>
            {title}
          </button>
        </div>
      </div>
    </div>
  );
}

type Pending = { kind: "deploy"; commit: string; label: string } | { kind: "rollback"; release: Release };

function ProjectDeployments({ project }: { project: Project }) {
  const [status, setStatus] = useState<DeploymentsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(() => {
    api
      .deployments(project.id)
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(String(e.message || e)));
  }, [project.id]);

  useEffect(load, [load]);

  const run = async (p: Pending) => {
    setPending(null);
    setBusy(true);
    try {
      const r =
        p.kind === "deploy" ? await api.deploy(project.id, p.commit) : await api.rollback(project.id, p.release.tag);
      toast(`Started ${r.workflow} on ${r.ref}. Watch it in the runs list below.`);
      // GitHub takes a moment to register the run, so the refresh is delayed
      // rather than immediate — otherwise the list looks like nothing happened.
      setTimeout(load, 4000);
    } catch (e: any) {
      toast(`Could not start it: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="notice">{project.name}: {error}</div>;
  if (!status) return <div className="muted pad">Reading {project.name} releases…</div>;

  const { current, head, ahead, health, flags, releases, runs } = status;
  const upToDate = ahead === 0;

  return (
    <section className="panel dep-project">
      <div className="dep-head">
        <h2>{project.name}</h2>
        {health && (
          <span className={health.ok ? "mon-up" : "mon-down"} title={`${health.url} — ${health.detail}`}>
            ● production {health.ok ? "up" : "down"}
          </span>
        )}
      </div>

      {status.errors.map((e) => (
        <div className="notice" key={e}>
          {e}
        </div>
      ))}

      <div className="dep-now">
        <div className="dep-card">
          <div className="dep-card-label">Live in production</div>
          {current ? (
            <>
              <div className="dep-tag mono">{current.tag}</div>
              <div className="dep-subject">{current.subject}</div>
              <div className="muted" title={current.created_at}>
                {current.short} · released {relTime(current.created_at)}
              </div>
            </>
          ) : (
            <div className="muted">Nothing released yet. The first deploy writes the first tag.</div>
          )}
        </div>

        <div className="dep-card">
          <div className="dep-card-label">Head of {status.branch} (what staging runs)</div>
          {head ? (
            <>
              <div className="dep-tag mono">{head.short}</div>
              <div className="dep-subject">{head.subject}</div>
              <div className="muted">
                {ahead === null
                  ? "Not comparable to the live release."
                  : upToDate
                    ? "Production is on this commit."
                    : `${ahead} commit${ahead === 1 ? "" : "s"} not in production yet.`}
              </div>
            </>
          ) : (
            <div className="muted">Could not read the branch head.</div>
          )}
        </div>
      </div>

      <div className="dep-actions">
        <button
          className="btn btn-primary"
          disabled={busy || !head || upToDate}
          onClick={() =>
            head && setPending({ kind: "deploy", commit: head.sha, label: `${head.short} — ${head.subject}` })
          }
        >
          Deploy {status.branch} to production
        </button>
        {upToDate && <span className="muted">Production already has every commit on {status.branch}.</span>}
      </div>

      {flags.items.length > 0 && (
        <div className="dep-flags">
          <h3>Production feature flags</h3>
          {flags.reason && <div className="notice">{flags.reason}</div>}
          <table className="mon-table">
            <tbody>
              {flags.items.map((f) => (
                <tr key={f.key}>
                  <td className="mono">{f.key}</td>
                  <td>{f.name || ""}</td>
                  <td>
                    {f.active === null ? (
                      <span className="mon-unknown">unknown</span>
                    ) : f.active ? (
                      <span className="mon-up">● on{f.rollout !== null && f.rollout < 100 ? ` (${f.rollout}%)` : ""}</span>
                    ) : (
                      <span className="mon-down">● off</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="dep-releases">
        <h3>Release history</h3>
        {releases.length === 0 ? (
          <div className="muted">No releases yet.</div>
        ) : (
          <table className="mon-table">
            <thead>
              <tr>
                <th>Release</th>
                <th>Commit</th>
                <th>Released</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.tag} className={r.current ? "dep-current" : ""}>
                  <td className="mono">
                    {r.tag}
                    {r.current && <span className="chip">live</span>}
                  </td>
                  <td>
                    <span className="mono">{r.short}</span> {r.subject}
                  </td>
                  <td title={r.created_at}>{relTime(r.created_at)}</td>
                  <td>
                    {!r.current && (
                      <button className="btn" disabled={busy} onClick={() => setPending({ kind: "rollback", release: r })}>
                        Roll back to this
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {runs.length > 0 && (
        <div className="dep-runs">
          <h3>Recent runs</h3>
          {runs.map((r) => (
            <div className="dep-run" key={r.id}>
              <span className={`chip ${r.conclusion === "failure" ? "chip-off" : ""}`}>
                {r.conclusion || r.status}
              </span>
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.name}
              </a>
              <span className="mono muted">{r.head_sha.slice(0, 7)}</span>
              <span className="muted" title={r.created_at}>
                {relTime(r.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}

      {pending?.kind === "deploy" && (
        <Confirm
          title="Deploy to production"
          detail={`This puts ${pending.label} live, applies its migrations, and stamps a new release tag. A migration is not undone by a later rollback.`}
          phrase="deploy"
          onCancel={() => setPending(null)}
          onConfirm={() => run(pending)}
        />
      )}
      {pending?.kind === "rollback" && (
        <Confirm
          title="Roll back production"
          detail={`This puts production back on ${pending.release.tag} (${pending.release.subject}). The database stays on the newer schema. A rollback does not undo a migration.`}
          phrase={pending.release.tag}
          onCancel={() => setPending(null)}
          onConfirm={() => run(pending)}
        />
      )}
    </section>
  );
}

export default function Deployments() {
  const { projects } = useStore();
  const projectFilter = useProjectFilter();
  const configured = projects.filter((p) => p.config?.deployments && inProjectFilter(p.id, projectFilter));

  if (configured.length === 0)
    return (
      <Empty
        title="No project deploys from hive yet"
        hint="Add a `deployments` block to a project's config to get the release list and the deploy button here."
      />
    );

  return (
    <div className="deployments">
      {configured.map((p) => (
        <ProjectDeployments key={p.id} project={p} />
      ))}
    </div>
  );
}
