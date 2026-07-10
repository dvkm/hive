import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { AnalyticsSummary, UsageTotals } from "../lib/api";
import { useStore } from "../lib/store";

type Window = "24h" | "7d" | "30d" | "all";
const WINDOWS: Window[] = ["24h", "7d", "30d", "all"];
const HOURS: Record<Window, number | null> = { "24h": 24, "7d": 168, "30d": 720, all: null };

export function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export default function Analytics() {
  const { projects, rev } = useStore();
  const [win, setWin] = useState<Window>("7d");
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [err, setErr] = useState("");

  const since = useMemo(() => {
    const h = HOURS[win];
    return h == null ? undefined : new Date(Date.now() - h * 3600_000).toISOString();
  }, [win]);

  // rev is a Record; changes when any task is touched (incl. a usage SSE). We
  // only need "something changed" — sum the values to get a stable dep.
  const revSum = Object.values(rev).reduce((a, b) => a + b, 0);
  useEffect(() => {
    let live = true;
    api
      .analyticsSummary(since)
      .then((d) => live && (setData(d), setErr("")))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [since, revSum]);

  if (err) return <div className="pad">Analytics unavailable: {err}</div>;
  if (!data) return <div className="pad">Loading…</div>;

  const t = data.totals;
  const projName = (id: string) => projects.find((p) => p.id === id)?.name || id;

  return (
    <div className="analytics">
      <div className="an-head">
        <h2>Cost &amp; tokens</h2>
        <div className="an-windows">
          {WINDOWS.map((w) => (
            <button key={w} className={`an-win ${w === win ? "on" : ""}`} onClick={() => setWin(w)}>
              {w === "all" ? "All" : w}
            </button>
          ))}
        </div>
      </div>

      <div className="an-tiles">
        <Tile label="Total spend" value={fmtUsd(t.cost_usd)} sub={t.unpriced > 0 ? `${t.unpriced} unpriced` : undefined} />
        <Tile label="Total tokens" value={fmtTokens(t.total_tokens)} sub={`${t.calls} calls`} />
        <Tile label="Input" value={fmtTokens(t.input_tokens)} />
        <Tile label="Output" value={fmtTokens(t.output_tokens)} />
        <Tile label="Cache read" value={fmtTokens(t.cache_read_tokens)} />
        <Tile label="Cache write" value={fmtTokens(t.cache_write_tokens)} />
      </div>

      {t.calls === 0 && <div className="muted pad">No usage recorded in this window.</div>}

      {data.by_model.length > 0 && (
        <section className="panel an-panel">
          <h3>By model</h3>
          <UsageTable
            rows={data.by_model}
            maxCost={Math.max(...data.by_model.map((r) => r.cost_usd), 0.0001)}
            first={(r) => (
              <span className="an-model">
                {r.model} {r.unpriced > 0 && <span className="chip an-unpriced">unpriced</span>}
              </span>
            )}
          />
        </section>
      )}

      {data.by_project.length > 0 && (
        <section className="panel an-panel">
          <h3>By project</h3>
          <UsageTable
            rows={data.by_project}
            maxCost={Math.max(...data.by_project.map((r) => r.cost_usd), 0.0001)}
            first={(r) => projName((r as any).project_id)}
          />
        </section>
      )}

      {data.top_tasks.length > 0 && (
        <section className="panel an-panel">
          <h3>Most expensive tasks</h3>
          <UsageTable
            rows={data.top_tasks}
            maxCost={Math.max(...data.top_tasks.map((r) => r.cost_usd), 0.0001)}
            first={(r) => (
              <Link to={`/tasks/${(r as any).task_id}`} className="an-link">
                {(r as any).title}
              </Link>
            )}
          />
        </section>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="an-tile">
      <div className="an-tile-val">{value}</div>
      <div className="an-tile-label">{label}</div>
      {sub && <div className="an-tile-sub">{sub}</div>}
    </div>
  );
}

function UsageTable<T extends UsageTotals>({
  rows,
  maxCost,
  first,
}: {
  rows: T[];
  maxCost: number;
  first: (r: T) => React.ReactNode;
}) {
  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <thead>
          <tr>
            <th></th>
            <th className="num">Cost</th>
            <th className="num">Tokens</th>
            <th className="num">Input</th>
            <th className="num">Output</th>
            <th className="num">Cache</th>
            <th className="num">Calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="an-first">
                {first(r)}
                <span className="an-bar" style={{ width: `${(r.cost_usd / maxCost) * 100}%` }} />
              </td>
              <td className="num strong">{fmtUsd(r.cost_usd)}</td>
              <td className="num">{fmtTokens(r.total_tokens)}</td>
              <td className="num dim">{fmtTokens(r.input_tokens)}</td>
              <td className="num dim">{fmtTokens(r.output_tokens)}</td>
              <td className="num dim">{fmtTokens(r.cache_read_tokens + r.cache_write_tokens)}</td>
              <td className="num dim">{r.calls}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
