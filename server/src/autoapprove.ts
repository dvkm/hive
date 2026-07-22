// Server-enforced auto-approve bar for the chat supervisor (task #364, from the
// #363 scout report). The supervisor may close out SOME decision cards itself
// instead of always waiting on the director — but ONLY the ones this evaluator
// clears. It runs server-side (not as prose in a brief), so a worker hitting the
// endpoint gets the same gate; the caller can't launder an unsafe card through
// it.
//
// The bar is deliberately a CLOSED allow-list. Three intrinsically-reversible
// mechanical categories may auto-approve; everything else — cost caps, PR merges,
// deny-guardrail policy changes, blocked-pane relays, standing-authority command
// grants, plain product questions — routes to the director exactly as today.
//
// Two general backstops sit in front of the allow-list:
//   - only the RAISER's own `recommended` option may be auto-selected (this is
//     also the confidence gate: dedup marks `merge` recommended only above its
//     0.8 similarity threshold, so a weak match never clears);
//   - a pending standing-authority grant is a HARD structural exclusion — the
//     one class the scout flagged as never-auto-approvable by category.
import type { DB } from "./db.ts";

export interface AutoApproveVerdict {
  allow: boolean;
  category: string;
  reason: string;
}

// Blast-radius / target language that always forces a human, whatever the
// category. Mirrors policy.ts's PROD_RE / SHARED_RE intent (task #260).
const PROD_RE = /\b(prod|production|deploy|customer\s*data|live)\b/i;
const SHARED_RE = /\b(migration|schema|infra|pipeline|shared)\b/i;

function hasDecisionEvent(db: DB, type: string, decisionId: string): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM events WHERE type = ? AND json_extract(payload, '$.decision_id') = ? LIMIT 1"
      )
      .get(type, decisionId) != null
  );
}

// `d` is a raw decisions row (options is a JSON string) OR a parsed decision
// (options is an array) — handle both so callers don't have to normalize.
export function evaluateAutoApprove(db: DB, d: any, answerKey: string): AutoApproveVerdict {
  const options: any[] = Array.isArray(d.options) ? d.options : JSON.parse(d.options || "[]");
  const chosen = options.find((o) => o.key === answerKey);
  const no = (category: string, reason: string): AutoApproveVerdict => ({ allow: false, category, reason });

  // Hard structural exclusion: a card gating a dangerous shell-command grant
  // (rm, force-push, sudo, kill, SQL, …). Never auto-approvable, by category —
  // this is the side door the standing-authority gate exists to close.
  if (db.query("SELECT 1 FROM authority_grants WHERE decision_id = ? AND status = 'pending'").get(d.id))
    return no("authority", "gates a standing-authority command grant — always the director's call");

  // Only the raiser's own recommendation may be auto-selected. Doubles as the
  // confidence gate (dedup recommends `merge` only above its similarity bar).
  if (!chosen?.recommended) return no("*", "only the raiser's recommended option can be auto-approved");

  // Never override a card the raiser rated above 'normal'. risk is free-text, so
  // treat anything that isn't explicitly low/normal as excluded (authority cards
  // are always 'high', so this is a second, category-independent backstop).
  // No leading `risk &&`: an absent/blank rating is NOT "low or normal", so it
  // must also escalate. (All three allow-list raisers set risk="normal", so this
  // is behaviour-preserving today; it closes the gap for any future category
  // that forgets to rate itself.)
  const risk = String(d.risk ?? "").toLowerCase();
  if (risk !== "low" && risk !== "normal") return no("*", `risk '${d.risk ?? "(none)"}' is above the auto-approve bar`);

  // Prod / shared-infra blast radius always escalates, whatever the category.
  const blast = String(d.blast_radius ?? "");
  if (PROD_RE.test(blast) || SHARED_RE.test(blast))
    return no("*", "prod/shared blast radius — always the director's call");

  // ---- the closed allow-list ------------------------------------------------
  // Reference capture: worst case is a stale, trivially-editable reference.
  if (/^Save recurring link as a project reference\?/.test(d.title) && answerKey === "save")
    return { allow: true, category: "ref_capture", reason: "reference capture — reversible, zero blast radius" };

  // Duplicate-task merge: only when `merge` is the recommended option (i.e. an
  // exact or ≥0.8-similarity match — the recommended-gate above enforced that).
  if (hasDecisionEvent(db, "duplicate_suspected", d.id) && answerKey === "merge")
    return { allow: true, category: "duplicate_merge", reason: "high-confidence duplicate merge (recommended)" };

  // Task recovery: requeue is a reversible retry of a failed task.
  if (hasDecisionEvent(db, "recovery_card", d.id) && answerKey === "requeue")
    return { allow: true, category: "recovery_requeue", reason: "task requeue — reversible retry" };

  // ponytail: closed allow-list, no precedent lookup. Scout §3 also floated a
  // precedent-based path (auto-approve any category the director answered the
  // same way before) — add that here if these three prove too narrow.
  return no("*", "not an auto-approvable category — routing to the director");
}
