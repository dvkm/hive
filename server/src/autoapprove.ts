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
//   - a pending standing-authority grant can never be approved automatically;
//     its recommended `deny` remains fail-closed and safe to clear.
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

function safetyBar(db: DB, d: any, answerKey: string): AutoApproveVerdict | null {
  const options: any[] = Array.isArray(d.options) ? d.options : JSON.parse(d.options || "[]");
  const chosen = options.find((o) => o.key === answerKey);
  const no = (category: string, reason: string): AutoApproveVerdict => ({ allow: false, category, reason });
  const pendingAuthority = db.query("SELECT 1 FROM authority_grants WHERE decision_id = ? AND status = 'pending'").get(d.id);
  if (pendingAuthority) {
    if (answerKey !== "deny")
      return no("authority", "gates a standing-authority command grant — always the director's call");
    if (!chosen?.recommended) return no("authority", "only a recommended deny may fail closed automatically");
    return null;
  }
  if (!chosen?.recommended) return no("*", "only the raiser's recommended option can be auto-approved");
  const risk = String(d.risk ?? "").toLowerCase();
  if (risk !== "low" && risk !== "normal") return no("*", `risk '${d.risk ?? "(none)"}' is above the auto-approve bar`);
  const blast = String(d.blast_radius ?? "");
  if (PROD_RE.test(blast) || SHARED_RE.test(blast))
    return no("*", "prod/shared blast radius — always the director's call");
  return null;
}

// `d` is a raw decisions row (options is a JSON string) OR a parsed decision
// (options is an array) — handle both so callers don't have to normalize.
export function evaluateAutoApprove(db: DB, d: any, answerKey: string): AutoApproveVerdict {
  const no = (category: string, reason: string): AutoApproveVerdict => ({ allow: false, category, reason });
  const blocked = safetyBar(db, d, answerKey);
  if (blocked) return blocked;

  // Refusing an unexecuted guarded command is fail-closed. Let the supervisor
  // clear its own abandoned cleanup request without asking the director, while
  // every approval path above remains a hard human boundary.
  if (answerKey === "deny" && db.query("SELECT 1 FROM authority_grants WHERE decision_id = ? AND status = 'pending'").get(d.id))
    return { allow: true, category: "authority_deny", reason: "denies a pending guarded command without executing it" };

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

// Autopilot may resolve an uncategorized technical decision, but it still must
// clear the same structural risk bar as the closed balanced allow-list.
export function evaluateAutopilotApprove(db: DB, d: any, answerKey: string): AutoApproveVerdict {
  return safetyBar(db, d, answerKey) ?? {
    allow: true,
    category: "autopilot_reasoned",
    reason: "recommended low/normal-risk choice with no authority or production blast radius",
  };
}
