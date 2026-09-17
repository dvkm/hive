// TypeSafe (Jev) typed judgments: one HTTP call, typed answers with
// probabilities, no prose. Used as a cheap pre-judgment in front of, or in
// place of, prompt-and-parse `claude -p` calls and regex classifiers.
//
// Fail-open by construction: no key, network error, non-200, or malformed
// answer all return null and the caller keeps its existing behavior.
// HIVE_TYPESAFE_MODE=shadow (default) records the judgment beside the existing
// decision without changing it; =enforce lets callers act on it; =off skips
// the call entirely.
//
// The key and mode can also be set from the Settings page; they live in the
// `settings` table and are copied into process.env at boot and on every save,
// so every gate keeps reading the env and nothing else changes.

import type { DB } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";

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

const KEY_SETTING = "typesafe_api_key";
const MODE_SETTING = "typesafe_mode";

// Settings-table values win over whatever the process was launched with, so a
// key typed into the page takes effect without touching the launchd plist.
export function applyTypesafeSettings(db: DB, env: NodeJS.ProcessEnv = process.env): void {
  const key = getSetting(db, KEY_SETTING);
  const mode = getSetting(db, MODE_SETTING);
  if (key) env.TYPESAFE_API_KEY = key;
  if (mode === "off" || mode === "shadow" || mode === "enforce") env.HIVE_TYPESAFE_MODE = mode;
}

export function saveTypesafeSettings(db: DB, body: { api_key?: unknown; mode?: unknown }, env: NodeJS.ProcessEnv = process.env): void {
  if (typeof body.api_key === "string") {
    const key = body.api_key.trim();
    setSetting(db, KEY_SETTING, key);
    if (key) env.TYPESAFE_API_KEY = key;
    else delete env.TYPESAFE_API_KEY;
  }
  if (body.mode === "off" || body.mode === "shadow" || body.mode === "enforce") {
    setSetting(db, MODE_SETTING, body.mode);
    env.HIVE_TYPESAFE_MODE = body.mode;
  }
}

export type TypesafeStatus = {
  configured: boolean;
  key_hint: string | null; // last 4 characters, never the key
  key_source: "settings" | "env" | null;
  mode: TypesafeMode;
};

export function typesafeStatus(db: DB, env: NodeJS.ProcessEnv = process.env): TypesafeStatus {
  const key = env.TYPESAFE_API_KEY ?? "";
  return {
    configured: !!key,
    key_hint: key ? key.slice(-4) : null,
    key_source: key ? (getSetting(db, KEY_SETTING) === key ? "settings" : "env") : null,
    mode: typesafeMode(env),
  };
}

// One round trip with a fixed question, reporting the HTTP status instead of
// failing open, so the Settings page can tell a bad key from a dead network.
export async function probeTypesafe(
  opts: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}
): Promise<{ ok: boolean; status: number | null; ms: number; model: string | null; error: string | null }> {
  const env = opts.env ?? process.env;
  if (!env.TYPESAFE_API_KEY) return { ok: false, status: null, ms: 0, model: null, error: "no API key set" };
  const f = opts.fetch ?? fetch;
  const started = Date.now();
  try {
    const res = await f(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        state: { command: "ls -la" },
        model: env.TYPESAFE_MODEL || "jev-latest",
        questions: { read_only: { type: "noul", instructions: "Is this shell command read-only?" } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, status: res.status, ms, model: null, error: (await res.text()).slice(0, 200) };
    const body: any = await res.json();
    return { ok: true, status: res.status, ms, model: String(body?.model ?? ""), error: null };
  } catch (e: any) {
    return { ok: false, status: null, ms: Date.now() - started, model: null, error: String(e?.message ?? e) };
  }
}

// Per-project tuning under `config.typesafe`, e.g.
//   { "mode": "enforce", "refute_at": 0.05, "confirm_at": 0.95,
//     "needs_person_at": 0.5, "risk_max": 1.5, "triage_mechanical_at": 0.9,
//     "explain_decide_at": 0.9 }
// Every field is optional; a project without the block gets the defaults, and
// no project can turn Jev on without TYPESAFE_API_KEY in the server env.
export interface TypesafeThresholds {
  refute_at: number; // reviewer: risk_real at or below this → refuted without opus
  confirm_at: number; // reviewer: risk_real at or above this → confirmed without opus
  needs_person_at: number; // intent: needs_person at or above this holds the draft
  risk_max: number | null; // inbox: Jev risk score (0 low … 3 high) a card may carry and still auto-approve; null keeps the explicit low/normal text bar
  triage_mechanical_at: number; // intake: P(mechanical) at or above this skips the sonnet triage
  explain_decide_at: number; // command cards: Jev's verdict stands without haiku when its choice confidence and read-only probability both clear this
}
export const DEFAULT_THRESHOLDS: TypesafeThresholds = {
  refute_at: 0.05,
  confirm_at: 0.95,
  needs_person_at: 0.5,
  risk_max: null,
  triage_mechanical_at: 0.9,
  explain_decide_at: 0.9,
};

export function typesafeSettings(
  projectConfig: unknown,
  env: NodeJS.ProcessEnv = process.env
): { mode: TypesafeMode; thresholds: TypesafeThresholds } {
  const raw: any = projectConfig && typeof projectConfig === "object" ? (projectConfig as any).typesafe : null;
  const envMode = typesafeMode(env);
  const mode: TypesafeMode =
    envMode === "off" ? "off" : raw?.mode === "enforce" || raw?.mode === "shadow" || raw?.mode === "off" ? raw.mode : envMode;
  const num = (v: unknown, max: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
  return {
    mode,
    thresholds: {
      refute_at: num(raw?.refute_at, 1) ?? DEFAULT_THRESHOLDS.refute_at,
      confirm_at: num(raw?.confirm_at, 1) ?? DEFAULT_THRESHOLDS.confirm_at,
      needs_person_at: num(raw?.needs_person_at, 1) ?? DEFAULT_THRESHOLDS.needs_person_at,
      risk_max: raw?.risk_max === null ? null : num(raw?.risk_max, 3) ?? DEFAULT_THRESHOLDS.risk_max,
      triage_mechanical_at: num(raw?.triage_mechanical_at, 1) ?? DEFAULT_THRESHOLDS.triage_mechanical_at,
      explain_decide_at: num(raw?.explain_decide_at, 1) ?? DEFAULT_THRESHOLDS.explain_decide_at,
    },
  };
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
