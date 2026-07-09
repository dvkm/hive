import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Policy, AuthorityRule } from "../lib/api";
import { useStore } from "../lib/store";
import { toast } from "../lib/ui";

export default function Policies() {
  const { projects } = useStore();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState("global");

  const load = () => api.policies().then(setPolicies);
  useEffect(() => {
    load();
  }, []);

  const scopeName = (s: string) => {
    if (s === "global") return "Global";
    const id = s.replace("project:", "");
    return projects.find((p) => p.id === id)?.name || s;
  };

  const add = async () => {
    if (!title.trim() || !body.trim()) return;
    await api.createPolicy({ title, body, scope });
    setTitle("");
    setBody("");
    toast("Policy added");
    load();
  };

  const toggle = async (p: Policy) => {
    await api.updatePolicy(p.id, { active: !p.active });
    load();
  };

  const saveEdit = async (p: Policy, t: string, b: string) => {
    await api.updatePolicy(p.id, { title: t, body: b });
    toast("Policy updated");
    load();
  };

  return (
    <div className="policies">
      <AutoDispatch />
      <Authority projects={projects} scopeName={scopeName} />

      <section className="panel add-policy">
        <h2>Add policy</h2>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea placeholder="Body (injected into every brief)" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="global">Global</option>
            {projects.map((p) => (
              <option key={p.id} value={`project:${p.id}`}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={add}>
            Add
          </button>
        </div>
      </section>

      <div className="policy-list">
        {policies.map((p) => (
          <PolicyRow key={p.id} p={p} scopeName={scopeName(p.scope)} onToggle={() => toggle(p)} onSave={saveEdit} />
        ))}
        {policies.length === 0 && <div className="muted pad">No policies yet.</div>}
      </div>
    </div>
  );
}

// Per-project auto-dispatch toggle. When on, the dispatcher auto-spawns agents
// for that project's queued ship/scout tasks (default off, so nothing spawns
// without David opting in). Writes project config.auto_dispatch.
function AutoDispatch() {
  const [projects, setProjects] = useState<import("../lib/api").Project[]>([]);
  const load = () => api.projects().then(setProjects).catch(() => setProjects([]));
  useEffect(() => {
    load();
  }, []);

  const toggle = async (p: import("../lib/api").Project) => {
    const auto_dispatch = !(p.config?.auto_dispatch === true);
    await api.updateProject(p.id, { config: { ...p.config, auto_dispatch } });
    toast(auto_dispatch ? "Auto-dispatch on" : "Auto-dispatch off");
    load();
  };

  return (
    <section className="panel authority">
      <h2>Auto-dispatch</h2>
      <p className="muted">
        When on, hive automatically spawns an agent for each queued ship/scout task in the project (subject
        to the concurrency cap and standing authority). Off by default; intake drafts and chore tasks are
        never auto-dispatched.
      </p>
      <div className="authority-list">
        {projects.map((p) => (
          <div key={p.id} className="authority-rule">
            <span className="chip">{p.name}</span>
            {p.config?.auto_dispatch === true && <span className="chip effect-allow">on</span>}
            <div className="spacer" />
            <button className="link-btn" onClick={() => toggle(p)}>
              {p.config?.auto_dispatch === true ? "turn off" : "turn on"}
            </button>
          </div>
        ))}
        {projects.length === 0 && <div className="muted pad">No projects yet.</div>}
      </div>
    </section>
  );
}

const EFFECTS = ["allow", "require_decision", "deny"] as const;

function Authority({
  projects,
  scopeName,
}: {
  projects: { id: string; name: string }[];
  scopeName: (s: string) => string;
}) {
  const [rules, setRules] = useState<AuthorityRule[]>([]);
  const [pattern, setPattern] = useState("");
  const [effect, setEffect] = useState<string>("require_decision");
  const [note, setNote] = useState("");
  const [project, setProject] = useState("global");

  const load = () => api.authorityRules().then(setRules);
  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!pattern.trim()) return;
    await api.createAuthorityRule({
      project_id: project === "global" ? null : project,
      action_pattern: pattern.trim(),
      effect,
      note: note.trim() || undefined,
    });
    setPattern("");
    setNote("");
    toast("Authority rule added");
    load();
  };

  const deactivate = async (r: AuthorityRule) => {
    await api.updateAuthorityRule(r.id, { active: !r.active });
    load();
  };

  return (
    <section className="panel authority">
      <h2>Standing authority</h2>
      <p className="muted">
        Grant scoped authority once; the server enforces it before risky actions dispatch. Most-specific
        active rule wins (project over global, longer pattern over shorter). Unmatched actions default to
        allow and are logged.
      </p>

      <div className="row authority-add">
        <input placeholder="action pattern (e.g. deploy.prod, flag.*)" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <select value={effect} onChange={(e) => setEffect(e.target.value)}>
          {EFFECTS.map((ef) => (
            <option key={ef} value={ef}>
              {ef}
            </option>
          ))}
        </select>
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="global">Global</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-primary" onClick={add}>
          Add rule
        </button>
      </div>

      <div className="authority-list">
        {rules.map((r) => (
          <div key={r.id} className={`authority-rule ${r.active ? "" : "policy-off"}`}>
            <span className="chip">{scopeName(r.scope)}</span>
            <code className="authority-pattern">{r.action_pattern}</code>
            <span className={`chip effect-${r.effect}`}>{r.effect}</span>
            {r.note && <span className="muted authority-note">{r.note}</span>}
            {!r.active && <span className="chip chip-off">inactive</span>}
            <div className="spacer" />
            <button className="link-btn" onClick={() => deactivate(r)}>
              {r.active ? "deactivate" : "activate"}
            </button>
          </div>
        ))}
        {rules.length === 0 && <div className="muted pad">No authority rules yet.</div>}
      </div>
    </section>
  );
}

function PolicyRow({
  p,
  scopeName,
  onToggle,
  onSave,
}: {
  p: Policy;
  scopeName: string;
  onToggle: () => void;
  onSave: (p: Policy, t: string, b: string) => void;
}) {
  const [edit, setEdit] = useState(false);
  const [t, setT] = useState(p.title);
  const [b, setB] = useState(p.body);

  return (
    <div className={`policy ${p.active ? "" : "policy-off"}`}>
      <div className="policy-head">
        <span className="chip">{scopeName}</span>
        {!p.active && <span className="chip chip-off">inactive</span>}
        <div className="spacer" />
        <button className="link-btn" onClick={() => setEdit((e) => !e)}>
          {edit ? "cancel" : "edit"}
        </button>
        <button className="link-btn" onClick={onToggle}>
          {p.active ? "deactivate" : "activate"}
        </button>
      </div>
      {edit ? (
        <>
          <input value={t} onChange={(e) => setT(e.target.value)} />
          <textarea value={b} onChange={(e) => setB(e.target.value)} />
          <button
            className="btn btn-primary"
            onClick={() => {
              onSave(p, t, b);
              setEdit(false);
            }}
          >
            Save
          </button>
        </>
      ) : (
        <>
          <strong>{p.title}</strong>
          <p className="policy-body">{p.body}</p>
        </>
      )}
    </div>
  );
}
