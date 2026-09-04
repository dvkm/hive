// Schema for projects.config, checked at the API boundary (POST/PUT /api/projects).
//
// projects.config is client-writable and hive's loopback API is unauthenticated
// by design, so this object is a trust boundary. Every subsystem downstream of
// it trusts its shape completely; the sharpest case is config.agent_argv, which
// becomes the verbatim binary+argv of every spawned task agent (runtime/herdr.ts)
// while that same spawn injects all of the project's resolved secrets into the
// process env — so a single config write reaches an attacker-chosen command on
// the next dispatch. reviewer_argv / planner_argv / setup_argv / cleanup_argv
// are the same shape against the server's own ambient env.
//
// Type-checking here does NOT remove that RCE surface: those overrides are an
// intentional per-project feature. It stops malformed values from reaching code
// that assumes a shape, and it gives tighter policy (e.g. requiring argv[0] to
// resolve to an allowlisted binary) exactly one place to live. See task #991's
// inventory for the full config-field -> call-site map.
//
// CHECKS is the allowlist: an unknown top-level key is rejected, so a new config
// key cannot be wired into a reader without someone landing here and choosing
// its check. Keys hive stores but never reads are listed with `any` explicitly.
import { isSafeRef } from "./exec.ts";

// Lives here, not in api.ts: this schema needs it, and api.ts already imports
// this file, so importing back would be a cycle. api.ts re-exports the name.
// "teamclaude" is Claude Code routed through the local TeamClaude proxy
// (multi-account API balancing); it runs the same claude binary + hooks.
export const AGENTS = ["claude", "codex", "teamclaude"] as const;
export type Agent = (typeof AGENTS)[number];
export const AUTONOMY_PROFILES = ["conservative", "balanced", "autopilot"] as const;

type Check = (v: unknown) => string | null; // null = valid, else the reason

const any: Check = () => null;
const str: Check = (v) => (typeof v === "string" ? null : "must be a string");
const bool: Check = (v) => (typeof v === "boolean" ? null : "must be a boolean");
const num: Check = (v) => (typeof v === "number" && Number.isFinite(v) ? null : "must be a number");
const positiveInt: Check = (v) =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? null : "must be a positive integer";
const nonnegativeInt: Check = (v) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? null : "must be a non-negative integer";
const obj: Check = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? null : "must be an object");
const strArray: Check = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? null : "must be an array of strings";
const oneOf =
  (...allowed: string[]): Check =>
  (v) =>
    typeof v === "string" && allowed.includes(v) ? null : `must be one of ${allowed.join("|")}`;
const reasoningEffort = oneOf("minimal", "low", "medium", "high", "xhigh");
const reasoningByKind: Check = (v) => {
  const bad = obj(v);
  if (bad) return bad;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const invalid = reasoningEffort(value);
    if (invalid) return `.${key} ${invalid}`;
  }
  return null;
};

// The subprocess-override family. Constrained to a string[] so nothing but an
// argv can be smuggled through; the CONTENT stays the project's choice, which
// is what these keys exist for.
const argv = strArray;

// No credential rides along on these fetches (they are plain GETs), so this is
// SSRF-bounding, not exfil: reject anything that is not a well-formed http(s)
// URL. Internal hosts are deliberately NOT rejected — monitors and smoke checks
// legitimately point at 127.0.0.1 dev servers.
function httpUrl(v: unknown): string | null {
  if (typeof v !== "string") return "must be a string";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "must be a valid URL";
  }
  return u.protocol === "http:" || u.protocol === "https:" ? null : "must be an http(s) URL";
}

// watchers / monitors / smoke: [{name, url, ...}]. The url is the only field
// that becomes a destination, so that is the field pinned.
const urlList: Check = (v) => {
  if (!Array.isArray(v)) return "must be an array";
  for (let i = 0; i < v.length; i++) {
    const e = v[i] as Record<string, unknown>;
    if (e === null || typeof e !== "object" || Array.isArray(e)) return `[${i}] must be an object`;
    const bad = httpUrl(e.url);
    if (bad) return `[${i}].url ${bad}`;
  }
  return null;
};

// Mirrors what intake/jira.ts's jiraConfigStatus() needs to build a usable
// config. The credential target's own shape (https site, real email, uppercase
// project key) is enforced there (credentialTargetValid / canonicalSite); this
// only keeps a wrong-typed value from reaching it at all.
const jira: Check = (v) => {
  const bad = obj(v);
  if (bad) return bad;
  const j = v as Record<string, unknown>;
  for (const k of ["site", "email", "project_key"]) if (typeof j[k] !== "string") return `.${k} must be a string`;
  for (const k of ["enabled", "write"]) if (j[k] !== undefined && typeof j[k] !== "boolean") return `.${k} must be a boolean`;
  if (j.status_notes_to_comments !== undefined && typeof j.status_notes_to_comments !== "boolean")
    return ".status_notes_to_comments must be a boolean";
  if (j.jql !== undefined && typeof j.jql !== "string") return ".jql must be a string";
  if (j.write_scope !== undefined) {
    const invalid = obj(j.write_scope);
    if (invalid) return `.write_scope ${invalid}`;
    const scope = j.write_scope as Record<string, unknown>;
    for (const key of Object.keys(scope)) if (key !== "create_subtask") return `.write_scope.${key} is not supported`;
    if (scope.create_subtask !== undefined && typeof scope.create_subtask !== "boolean")
      return ".write_scope.create_subtask must be a boolean";
  }
  return null;
};

// Either the literal "*" (every space the authorized user belongs to) or
// [{space, label?}] — see intake/gchat.ts.
const gchatSpaces: Check = (v) => {
  if (v === "*") return null;
  if (!Array.isArray(v)) return 'must be "*" or an array of {space} objects';
  for (let i = 0; i < v.length; i++) {
    const e = v[i] as Record<string, unknown>;
    if (e === null || typeof e !== "object" || Array.isArray(e)) return `[${i}] must be an object`;
    if (typeof e.space !== "string") return `[${i}].space must be a string`;
  }
  return null;
};

// Production releases (server/src/deployments.ts). Presence of this key is what
// opts a project into the Deployments tab, so every field is optional. The two
// name-shaped fields become git/gh arguments and posthog_host becomes a fetch
// destination, so those are pinned here; deployments.ts still falls back to a
// default rather than trusting a name that reaches it another way.
const deployments: Check = (v) => {
  const bad = obj(v);
  if (bad) return bad;
  const d = v as Record<string, unknown>;
  for (const key of ["deploy_workflow", "rollback_workflow", "tag_prefix"])
    // Leading character pinned to alphanumeric: "--version" is otherwise a
    // valid "name" that `gh workflow run` would read as a flag.
    if (d[key] !== undefined && !(typeof d[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d[key] as string)))
      return `.${key} must be a plain name starting with a letter or digit`;
  if (d.workflow_ref !== undefined && !isSafeRef(d.workflow_ref)) return ".workflow_ref must be a git branch name";
  for (const key of ["health_url", "posthog_host"]) {
    if (d[key] === undefined) continue;
    const invalid = httpUrl(d[key]);
    if (invalid) return `.${key} ${invalid}`;
  }
  for (const key of ["health_substring", "posthog_project"])
    if (d[key] !== undefined && typeof d[key] !== "string") return `.${key} must be a string`;
  if (d.flags !== undefined) {
    const invalid = strArray(d.flags);
    if (invalid) return `.flags ${invalid}`;
  }
  if (d.history !== undefined) {
    const invalid = positiveInt(d.history);
    if (invalid) return `.history ${invalid}`;
  }
  return null;
};

const promote: Check = (v) => {
  const bad = obj(v);
  if (bad) return bad;
  const p = v as Record<string, unknown>;
  for (const key of ["from", "to"]) if (!isSafeRef(p[key])) return `.${key} must be a git branch name`;
  return null;
};

// {sensitive_paths: ["auth", "payments", ...]} — path tokens whose changes stay
// judgment-class no matter how clean the auto-review was. Each token matches as
// a case-insensitive substring of any path segment, so "auth" also catches
// `authTokens.ts`.
const understandingChecks: Check = (v) => {
  const bad = obj(v);
  if (bad) return bad;
  const u = v as Record<string, unknown>;
  for (const key of Object.keys(u)) if (key !== "sensitive_paths") return `.${key} is not supported`;
  if (u.sensitive_paths !== undefined) {
    const invalid = strArray(u.sensitive_paths);
    if (invalid) return `.sensitive_paths ${invalid}`;
  }
  return null;
};

const duration: Check = (v) =>
  typeof v === "string" && /^\d+(?:s|m|h|d)$/.test(v) ? null : "must be a duration such as 30m, 12h, or 14d";

const prGardener: Check = (v) => {
  const bad = obj(v);
  if (bad) return bad;
  const checks: Record<string, Check> = {
    enabled: bool,
    cadence: duration,
    land_when: oneOf("green_and_clean"),
    close_stale_after: duration,
    auto_close_superseded: bool,
    sensitive_paths: strArray,
    max_actions_per_sweep: positiveInt,
    max_fix_attempts: positiveInt,
    max_gardener_agents: positiveInt,
    adopt_untracked: bool,
    adopt_skip_labels: strArray,
  };
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (!Object.hasOwn(checks, key)) return `.${key} is not a known PR gardener key`;
    const invalid = checks[key]!(value);
    if (invalid) return `.${key} ${invalid}`;
  }
  return null;
};

// Which task kinds must post a plan checkpoint before their first edit, whether
// that checkpoint blocks the agent until it is acked, and how long a blocked
// plan may wait before hive acks it. See server/src/planCritic.ts.
const plan_gate: Check = (v) => {
  const bad = obj(v);
  if (bad) return bad;
  const g = v as Record<string, unknown>;
  for (const key of Object.keys(g))
    if (key !== "kinds" && key !== "block" && key !== "auto_ack_hours") return `.${key} is not supported`;
  if (g.kinds !== undefined) {
    const invalid = strArray(g.kinds);
    if (invalid) return `.kinds ${invalid}`;
  }
  if (g.block !== undefined && typeof g.block !== "boolean") return ".block must be a boolean";
  if (g.auto_ack_hours !== undefined && !(typeof g.auto_ack_hours === "number" && Number.isFinite(g.auto_ack_hours) && g.auto_ack_hours > 0))
    return ".auto_ack_hours must be a positive number of hours";
  return null;
};

// HIVE-355 warm worktrees. `worktree_seed` is an allowlist of globs naming the
// untracked files a fresh worktree needs to run (.env, config.env); they are
// copied from the main checkout. `worktree_warm` names directories to clone
// from the main checkout instead of rebuilding (node_modules), each with the
// lockfile whose contents must still match for that clone to be valid.
const worktreeWarm: Check = (v) => {
  if (!Array.isArray(v)) return "must be an array";
  for (const entry of v) {
    if (obj(entry)) return "each entry must be an object";
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) if (key !== "dir" && key !== "lock") return `.${key} is not supported`;
    if (typeof e.dir !== "string" || !e.dir) return ".dir must be a non-empty string";
    if (e.lock !== undefined && (typeof e.lock !== "string" || !e.lock)) return ".lock must be a non-empty string";
  }
  return null;
};

// HIVE-629 preview stacks. Presence of this key is what opts a project into the
// review card's Preview button and the automatic bring-up at handoff; a project
// without it shows no preview UI at all. `up`/`down` become the argv of a
// command run in the task's own worktree, so they are pinned to a plain
// command line with no shell syntax; `urls` are the addresses the director is
// handed, so they must be well-formed http(s) with a {slug} placeholder.
const preview: Check = (v) => {
  const bad = obj(v);
  if (bad) return bad;
  const p = v as Record<string, unknown>;
  for (const key of Object.keys(p))
    if (!["up", "down", "urls", "login_hint", "paths"].includes(key)) return `.${key} is not a known preview key`;
  for (const key of ["up", "down"]) {
    const cmd = p[key];
    const parts = Array.isArray(cmd) ? cmd : typeof cmd === "string" ? cmd.trim().split(/\s+/) : null;
    if (!parts || !parts.length || parts.some((x) => typeof x !== "string" || !x || /[;&|`$<>(){}\n]/.test(x)))
      return `.${key} must be a command with no shell syntax, as a string or an argv array`;
  }
  if (!Array.isArray(p.urls) || !p.urls.length) return ".urls must be a non-empty array of {label, url}";
  for (let i = 0; i < p.urls.length; i++) {
    const e = p.urls[i] as Record<string, unknown>;
    if (e === null || typeof e !== "object" || Array.isArray(e)) return `.urls[${i}] must be an object`;
    if (typeof e.label !== "string" || !e.label) return `.urls[${i}].label must be a non-empty string`;
    // {slug} is substituted before the URL is ever used, so check the shape it
    // takes once substituted rather than rejecting the placeholder.
    const invalid = httpUrl(String(e.url ?? "").replaceAll("{slug}", "slug"));
    if (invalid) return `.urls[${i}].url ${invalid}`;
  }
  if (p.login_hint !== undefined && typeof p.login_hint !== "string") return ".login_hint must be a string";
  if (p.paths !== undefined) {
    const invalid = strArray(p.paths);
    if (invalid) return `.paths ${invalid}`;
  }
  return null;
};

const CHECKS: Record<string, Check> = {
  // dispatch / autonomy
  auto_dispatch: bool,
  autonomy_profile: oneOf(...AUTONOMY_PROFILES),
  dispatch_kinds: strArray,
  max_agents: num,
  failed_triage_requeue_hours: (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? null : "must be a non-negative number",
  archived: bool,
  test: bool, // test/ephemeral project, hidden from director surfaces (testProjects.ts)
  plan_intake: bool,
  plan_gate,
  intake_triage: bool, // classify ambient intake before dispatch (intake/triage.ts)
  intake_keywords: strArray,
  // subprocess argv overrides (see above)
  agent_argv: argv,
  reviewer_argv: argv,
  planner_argv: argv,
  setup_argv: argv,
  worktree_seed: strArray,
  worktree_warm: worktreeWarm,
  cleanup_argv: argv,
  stack_setup_timeout_ms: num,
  // agent behaviour
  agent: oneOf(...AGENTS),
  model: str,
  model_by_kind: obj,
  codex_model: str,
  codex_model_by_kind: obj,
  codex_reasoning_effort: reasoningEffort,
  codex_reasoning_effort_by_kind: reasoningByKind,
  codex_auto_compact_token_limit: positiveInt,
  codex_tool_output_token_limit: positiveInt,
  supervisor_persona: str,
  playbook: str,
  command_approval: oneOf("escalate", "allow", "prompt"),
  dialog_auto_approve: strArray,
  auto_answer_dialogs: bool,
  // git / merge
  default_branch: str,
  merge_method: str,
  promote,
  auto_merge: obj,
  pr_gardener: prGardener,
  auto_review: bool,
  render_proof: bool,
  // Per-task preview stacks on the review card (server/src/preview.ts).
  preview,
  // Which changes still need a director understanding check (hive-1559).
  understanding_checks: understandingChecks,
  release_review_agents: bool,
  // false keeps a finished task's `hive/<id>` branch on origin (cleanup.ts).
  delete_remote_branches: bool,
  scope_drift: bool,
  scope_drift_commits: num,
  // config-driven network destinations
  watchers: urlList,
  monitors: urlList,
  monitors_auto_task: bool,
  smoke: urlList,
  deployments,
  jira,
  gchat_spaces: gchatSpaces,
  // budgets / bookkeeping
  cost_warn_usd: num,
  cost_cap_usd: num,
  processed_token_warn: nonnegativeInt,
  processed_token_cap: nonnegativeInt,
  wait_call_warn: nonnegativeInt,
  wait_call_cap: nonnegativeInt,
  decision_auto_answer_hours: num,
  // Quiet window after which an un-acked, unflagged checkpoint leaves the
  // attention inbox once its task has moved on (0 disables; default 24).
  checkpoint_expiry_hours: (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? null : "must be a non-negative number",
  pricing: obj,
  // stored by the director, read by nothing in server/ today
  deploy_notes: str,
  note: str, // free-text annotation on archived/scratch projects, live in prod data
  env: obj,
  open_prs: bool,
  interview: any,
};

// Returns an error message for the first problem found, or null when the whole
// object is acceptable. Callers turn a message into a 400.
export function validateProjectConfig(config: unknown): string | null {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return "config must be an object";
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    // hasOwn, not a plain lookup: "toString"/"__proto__" would otherwise resolve
    // to Object.prototype members and be called as if they were checks.
    if (!Object.hasOwn(CHECKS, key)) return `config.${key} is not a known project config key`;
    const check = CHECKS[key]!;
    if (value === null || value === undefined) continue; // clearing a key is always fine
    const bad = check(value);
    // Nested reasons already carry their own path (".project_key", "[0].url"),
    // so they butt straight up against the key instead of taking a space.
    if (bad) return `config.${key}${/^[.[]/.test(bad) ? "" : " "}${bad}`;
  }
  return null;
}
