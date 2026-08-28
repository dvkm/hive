// Standing-authority policy engine (v3). The director grants scoped authority once and
// the SERVER enforces it before risky actions dispatch — agents never serially
// ask for permission, and high-blast-radius actions structurally cannot proceed
// without an answered decision card that names the EXACT target.
//
// authorize() is the single gate. It is called by the risky paths (task spawn,
// steer/send, transitions into verifying/done) and by the agent-facing
// POST /api/tasks/:id/guarded-action endpoint. Evaluation: most-specific active
// rule wins (project over global, then longer pattern over shorter). Unmatched
// actions default to `allow` (log-only) so the system is useful before any rule
// exists — EXCEPT the deny-safe defaults below, which fail closed in code so
// safety never depends on what is (or isn't) seeded in the DB.
import type { DB } from "./db.ts";
import { newId, now } from "./db.ts";
import { writeEvent } from "./state.ts";
import { createDecision } from "./api.ts";
import { queueSteerEvent } from "./steer.ts";

const GRANT_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_SERVER_ACTION = "command.dangerous.hive-server-restart";

// Actions that require an answered decision even with NO matching rule. A fresh
// install, a wiped DB, or a deleted rule must not silently auto-run `rm -rf`.
// An explicit rule still wins (a deliberate `command.dangerous* → allow` relaxes
// this), so it's a default, not a hardcoded policy.
const DEFAULT_REQUIRE_DECISION = ["command.dangerous*"];

export function defaultEffect(action: string): "allow" | "require_decision" {
  return DEFAULT_REQUIRE_DECISION.some((p) => patternMatches(p, action)) ? "require_decision" : "allow";
}

// Seed the standing rules a hive install should always have. Idempotent: skips
// any global pattern that already exists, so it is safe to run on every boot.
export function bootstrapAuthority(db: DB): number {
  const seeds = [
    {
      action_pattern: "command.dangerous*",
      effect: "require_decision",
      note: "Dangerous commands (rm -rf, force push, DROP, sudo, prod) need the director to approve",
    },
    {
      action_pattern: LIVE_SERVER_ACTION,
      effect: "require_decision",
      note: "Agents must not restart or replace the live Hive server without a director decision",
    },
  ];
  let inserted = 0;
  for (const s of seeds) {
    const exists = db
      .query("SELECT 1 FROM authority_rules WHERE project_id IS NULL AND action_pattern = ?")
      .get(s.action_pattern);
    if (exists) continue;
    db.query(
      "INSERT INTO authority_rules (id, project_id, scope, action_pattern, effect, note, active, created_at) VALUES (?,NULL,'global',?,?,?,1,?)"
    ).run(newId("aur"), s.action_pattern, s.effect, s.note, now());
    inserted++;
  }
  return inserted;
}

// Plain-English danger explanations per classifier category — the card reader
// shouldn't need to parse shell to know what's at stake. Matched by substring
// against the reason in `detail` ("command approval (dangerous): <reason>").
const CATEGORY_EXPLAIN: [string, string][] = [
  ["rm", "Deletes files or directories permanently — no trash, no undo. A wrong path or an empty variable can wipe far more than intended."],
  ["kill", "Terminates running processes. A broad match can take down your own apps or another agent's server, not just this agent's."],
  ["force push", "Rewrites the remote branch's history — commits pushed by others (or other agents) on that branch can be lost."],
  ["hard reset", "Discards uncommitted local changes in the checkout it runs in."],
  ["git clean", "Deletes untracked files from the working tree — anything not committed is gone."],
  ["sql", "Modifies or deletes database rows/tables directly. Against a live DB this is customer data."],
  ["sudo", "Runs with root privileges — can change anything on the machine."],
  ["pipe-to-shell", "Downloads code from the network and executes it immediately, sight unseen."],
];

// Structured context for a gated shell command: intent, the literal command,
// what the category means, and what each answer does.
function commandContext(input: AuthzInput): string {
  const reason = input.detail?.replace(/^command approval \((dangerous|unknown)\): /, "") ?? "";
  const explain = CATEGORY_EXPLAIN.find(([k]) => reason.toLowerCase().includes(k))?.[1];
  return [
    `Agent's stated intent: ${input.summary?.trim() || "(the agent gave no description)"}`,
    ``,
    `Command it wants to run:`,
    `  ${input.target.split("\n").join("\n  ")}`,
    ``,
    `Why it was gated: ${reason}${explain ? ` — ${explain}` : ""}`,
    ``,
    `Approve = this exact command, once (24h grant). Approve & always allow = every '${input.action}' command in this project, from now on. Deny = blocked; the agent is told to find another way.`,
  ].join("\n");
}

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

  // 3. Evaluate the rules. No match → the deny-safe default for this action.
  const rule = resolveRule(db, input.project_id, input.action);
  const effect = rule?.effect ?? defaultEffect(input.action);

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
  // grant. A card must hang off a task; with no task_id nobody can answer it,
  // so fail closed. Title priority: the caller's plain-English summary of WHAT
  // the command does (agents' Bash descriptions) > detail (the gate's reason) >
  // generic — so seven "recursive/forced rm" cards read as seven intents.
  if (!input.task_id) return { effect: "deny", reason: "denied: needs a decision but has no task", rule_id: rule?.id ?? null };
  const summary = input.summary?.trim();
  // Command approval cards must state both intent and effect. Reject before
  // creating one so the caller can retry with a one-line description.
  if (!summary && input.action.startsWith("command."))
    return {
      effect: "deny",
      reason:
        "denied: no description given for this command — retry the same command with a one-line description of what it does and why, so the approval card carries your stated intent",
      rule_id: rule?.id ?? null,
    };
  const title = summary
    ? summary.length > 110
      ? summary.slice(0, 109) + "…"
      : summary
    : input.detail?.trim() || `Authorize: ${input.action} on ${input.target}`;
  // Gated shell commands get a third answer that mints a standing project rule
  // for the whole category (the action carries the classifier category, e.g.
  // `command.dangerous.process-kill`) — approving the same scratch-cleanup /
  // pkill class one card at a time stalled agents for hours (19 of 28 such
  // cards expired unanswered). Non-command actions (deploy, flags) stay
  // one-time-only: "always allow a deploy" is never one click.
  const options = [
    { key: "approve", label: "Approve", detail: `Allow '${input.action}' on ${input.target} (one time).` },
    ...(input.action.startsWith("command.") && input.action !== LIVE_SERVER_ACTION
      ? [{
          key: "approve_always",
          label: "Approve & always allow",
          detail: `Allow this once AND add a standing project rule: '${input.action}' → allow. Future commands in this category run without asking. Revocable in Authority.`,
        }]
      : []),
    { key: "deny", label: "Deny", detail: "Block this action.", recommended: true },
  ];
  const decision = createDecision(db, {
    task_id: input.task_id,
    title,
    context: input.action.startsWith("command.")
      ? commandContext(input)
      : (summary && input.detail?.trim() ? `${input.detail.trim()}. ` : "") +
        `An agent requested authority to run '${input.action}' targeting ${input.target}. ` +
        `Approving mints a single-use, 24h grant scoped to this exact action + target.`,
    risk: "high",
    blast_radius: `Exact target: ${input.target}`,
    options,
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
// approve → mint the consumable grant (24h); approve_always → the grant PLUS a
// standing project-scoped allow rule for the action category, so this class of
// command never cards again; anything else → deny it.
// Returns true if this decision was an authority card (so the caller can log).
export function resolveGrantForDecision(
  db: DB,
  decisionId: string,
  answerKey: string,
  clock: () => string = now,
  denyNote?: string | null
): boolean {
  const g = db
    .query("SELECT * FROM authority_grants WHERE decision_id = ? AND status = 'pending'")
    .get(decisionId) as any;
  if (!g) return false;
  if (answerKey === "approve_always") mintCategoryRule(db, g, decisionId, clock);
  if (answerKey === "approve" || answerKey === "approve_always") {
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
    // Tell the agent WHY, so it adapts instead of blindly retrying the same
    // blocked command. The director's note is the reason; without one, a
    // generic "denied, find another way".
    if (g.task_id) {
      const reason = denyNote?.trim();
      queueSteerEvent(
        db,
        g.task_id,
        `The director DENIED your request to run '${g.action}' (${g.target.split("\n")[0].slice(0, 100)}).` +
          (reason ? ` Reason: ${reason}` : "") +
          ` Do not retry the same command — take a different approach that doesn't need it, or checkpoint why you're stuck.`,
        "queued by command deny"
      );
      maybeProposeDenyGuardrail(db, g);
    }
  }
  return true;
}

// A command category the director denies repeatedly is a standing "no" the
// agents keep rediscovering. After the Nth deny of the same action in a project
// (across distinct decisions), propose a global-for-the-project deny rule so it
// never cards again — the deny mirror of "Approve & always allow".
const DENY_GUARDRAIL_THRESHOLD = 3;
function maybeProposeDenyGuardrail(db: DB, grant: any): void {
  if (!grant.action?.startsWith("command.")) return;
  const projectId = grant.task_id
    ? (db.query("SELECT project_id FROM tasks WHERE id = ?").get(grant.task_id) as any)?.project_id
    : null;
  if (!projectId) return;
  // Already gated by a rule, or a proposal already exists → nothing to do.
  if (db.query("SELECT 1 FROM authority_rules WHERE active = 1 AND action_pattern = ? AND (project_id IS NULL OR project_id = ?)").get(grant.action, projectId))
    return;
  // Denials the explainer already called zero-risk don't count toward the
  // "always block?" tally — a false-positive classifier match denied 3x must
  // not be able to mint a standing deny rule off its own false positives
  // (task 1022; the explainer runs async, so LEFT JOIN — a not-yet-explained
  // or unmatched decision still counts, same as before this column existed).
  const denies = (
    db
      .query(
        `SELECT COUNT(DISTINCT ag.decision_id) AS n FROM authority_grants ag
           JOIN tasks t ON t.id = ag.task_id
           LEFT JOIN decisions d ON d.id = ag.decision_id
          WHERE ag.action = ? AND ag.status = 'denied' AND t.project_id = ?
            AND (d.explainer_verdict IS NULL OR d.explainer_verdict != 'zero-risk')`
      )
      .get(grant.action, projectId) as any
  ).n as number;
  if (denies < DENY_GUARDRAIL_THRESHOLD) return;
  const anchor = db.query("SELECT id FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId) as any;
  if (!anchor) return;
  if (db.query("SELECT 1 FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ? AND d.title LIKE ? AND d.status = 'open'").get(projectId, `Always block %${grant.action}%`))
    return;
  createDecision(db, {
    task_id: anchor.id,
    title: `Always block '${grant.action}'? Denied ${denies}× in this project`,
    context:
      `You've denied '${grant.action}' commands ${denies} times. Approving adds a standing project rule ` +
      `(${grant.action} → deny) so agents are blocked immediately with no card — they'll be told to find ` +
      `another way. Revocable in Authority.`,
    risk: "normal",
    options: [
      { key: "block", label: "Always block it", detail: `Add a standing deny rule for '${grant.action}'.`, recommended: true },
      { key: "keep_asking", label: "Keep asking each time", detail: "Leave it as a per-command decision." },
    ],
  });
  writeEvent(db, { task_id: anchor.id, source: "system", type: "deny_guardrail_proposed", payload: { action: grant.action, denies } });
}

// Answer hook for the deny-guardrail proposal: block → mint a project deny rule.
export function resolveDenyGuardrailForDecision(db: DB, decisionId: string, answerKey: string): boolean {
  const d: any = db.query("SELECT task_id, title FROM decisions WHERE id = ?").get(decisionId);
  if (!d || !/^Always block '/.test(d.title)) return false;
  if (answerKey !== "block") return true;
  const action = d.title.match(/^Always block '([^']+)'/)?.[1];
  const projectId = (db.query("SELECT project_id FROM tasks WHERE id = ?").get(d.task_id) as any)?.project_id;
  if (!action || !projectId) return true;
  db.query(
    "INSERT INTO authority_rules (id, project_id, scope, action_pattern, effect, note, active, created_at) VALUES (?,?,?,?, 'deny', ?, 1, ?)"
  ).run(newId("aur"), projectId, `project:${projectId}`, action, `Director blocked '${action}' after repeated denials`, now());
  writeEvent(db, { task_id: d.task_id, source: "director", type: "authority_rule_added", payload: { action, effect: "deny" } });
  return true;
}

// "Approve & always allow": insert an active project-scoped allow rule for the
// exact action (a stable category string like `command.dangerous.process-kill`).
// Specificity makes it win over the global `command.dangerous*` require_decision
// default (project beats global, longer literal beats shorter). Idempotent:
// answering two parked cards of the same category mints one rule.
function mintCategoryRule(db: DB, grant: any, decisionId: string, clock: () => string): void {
  const t = grant.task_id
    ? (db.query("SELECT project_id FROM tasks WHERE id = ?").get(grant.task_id) as any)
    : null;
  const projectId = t?.project_id ?? null;
  const exists = db
    .query(
      "SELECT 1 FROM authority_rules WHERE active = 1 AND action_pattern = ? AND project_id IS ?"
    )
    .get(grant.action, projectId);
  if (exists) return;
  db.query(
    "INSERT INTO authority_rules (id, project_id, scope, action_pattern, effect, note, active, created_at) VALUES (?,?,?,?,?,?,1,?)"
  ).run(
    newId("aur"),
    projectId,
    projectId ? `project:${projectId}` : "global",
    grant.action,
    "allow",
    `always-allow minted from decision ${decisionId} (target was: ${String(grant.target).slice(0, 120)})`,
    clock()
  );
  if (grant.task_id)
    writeEvent(db, {
      task_id: grant.task_id,
      source: "director",
      type: "authority_rule_minted",
      payload: { action: grant.action, project_id: projectId, decision_id: decisionId },
    });
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
