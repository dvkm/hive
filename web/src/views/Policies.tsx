import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Policy } from "../lib/api";
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
