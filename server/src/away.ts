// Away mode: hold low-urgency phone pushes, batch them into one "while you were
// away" summary.
//
// The problem this solves: every urgent notification pushes to the phone the
// moment it happens. Overnight that is a decision card at 03:14 for something
// that could have waited until breakfast. Away mode holds those pushes and
// sends ONE summary when it lifts.
//
// What still gets through while away: the `always_through` classes. The
// defaults are the things you would want to be woken for — a security event,
// a spend blowout, the whole fleet going down, a second failure on the same
// task. Everything else waits.
//
// Config lives in the `away_mode` settings key as JSON; the held pushes live in
// `away_held` as a JSON array.
// ponytail: settings JSON, not a table — the held list is small, short-lived,
// and never queried by anything but the flush. A table if it ever needs
// per-item state.
import type { DB } from "./db.ts";
import { getSetting, setSetting, now } from "./db.ts";
import { broadcast } from "./bus.ts";
import { pushToAll } from "./push.ts";
import type { PushPayload } from "./push.ts";

// How an outgoing push is classified. `always_through` is a list of these.
export type PushClass = "decision" | "quiz-digest" | "security" | "spend" | "fleet_down" | "second_failure" | "info";

export interface AwaySchedule {
  start: string; // "23:00" local wall clock in `tz`
  end: string; // "08:00"
  tz: string; // IANA zone, e.g. "Asia/Seoul"
}

export interface AwayConfig {
  on: boolean;
  schedule?: AwaySchedule;
  always_through: PushClass[];
}

export const DEFAULT_ALWAYS_THROUGH: PushClass[] = ["security", "spend", "fleet_down", "second_failure"];

export interface HeldPush {
  at: string;
  class: PushClass;
  title: string;
  body: string | null;
  url: string;
}

// Keeps the settings row bounded if away mode is left on for a long time. The
// summary still counts everything held; only the stored detail is trimmed.
const MAX_HELD = 200;

// Notification kind -> push class. Kinds not listed are `info` (held while
// away). An enqueue can override this with an explicit class.
const KIND_CLASS: Record<string, PushClass> = {
  decision: "decision",
  decision_nag: "decision",
  review: "decision",
  quiz_digest: "quiz-digest",
  circuit_breaker: "fleet_down",
  agent_unreachable: "fleet_down",
  auth_lost: "fleet_down",
  incident: "fleet_down",
};

export function classOfKind(kind: string): PushClass {
  return KIND_CLASS[kind] ?? "info";
}

export function getAway(db: DB): AwayConfig {
  try {
    const raw = JSON.parse(getSetting(db, "away_mode") || "{}");
    return {
      on: !!raw.on,
      schedule: validSchedule(raw.schedule) ? raw.schedule : undefined,
      always_through: Array.isArray(raw.always_through) ? (raw.always_through as PushClass[]) : DEFAULT_ALWAYS_THROUGH,
    };
  } catch {
    return { on: false, always_through: DEFAULT_ALWAYS_THROUGH };
  }
}

function validSchedule(s: any): s is AwaySchedule {
  return !!s && typeof s.start === "string" && typeof s.end === "string" && typeof s.tz === "string" && !!parseHm(s.start) && !!parseHm(s.end);
}

export function setAway(db: DB, cfg: AwayConfig): void {
  setSetting(db, "away_mode", JSON.stringify(cfg));
}

function parseHm(v: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

// Minutes since midnight in the schedule's timezone. Intl does the zone math,
// so no date library and no DST arithmetic of our own.
function minutesInZone(tz: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(
    new Date(atMs)
  );
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (h % 24) * 60 + m;
}

// Is `atMs` inside the window? A window that wraps midnight (23:00 -> 08:00) is
// the normal case, so both orderings are handled. Start is inclusive, end is
// exclusive: at exactly 08:00 you are awake.
export function inWindow(schedule: AwaySchedule, atMs: number): boolean {
  const start = parseHm(schedule.start);
  const end = parseHm(schedule.end);
  if (!start || !end) return false;
  let mins: number;
  try {
    mins = minutesInZone(schedule.tz, atMs);
  } catch {
    return false; // bad tz: never hold, better to over-notify than to swallow
  }
  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;
  if (s === e) return false;
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}

// Should away mode be active at `atMs`? The manual switch wins; otherwise the
// schedule decides. Only `syncAway` acts on this — it is the desired state, not
// the live one.
export function desiredAway(db: DB, atMs: number = Date.now()): boolean {
  const cfg = getAway(db);
  if (cfg.on) return true;
  return cfg.schedule ? inWindow(cfg.schedule, atMs) : false;
}

// Away RIGHT NOW, as every outgoing push sees it. The schedule half is latched
// by the reconciler into `away_active` so a push does not have to recompute a
// timezone window on every notification, and so the flush on wake pairs exactly
// with the holds that preceded it. The manual switch is read live, so toggling
// it takes effect on the very next push rather than at the next tick.
export function awayNow(db: DB): boolean {
  return getAway(db).on || getSetting(db, "away_active") === "1";
}

function readHeld(db: DB): HeldPush[] {
  try {
    const rows = JSON.parse(getSetting(db, "away_held") || "[]");
    return Array.isArray(rows) ? (rows as HeldPush[]) : [];
  } catch {
    return [];
  }
}

export function heldPushes(db: DB): HeldPush[] {
  return readHeld(db);
}

// Decide what to do with one outgoing push. Returns true when it was held (the
// caller must NOT push), false when it should go out now.
export function holdIfAway(db: DB, cls: PushClass, payload: PushPayload): boolean {
  if (!awayNow(db)) return false;
  if (getAway(db).always_through.includes(cls)) return false;
  const held = readHeld(db);
  held.push({ at: now(), class: cls, title: payload.title, body: payload.body ?? null, url: payload.url ?? "/" });
  setSetting(db, "away_held", JSON.stringify(held.slice(-MAX_HELD)));
  return true;
}

export interface FlushDeps {
  push?: typeof pushToAll;
}

// Away mode lifted: send ONE summary push for everything held, then clear the
// list. No-op when nothing was held.
export function flushHeld(db: DB, deps: FlushDeps = {}): { count: number; summary: string } {
  const held = readHeld(db);
  setSetting(db, "away_held", "[]");
  if (!held.length) return { count: 0, summary: "" };
  const summary = `While you were away: ${held.length} item${held.length === 1 ? "" : "s"}`;
  void (deps.push ?? pushToAll)(db, { title: summary, body: held[held.length - 1].title, url: "/inbox" }).catch(() => {});
  return { count: held.length, summary };
}

// Reconciler step: turn away mode on/off by its schedule and flush on wake.
// Returns what changed so callers (and tests) can assert on it.
export function syncAway(db: DB, atMs: number = Date.now(), deps: FlushDeps = {}): { active: boolean; flushed: number } {
  const active = desiredAway(db, atMs);
  const was = getSetting(db, "away_active") === "1";
  if (active === was) return { active, flushed: 0 };
  setSetting(db, "away_active", active ? "1" : "0");
  broadcast({ type: "away", active });
  if (active) return { active, flushed: 0 };
  const { count } = flushHeld(db, deps);
  return { active, flushed: count };
}
