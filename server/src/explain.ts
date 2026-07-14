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
    "In 2-3 short plain-English bullets: what this shell command actually does;",
    "what files/processes/systems it touches; the realistic worst case if it's wrong.",
    "No preamble, no code blocks — bullets only.",
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

  // Only annotate a card that is still open — answered cards are history.
  const r: any = db.query("SELECT * FROM decisions WHERE id = ? AND status = 'open'").get(decisionId);
  if (!r) return;
  const context = `${r.context ?? ""}\n\n— What this command actually does (auto-explained) —\n${text.slice(0, 1200)}`;
  db.query("UPDATE decisions SET context = ? WHERE id = ?").run(context, decisionId);
  broadcast({ type: "decision", decision: parseDecision({ ...r, context }) });
}
