import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Incident } from "../lib/api";
import { useStore } from "../lib/store";
import { relTime } from "../lib/time";

export default function Monitors() {
  const { projects, projectsLoaded } = useStore();
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    // Incidents API is built in parallel; treat any failure as "not running yet".
    Promise.all([api.incidents("open"), api.incidents("resolved")])
      .then(([o, r]) => setIncidents([...o.incidents, ...r.incidents]))
      .catch(() => setAvailable(false));
  }, []);

  const forProject = (pid: string) =>
    (incidents || [])
      .filter((i) => i.project_id === pid)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));

  return (
    <div className="monitors">
      {!available && (
        <div className="notice">Incidents API not running yet — showing configured monitors only.</div>
      )}
      {projects.length === 0 && projectsLoaded && <div className="muted pad">No projects.</div>}
      {projects.map((p) => {
        const monitors = p.config?.monitors || [];
        const incs = forProject(p.id);
        const openCount = incs.filter((i) => i.status === "open").length;
        return (
          <section className="mon-project panel" key={p.id}>
            <div className="mon-head">
              <h2>{p.name}</h2>
              {openCount > 0 && <span className="chip chip-off">{openCount} open</span>}
            </div>

            {monitors.length === 0 ? (
              <div className="muted">No monitors configured for this project.</div>
            ) : (
              <table className="mon-table">
                <thead>
                  <tr>
                    <th>Monitor</th>
                    <th>URL</th>
                    <th>Expect</th>
                    <th>Interval</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {monitors.map((m) => {
                    const down = incs.some((i) => i.monitor === m.name && i.status === "open");
                    return (
                      <tr key={m.name}>
                        <td>{m.name}</td>
                        <td className="mono">{m.url}</td>
                        <td>{m.expect_status}</td>
                        <td>{m.interval_s}s</td>
                        <td>
                          {!available ? (
                            <span className="mon-unknown">not running yet</span>
                          ) : down ? (
                            <span className="mon-down">● down</span>
                          ) : (
                            <span className="mon-up">● up</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {incs.length > 0 && (
              <div className="incidents">
                <h3>Incident history</h3>
                {incs.map((i) => (
                  <div key={i.id} className={`incident inc-${i.status}`}>
                    <span className="chip">{i.monitor}</span>
                    <span className="inc-detail">{i.detail}</span>
                    <span className="inc-status">{i.status}</span>
                    <span className="inc-age" title={i.ts}>
                      {relTime(i.ts)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {available && incs.length === 0 && <div className="muted">No incidents recorded.</div>}
          </section>
        );
      })}
    </div>
  );
}
