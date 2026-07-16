// Row shapers: turn raw SQLite rows (JSON stored as TEXT, 0/1 for booleans)
// into the JSON shapes documented in docs/API.md.
export function parseProject(r: any) {
  return { ...r, config: JSON.parse(r.config || "{}") };
}

export function parseTask(r: any) {
  // depends_on is the one JSON column: a (possibly null) array of task ids.
  return { ...r, depends_on: r.depends_on ? JSON.parse(r.depends_on) : [] };
}

export function parseEvent(r: any) {
  return { ...r, payload: JSON.parse(r.payload || "{}") };
}

export function parseEvidence(r: any) {
  return { ...r, meta: JSON.parse(r.meta || "{}") };
}

export function parseDecision(r: any) {
  return { ...r, options: JSON.parse(r.options || "[]") };
}

export function parsePolicy(r: any) {
  return { ...r, active: !!r.active };
}

export function parseIncident(r: any) {
  return r;
}
