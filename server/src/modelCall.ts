// Every model shell-out in hive runs `claude -p ... --output-format json`, and
// that CLI does NOT report all failures on stderr. An unauthenticated run exits
// 1, writes NOTHING to stderr, and prints the reason on STDOUT:
//   {"is_error":true,"result":"Not logged in - Please run /login","subtype":"success"}
// Callers that recorded only stderr wrote 52 auto_review_error rows reading
// `exited 1: ` with an empty reason while the whole review column stalled
// (hive-1800). Note `subtype` stays "success" even when the call failed, so
// `is_error` is the only usable signal.
//
// This module is the single place that turns a failed model result into text,
// tracks the failure streak for /api/health, and raises ONE director
// notification when the failure is an auth problem (which stops the entire
// fleet, not one task).
import type { DB } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";
import { enqueue } from "./notifications.ts";
import { noteToolStart } from "./health.ts";

export type ModelResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };

// The `result` text of a `--output-format json` envelope that flagged is_error.
function envelopeError(stdout: string): string {
  const text = stdout.trim();
  if (!text) return "";
  // Whole-output parse first; `--output-format stream-json` emits one object
  // per line, and there the final line is the envelope.
  const candidates = [text, text.split("\n").filter((l) => l.trim()).pop() ?? ""];
  for (const c of candidates) {
    try {
      const env = JSON.parse(c);
      if (env?.is_error && typeof env.result === "string" && env.result.trim()) return env.result.trim();
    } catch {
      /* not JSON: fall through to the raw-text fallbacks */
    }
  }
  return "";
}

// Human-readable reason a model call failed. Prefers the stdout envelope, then
// stderr, then raw stdout, then the bare exit code.
export function modelErrorText(res: ModelResult, opts: { timeoutMs?: number } = {}): string {
  if (res.timedOut) return opts.timeoutMs ? `timed out after ${opts.timeoutMs}ms` : "timed out";
  const reason = envelopeError(res.stdout) || res.stderr.trim() || res.stdout.trim();
  return reason ? `exited ${res.code}: ${reason.slice(0, 300)}` : `exited ${res.code} with no output`;
}

// Auth/credential shapes. Deliberately narrow: a false positive suppresses the
// per-task noise for something that IS a per-task problem.
const AUTH_RE =
  /not logged in|please run \/login|invalid api key|authentication_error|unauthorized|\b401\b|credit balance|oauth token .{0,40}expired|token (?:has )?expired|session expired|please run `?claude login/i;

export function isAuthFailure(text: string): boolean {
  return AUTH_RE.test(text);
}

const AUTH_ALERT_KEY = "model_auth_alert";

// Record the outcome of one model call. `failure` is null on success.
// Returns the failure text so call sites can write it straight into their event.
export function noteModelCall(db: DB, failure: string | null): string | null {
  noteToolStart(db, "model", failure);
  if (!failure) {
    if (getSetting(db, AUTH_ALERT_KEY)) setSetting(db, AUTH_ALERT_KEY, "");
    return null;
  }
  if (isAuthFailure(failure) && !getSetting(db, AUTH_ALERT_KEY)) {
    // Exactly one card for the whole fleet. Cleared by the next call that
    // succeeds, so a re-login re-arms the alert for next time.
    setSetting(db, AUTH_ALERT_KEY, failure);
    enqueue(db, {
      kind: "incident",
      urgency: "urgent",
      title: "Hive cannot reach the model: not logged in",
      body: `Every review, plan and verification is failing. Run \`claude /login\` on the hive host, then hive recovers on its own. Reported: ${failure.slice(0, 200)}`,
    });
  }
  return failure;
}

// One-liner for the common case: turn a failed result into its recorded error
// and do the health/auth bookkeeping in the same breath.
export function modelFailure(db: DB, res: ModelResult, opts: { timeoutMs?: number } = {}): string {
  return noteModelCall(db, modelErrorText(res, opts))!;
}
