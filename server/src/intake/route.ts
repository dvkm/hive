// Braindump project routing.
//
// A braindump arrives with a project_id from the caller (the web picker defaults
// to whatever project is in view — often the wrong one). Before filing, we score
// the raw text against every registered project's identifying signals and
// re-route to a better match when one clearly wins. This is what stops an
// acme braindump (a Figma link, "AcmeData", "acme") from landing in the
// hive repo where the spawned agent can only read, not act.
//
// Signals per project (all case-insensitive):
//   - the project NAME (word-boundary match, e.g. \bacme\b)
//   - the repo_path basename (word-boundary)
//   - config.intake_keywords: string[] — director-registered domains / links /
//     keywords the braindump might mention (e.g. "acmedata", "figma.com/file/…",
//     "acme.io"), matched as plain substrings so URLs and dotted hosts work.
//
// ponytail: pure keyword scoring, no LLM. Re-routes ONLY when another project
// STRICTLY out-scores the requested one; ties or zero matches keep the caller's
// pick (never worse than today). Ambiguous multi-match could open a decision
// card to ask — the done criterion allows "(or asks)" — but the heuristic
// covers the known case; add the ask path if mis-routes show up.
import type { DB } from "../db.ts";
import { basename } from "node:path";

export interface RouteResult {
  project_id: string; // where the braindump should be filed
  rerouted: boolean; // true when it differs from the requested project
  matched: string[]; // the signals that won (for the audit note)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Distinct signals from `signals` that appear in `text`. `word` signals must hit
// a word boundary (short names like "hive" shouldn't match inside other words);
// non-`word` signals (keywords/URLs) match as substrings.
function hits(text: string, signals: { value: string; word: boolean }[]): string[] {
  const found: string[] = [];
  for (const s of signals) {
    const v = s.value.trim().toLowerCase();
    if (!v) continue;
    const hit = s.word
      ? new RegExp(`\\b${escapeRegExp(v)}\\b`).test(text)
      : text.includes(v);
    if (hit) found.push(s.value);
  }
  return found;
}

// Score every project's signals against the braindump and pick the best match.
// Returns the requested project unchanged unless a DIFFERENT project strictly
// out-scores it.
export function routeIntakeProject(db: DB, text: string, requestedId: string): RouteResult {
  const lower = text.toLowerCase();
  const projects = db
    .query("SELECT id, name, repo_path, config FROM projects")
    .all() as { id: string; name: string; repo_path: string | null; config: string }[];

  let best: { id: string; matched: string[] } | null = null;
  let tied = false; // two projects share the top positive score → ambiguous
  let requestedScore = 0;

  for (const p of projects) {
    let cfg: any = {};
    try {
      cfg = JSON.parse(p.config || "{}");
    } catch {
      cfg = {};
    }
    const signals: { value: string; word: boolean }[] = [{ value: p.name, word: true }];
    if (p.repo_path) signals.push({ value: basename(p.repo_path), word: true });
    const kws = Array.isArray(cfg.intake_keywords) ? cfg.intake_keywords : [];
    for (const k of kws) if (typeof k === "string") signals.push({ value: k, word: false });

    const matched = hits(lower, signals);
    if (p.id === requestedId) requestedScore = matched.length;
    if (matched.length === 0) continue;
    if (!best || matched.length > best.matched.length) {
      best = { id: p.id, matched };
      tied = false;
    } else if (matched.length === best.matched.length) {
      tied = true;
    }
  }

  // Keep the caller's pick unless a single project strictly beats it.
  if (!best || tied || best.id === requestedId || best.matched.length <= requestedScore)
    return { project_id: requestedId, rerouted: false, matched: [] };
  return { project_id: best.id, rerouted: true, matched: best.matched };
}
