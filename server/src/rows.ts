// Row shapers: turn raw SQLite rows (JSON stored as TEXT, 0/1 for booleans)
// into the JSON shapes documented in docs/API.md.
export function parseProject(r: any) {
  return { ...r, config: JSON.parse(r.config || "{}") };
}

export function parseTask(r: any) {
  // depends_on and verification_cmds are the JSON columns: a (possibly null)
  // array of task ids, and a (possibly null) array of {name, cmd}.
  return {
    ...r,
    depends_on: r.depends_on ? JSON.parse(r.depends_on) : [],
    verification_cmds: r.verification_cmds ? JSON.parse(r.verification_cmds) : null,
  };
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
