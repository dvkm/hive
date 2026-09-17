// TypeSafe (Jev) typed judgments: one HTTP call, typed answers with
// probabilities, no prose. Used as a cheap pre-judgment in front of, or in
// place of, prompt-and-parse `claude -p` calls and regex classifiers.
//
// Fail-open by construction: no key, network error, non-200, or malformed
// answer all return null and the caller keeps its existing behavior.
// HIVE_TYPESAFE_MODE=shadow (default) records the judgment beside the existing
// decision without changing it; =enforce lets callers act on it; =off skips
// the call entirely.

export type NoulQ = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type ChoiceQ = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type ScoreQ = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQ | ChoiceQ | ScoreQ;

export type NoulA = { type: "noul"; noul: number };
export type ChoiceA = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreA = { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export type Answer = NoulA | ChoiceA | ScoreA;

export type Judgment = { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number }; ms: number };

export type TypesafeMode = "off" | "shadow" | "enforce";

export function typesafeMode(env: NodeJS.ProcessEnv = process.env): TypesafeMode {
  if (!env.TYPESAFE_API_KEY) return "off";
  const m = env.HIVE_TYPESAFE_MODE;
  return m === "enforce" || m === "off" ? m : "shadow";
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 5000;

export async function judge(
  state: unknown,
  questions: Record<string, Question>,
  opts: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}
): Promise<Judgment | null> {
  const env = opts.env ?? process.env;
  if (typesafeMode(env) === "off") return null;
  const f = opts.fetch ?? fetch;
  const started = Date.now();
  try {
    const res = await f(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ state, model: env.TYPESAFE_MODEL || "jev-latest", questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[hive] typesafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const body: any = await res.json();
    if (!body?.answers || typeof body.answers !== "object") return null;
    for (const k of Object.keys(questions)) if (!body.answers[k]) return null;
    return {
      model: String(body.model ?? ""),
      answers: body.answers,
      usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
      ms: Date.now() - started,
    };
  } catch (e: any) {
    console.error(`[hive] typesafe call failed: ${e?.message ?? e}`);
    return null;
  }
}

export const noul = (a: Answer | undefined): number | null => (a?.type === "noul" ? a.noul : null);
export const choice = (a: Answer | undefined): string | null => (a?.type === "choice" ? a.choice : null);
export const score = (a: Answer | undefined): number | null => (a?.type === "score" ? a.score : null);
