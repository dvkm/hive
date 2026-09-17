// Async enrichment for gated-command decision cards: a typed Jev judgment
// settles the zero-risk/real-risk verdict when it is confident, otherwise a
// haiku one-shot explains what the exact command does; the note is appended
// to the card while it's still open. Fire-and-forget from the guarded-action
// path — the gate itself never waits on a model. Only runs for cards a human
// will actually read (command cards are rare post-waivers).
import type { DB } from "./db.ts";
import { broadcast } from "./bus.ts";
import { parseDecision } from "./rows.ts";
import { claudeBin, defaultPlannerExec, NO_CUSTOMIZATIONS, type PlannerExec } from "./planner.ts";
import { claudeProfileEnvForRepo } from "./claudeProfiles.ts";
import { modelErrorText, noteModelCall } from "./modelCall.ts";
import { judge as typesafeJudge, choice, noul, typesafeSettings, type Question } from "./typesafe.ts";

const TIMEOUT_MS = 60_000;

// The same verdict as the haiku prompt below, as typed questions. The criteria
// spell out what the prose left implicit (a GET against the local API piped
// into a parser is inspection; a write under a scratchpad is not a write that
// matters), because Jev takes "no writes" literally. Benchmarked against the
// stored haiku verdicts: 89% agreement, and at 0.9 the auto-decided half had
// no disagreements a reader sided with haiku on.
const COMMAND_QUESTIONS: Record<string, Question> = {
  verdict: {
    type: "choice",
    instructions: "Blast radius of running this shell command as an automation step.",
    criteria: {
      zero_risk:
        "Read-only inspection. Includes: grep/find/cat/ls, HTTP GET to localhost or a $HIVE_URL/local dev server, piping that output into jq or `node -e`/`python -c` that only parses and prints it, port probes, and writes only under a scratchpad, /tmp, or /private/tmp path.",
      real_risk:
        "Writes or creates files inside a repo, infra, config, or home directory; deletes; kills or restarts processes; POST/PUT/DELETE or any database mutation; runs sudo; executes content fetched from the network; touches a production or shared system.",
    },
  },
  read_only: {
    type: "noul",
    instructions:
      "Does this command avoid writing, deleting, restarting, or mutating anything, other than files under a scratchpad, /tmp, or /private/tmp path? Reading a local HTTP API and parsing its output counts as read-only.",
  },
};

type Typed = { verdict: "zero-risk" | "real-risk"; p_read_only: number; confidence: number; model: string; ms: number };

export async function explainCommandDecision(
  db: DB,
  decisionId: string,
  command: string,
  deps: { exec?: PlannerExec; judge?: typeof typesafeJudge; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  const exec = deps.exec ?? defaultPlannerExec;
  const project = db.query(
    `SELECT p.repo_path, p.config
       FROM decisions d
       JOIN tasks t ON t.id = d.task_id
       JOIN projects p ON p.id = t.project_id
      WHERE d.id = ?`
  ).get(decisionId) as { repo_path: string | null; config: string | null } | undefined;

  // Jev first. Enforce mode with both answers past the project's
  // explain_decide_at settles the verdict and skips haiku; anything less
  // confident, and shadow mode, fall through to haiku with Jev's read noted.
  const { mode, thresholds } = typesafeSettings(JSON.parse(project?.config ?? "{}"), deps.env);
  let typed: Typed | null = null;
  let decided: Typed["verdict"] | null = null;
  if (mode !== "off") {
    const j = await (deps.judge ?? typesafeJudge)({ command: command.slice(0, 4000) }, COMMAND_QUESTIONS, { env: deps.env });
    const c = j ? choice(j.answers.verdict) : null;
    const p = j ? noul(j.answers.read_only) : null;
    const a = j?.answers.verdict;
    const confidence = a?.type === "choice" ? a.confidence : 0;
    if (j && p !== null && (c === "zero_risk" || c === "real_risk")) {
      typed = { verdict: c === "zero_risk" ? "zero-risk" : "real-risk", p_read_only: p, confidence, model: j.model, ms: j.ms };
      const t = thresholds.explain_decide_at;
      if (mode === "enforce" && confidence >= t) {
        if (c === "zero_risk" && p >= t) decided = "zero-risk";
        else if (c === "real_risk" && p <= 1 - t) decided = "real-risk";
      }
    }
  }
  const jevNote = typed
    ? `Jev ${typed.verdict} (read-only p=${typed.p_read_only.toFixed(2)}, confidence ${typed.confidence.toFixed(2)}, ${typed.ms} ms${decided ? "" : ", not decisive"})`
    : null;
  if (decided) {
    annotate(db, decisionId, decided, jevNote!);
    return;
  }

  const prompt = [
    "You are annotating an approval card for someone reviewing an automation request.",
    "First line, exactly: `VERDICT: zero-risk` if this command is read-only and touches no",
    "real system (pure search/inspection of local text, no writes, no execution of untrusted",
    "data, no live database mutation) — otherwise `VERDICT: real-risk`.",
    "Then, in 2-3 short plain-English bullets: what this shell command actually does;",
    "what files/processes/systems it touches; the realistic worst case if it's wrong.",
    "No preamble, no code blocks — verdict line then bullets only.",
    "",
    "Command:",
    command.slice(0, 4000),
  ].join("\n");
  let res;
  try {
    res = await exec([claudeBin(), "-p", NO_CUSTOMIZATIONS, "--model", "haiku", prompt, "--output-format", "json"], {
      timeoutMs: TIMEOUT_MS,
      ...(project?.repo_path ? { cwd: project.repo_path } : {}),
      env: claudeProfileEnvForRepo(project?.repo_path),
    });
  } catch {
    return; // enrichment is best-effort, the card stands on its static context
  }
  if (res.timedOut || res.code !== 0) {
    noteModelCall(db, modelErrorText(res, { timeoutMs: TIMEOUT_MS }));
    return;
  }
  noteModelCall(db, null);
  let text = res.stdout.trim();
  try {
    const env = JSON.parse(text);
    if (typeof env.result === "string") text = env.result.trim();
  } catch {
    /* plain text output */
  }
  if (!text) return;

  const verdictMatch = text.match(/^VERDICT:\s*(zero-risk|real-risk)\s*$/im);
  const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : null;
  const displayText = text.replace(/^VERDICT:.*$/im, "").trim();
  annotate(db, decisionId, verdict, jevNote ? `${displayText}\n${jevNote}` : displayText);
}

function annotate(db: DB, decisionId: string, verdict: string | null, displayText: string): void {
  // Only annotate a card that is still open — answered cards are history.
  const r: any = db.query("SELECT * FROM decisions WHERE id = ? AND status = 'open'").get(decisionId);
  if (!r) return;
  const context = `${r.context ?? ""}\n\n— What this command actually does (auto-explained) —\n${displayText.slice(0, 1200)}`;
  // A zero-risk verdict can't silently auto-allow (the classifier pattern
  // match already fired and the gate is server-enforced, not LLM-enforced),
  // but it CAN flip which answer is recommended — a human clicking through
  // 3 identical "Deny" cards is exactly how the false-positive tally
  // (authority.ts maybeProposeDenyGuardrail) minted standing deny rules from
  // false positives (task 1022).
  let options = JSON.parse(r.options || "[]");
  if (verdict === "zero-risk") {
    options = options.map((o: any) =>
      o.key === "deny" ? { ...o, recommended: false } : o.key === "approve" ? { ...o, recommended: true } : o
    );
  }
  const optionsJson = JSON.stringify(options);
  db.query("UPDATE decisions SET context = ?, options = ?, explainer_verdict = ? WHERE id = ?").run(
    context,
    optionsJson,
    verdict,
    decisionId
  );
  broadcast({ type: "decision", decision: parseDecision({ ...r, context, options: optionsJson }) });
}
