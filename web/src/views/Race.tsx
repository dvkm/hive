import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { RaceAttempt, RaceView } from "../lib/api";
import { STATE_LABEL, toast } from "../lib/ui";
import { fmtTokens, fmtUsd } from "./Analytics";

function cost(a: RaceAttempt): string {
  return a.cost_usd > 0 ? `~${fmtUsd(a.cost_usd)}` : `${fmtTokens(a.processed_tokens)} processed`;
}

function diffText(a: RaceAttempt): string {
  if (!a.diff) return "no branch yet";
  return `${a.diff.files} file${a.diff.files === 1 ? "" : "s"}, +${a.diff.additions} / -${a.diff.deletions}`;
}

// Side-by-side comparison of the attempts in one best-of-N race, with the
// keep-this-one action. Shown on every attempt's task page, so the director
// lands on the comparison whichever attempt they opened.
export function RaceCompare({ raceId, taskId, onPicked }: { raceId: string; taskId: string; onPicked?: () => void }) {
  const [race, setRace] = useState<RaceView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .race(raceId)
      .then(setRace)
      .catch(() => {});
  };
  useEffect(load, [raceId]);

  if (!race) return null;
  const decided = race.attempts.some((a) => a.outcome === "winner");

  const pick = async (a: RaceAttempt) => {
    if (!confirm(`Keep #${a.number} (${a.agent})? The other attempts are cancelled and their agents closed.`)) return;
    setBusy(true);
    try {
      await api.pickRaceWinner(raceId, a.task_id);
      toast(`Kept #${a.number}`);
      load();
      onPicked?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel race-panel">
      <h2>
        Best-of-{race.attempts.length}
        <small className="race-note">
          {decided ? " — winner kept" : race.settled ? " — every attempt is in, pick one" : " — still running"}
        </small>
      </h2>
      <div className="race-grid">
        {race.attempts.map((a) => (
          <div key={a.task_id} className={`race-attempt${a.outcome ? ` race-${a.outcome}` : ""}${a.task_id === taskId ? " race-self" : ""}`}>
            <div className="race-head">
              <Link to={`/tasks/${a.task_id}`} className="race-num">#{a.number}</Link>
              <span className="chip">{a.agent}</span>
              <span className="chip">{STATE_LABEL[a.state]}</span>
              {a.outcome && <span className={`chip chip-${a.outcome}`}>{a.outcome === "winner" ? "kept" : "cancelled"}</span>}
            </div>
            <dl className="race-facts">
              <dt>Diff</dt>
              <dd>{diffText(a)}</dd>
              <dt>Checks</dt>
              <dd>
                {a.verification.length === 0
                  ? "no verification contract"
                  : a.verification.map((v) => (
                      <span key={v.name} className={v.satisfied ? "race-check-ok" : "race-check-miss"}>
                        {v.satisfied ? "✓" : "✗"} {v.name}{" "}
                      </span>
                    ))}
              </dd>
              <dt>Cost</dt>
              <dd>{cost(a)}</dd>
              {a.pr_url && (
                <>
                  <dt>PR</dt>
                  <dd>
                    <a href={a.pr_url} target="_blank" rel="noreferrer">
                      {a.pr_url.replace(/^https:\/\/github\.com\//, "")} ↗
                    </a>
                  </dd>
                </>
              )}
            </dl>
            {!decided && a.state !== "cancelled" && (
              <button className="btn btn-mini" disabled={busy} onClick={() => pick(a)}>
                Keep this one
              </button>
            )}
          </div>
        ))}
      </div>
      {!decided && (
        <p className="race-foot">
          Keeping one cancels the rest. Their branches stay on disk, and any pull request they opened stays open until you close it.
        </p>
      )}
    </section>
  );
}
