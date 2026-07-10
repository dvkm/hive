// Standing-authority policy engine (v3). David grants scoped authority once and
// the SERVER enforces it before risky actions dispatch — agents never serially
// ask for permission, and high-blast-radius actions structurally cannot proceed
// without an answered decision card that names the EXACT target.
//
// authorize() is the single gate. It is called by the risky paths (task spawn,
// steer/send, transitions into verifying/done) and by the agent-facing
// POST /api/tasks/:id/guarded-action endpoint. Evaluation: most-specific active
// rule wins (project over global, then longer pattern over shorter). Unmatched
// actions default to `allow` (log-only) so the system is useful before any rule
// exists.
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { writeEvent } from "./state.ts";
import { createDecision } from "./api.ts";

const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export interface AuthzInput {
  project_id: string | null;
  action: string;
  target: string;
  task_id?: string | null;
  detail?: string | null;
  // Plain-English "what this does" (e.g. the Bash tool's own description).
  // Becomes the card TITLE so the inbox reads as intent, not raw shell.
  summary?: string | null;
}

export type AuthzResult =
  | { effect: "allow"; via_grant?: boolean; rule_id?: string | null }
  | { effect: "deny"; reason: string; rule_id?: string | null }
  | { effect: "require_decision"; decision_id: string };

interface Rule {
  id: string;
  project_id: string | null;
  action_pattern: string;
  effect: string;
  note: string | null;
  created_at: string;
}

// Glob match: '*' is a wildcard, everything else is literal. The whole action
// must match the whole pattern (anchored). "deploy*" matches "deploy.prod";
// "deploy" matches only "deploy".
export function patternMatches(pattern: string, action: string): boolean {
  const rx = new RegExp(
    "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : "\\" + c)) + "$"
  );
  return rx.test(action);
}

// Literal (non-wildcard) length — the specificity score for tie-breaking.
function litLen(pattern: string): number {
  return pattern.replace(/\*/g, "").length;
}

// Resolve the winning rule for an action, or null if none match (→ default allow).
// project rules beat global; among the same scope, the longer literal pattern
// wins; newest created_at breaks any remaining tie.
export function resolveRule(db: DB, projectId: string | null, action: string): Rule | null {
  const rows = db
    .query(
      "SELECT id, project_id, action_pattern, effect, note, created_at FROM authority_rules " +
        "WHERE active = 1 AND (project_id IS NULL OR project_id = ?)"
    )
    .all(projectId) as Rule[];
  const matched = rows.filter((r) => patternMatches(r.action_pattern, action));
  if (!matched.length) return null;
  matched.sort(
    (a, b) =>
      (b.project_id ? 1 : 0) - (a.project_id ? 1 : 0) ||
      litLen(b.action_pattern) - litLen(a.action_pattern) ||
      (a.created_at < b.created_at ? 1 : -1)
  );
  return matched[0];
}

// Find a usable (granted, unconsumed, unexpired) grant for this exact
// action+target+task and consume it single-use. Returns true if one was spent.
function consumeGrant(db: DB, input: AuthzInput, clock: () => string): boolean {
  const nowTs = clock();
  const g = db
    .query(
      "SELECT id FROM authority_grants WHERE status = 'granted' AND consumed_at IS NULL " +
        "AND task_id IS ? AND action = ? AND target = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(input.task_id ?? null, input.action, input.target, nowTs) as { id: string } | undefined;
  if (!g) return false;
  db.query("UPDATE authority_grants SET status = 'consumed', consumed_at = ? WHERE id = ?").run(nowTs, g.id);
  return true;
}

// An already-open card for this exact action+target+task means the agent is
// mid-wait; return its id instead of opening a duplicate.
function pendingDecisionFor(db: DB, input: AuthzInput): string | null {
  const g = db
    .query(
      "SELECT decision_id FROM authority_grants WHERE status = 'pending' " +
        "AND task_id IS ? AND action = ? AND target = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(input.task_id ?? null, input.action, input.target) as { decision_id: string } | undefined;
  return g?.decision_id ?? null;
}

// The single authorization gate. Writes the appropriate timeline event and, for
// require_decision, opens the card + parks a pending grant. `clock` is injectable
// for grant-expiry tests.
export function authorize(db: DB, input: AuthzInput, clock: () => string = now): AuthzResult {
  // 1. A previously-approved grant lets a retry through (single-use).
  if (consumeGrant(db, input, clock)) {
    if (input.task_id)
      writeEvent(db, {
        task_id: input.task_id,
        source: "system",
        type: "authority_logged",
        payload: { action: input.action, target: input.target, effect: "allow", via_grant: true },
      });
    return { effect: "allow", via_grant: true };
  }

  // 2. A card is already open for this exact request — keep waiting, no dupes.
  const pending = pendingDecisionFor(db, input);
  if (pending) return { effect: "require_decision", decision_id: pending };

  // 3. Evaluate the rules. No match → default allow (log-only).
  const rule = resolveRule(db, input.project_id, input.action);
  const effect = rule?.effect ?? "allow";

  if (effect === "allow") {
    if (input.task_id)
      writeEvent(db, {
        task_id: input.task_id,
        source: "system",
        type: "authority_logged",
        payload: { action: input.action, target: input.target, effect: "allow", rule_id: rule?.id ?? null },
      });
    return { effect: "allow", rule_id: rule?.id ?? null };
  }

  if (effect === "deny") {
    const reason = rule?.note ? `denied by standing authority: ${rule.note}` : "denied by standing authority";
    if (input.task_id)
      writeEvent(db, {
        task_id: input.task_id,
        source: "system",
        type: "authority_denied",
        payload: { action: input.action, target: input.target, rule_id: rule?.id ?? null },
      });
    return { effect: "deny", reason, rule_id: rule?.id ?? null };
  }

  // require_decision → open a card naming the exact target and park a pending
  // grant. Title priority: the caller's plain-English summary of WHAT the
  // command does (agents' Bash descriptions) > detail (the gate's reason) >
  // generic — so seven "recursive/forced rm" cards read as seven intents.
  const summary = input.summary?.trim();
  const title = summary
    ? summary.length > 110
      ? summary.slice(0, 109) + "…"
      : summary
    : input.detail?.trim() || `Authorize: ${input.action} on ${input.target}`;
  const decision = createDecision(db, {
    task_id: input.task_id!,
    title,
    context:
      (summary && input.detail?.trim() ? `${input.detail.trim()}. ` : "") +
      `An agent requested authority to run '${input.action}' targeting ${input.target}. ` +
      `Approving mints a single-use, 24h grant scoped to this exact action + target.`,
    risk: "high",
    blast_radius: `Exact target: ${input.target}`,
    options: [
      { key: "approve", label: "Approve", detail: `Allow '${input.action}' on ${input.target} (one time).` },
      { key: "deny", label: "Deny", detail: "Block this action.", recommended: true },
    ],
  });
  db.query(
    "INSERT INTO authority_grants (id, task_id, action, target, decision_id, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)"
  ).run(newId("agr"), input.task_id ?? null, input.action, input.target, decision.id, clock());
  if (input.task_id)
    writeEvent(db, {
      task_id: input.task_id,
      source: "system",
      type: "authority_required",
      payload: { action: input.action, target: input.target, decision_id: decision.id, rule_id: rule?.id ?? null },
    });
  return { effect: "require_decision", decision_id: decision.id };
}

// Called when a decision is answered. If it gates a pending authority grant,
// approve → mint the consumable grant (24h); anything else → deny it.
// Returns true if this decision was an authority card (so the caller can log).
export function resolveGrantForDecision(
  db: DB,
  decisionId: string,
  answerKey: string,
  clock: () => string = now
): boolean {
  const g = db
    .query("SELECT * FROM authority_grants WHERE decision_id = ? AND status = 'pending'")
    .get(decisionId) as any;
  if (!g) return false;
  if (answerKey === "approve") {
    const expires = new Date(new Date(clock()).getTime() + GRANT_TTL_MS).toISOString();
    db.query("UPDATE authority_grants SET status = 'granted', expires_at = ? WHERE id = ?").run(expires, g.id);
    if (g.task_id)
      writeEvent(db, {
        task_id: g.task_id,
        source: "director",
        type: "authority_granted",
        payload: { action: g.action, target: g.target, decision_id: decisionId, expires_at: expires },
      });
  } else {
    db.query("UPDATE authority_grants SET status = 'denied' WHERE id = ?").run(g.id);
  }
  return true;
}

// Applicable active rules for a project (global + project), most-specific first.
// Used by the brief composer to tell agents which rules govern them.
export function rulesForProject(db: DB, projectId: string | null): Rule[] {
  const rows = db
    .query(
      "SELECT id, project_id, action_pattern, effect, note, created_at FROM authority_rules " +
        "WHERE active = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY created_at"
    )
    .all(projectId) as Rule[];
  return rows;
}

// ponytail: pattern matching is a whole-string glob, not a full path matcher —
// enough for action strings like "deploy.prod" / "flag.*". Swap for a real
// matcher only if actions grow hierarchical semantics that '*' can't express.
