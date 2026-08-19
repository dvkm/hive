// Async enrichment for gated-command decision cards: a haiku one-shot explains
// what the exact command does and the note is appended to the card while it's
// still open. Fire-and-forget from the guarded-action path — the gate itself
// never waits on a model. Costs ~a cent and only runs for cards a human will
// actually read (command cards are rare post-waivers).
import type { DB } from "./db.ts";
import { broadcast } from "./bus.ts";
import { parseDecision } from "./rows.ts";
import { claudeBin, defaultPlannerExec, type PlannerExec } from "./planner.ts";

const TIMEOUT_MS = 60_000;

export async function explainCommandDecision(
  db: DB,
  decisionId: string,
  command: string,
  deps: { exec?: PlannerExec } = {}
): Promise<void> {
  const exec = deps.exec ?? defaultPlannerExec;
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
    res = await exec([claudeBin(), "-p", "--model", "haiku", prompt, "--output-format", "json"], {
      timeoutMs: TIMEOUT_MS,
    });
  } catch {
    return; // enrichment is best-effort, the card stands on its static context
  }
  if (res.timedOut || res.code !== 0) return;
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
