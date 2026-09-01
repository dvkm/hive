import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Policy, AuthorityRule, Project } from "../lib/api";
import { keepTrying, useStore } from "../lib/store";
import { toast } from "../lib/ui";

// The Policies page is a settings surface for standing configuration: three
// distinct concerns kept as well-separated sections on one scrollable page (not
// tabs) so the director can read their whole standing config at a glance and see how the
// pieces relate (a "prod deploy" policy and a "deploy.prod*" authority rule are
// conceptually linked). Each section leads with what it does and WHEN it applies.
export default function Policies() {
  const { projects } = useStore();

  const scopeName = (s: string) => {
    if (s === "global") return "Global";
    const id = s.replace("project:", "");
    return projects.find((p) => p.id === id)?.name || s;
  };

  return (
    <div className="policies pol-page">
      <header className="pol-page-head">
        <h1>Policies &amp; authority</h1>
        <p className="muted">
          Standing configuration that shapes every future task. Set it once here; the server injects and
          enforces it automatically, so nothing has to be repeated per task or when a context window compacts.
        </p>
      </header>

      <PoliciesSection projects={projects} scopeName={scopeName} />
      <AuthoritySection projects={projects} scopeName={scopeName} />
      <AutoDispatchSection />
    </div>
  );
}

/* ---------- shared section chrome ---------- */

function Section({
  title,
  when,
  blurb,
  count,
  action,
  children,
}: {
  title: string;
  when: string;
  blurb: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="pol-section">
      <div className="pol-section-head">
        <div className="pol-section-heading">
          <h2>
            {title}
            {count != null && <span className="pol-count">{count}</span>}
          </h2>
          <p className="pol-blurb">
            <span className="pol-when">{when}</span> {blurb}
          </p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ text, actionLabel, onAction }: { text: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="pol-empty">
      <p>{text}</p>
      <button className="btn btn-primary" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

/* ---------- 1. standing policies ---------- */

function PoliciesSection({ projects, scopeName }: { projects: Project[]; scopeName: (s: string) => string }) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [editing, setEditing] = useState<Policy | "new" | null>(null);

  const load = () => api.policies().then(setPolicies);
  useEffect(() => {
    load();
  }, []);

  const toggle = async (p: Policy) => {
    await api.updatePolicy(p.id, { active: !p.active });
    toast(p.active ? "Policy deactivated" : "Policy activated");
    load();
  };

  return (
    <Section
      title="Standing policies"
      when="Injected into every agent brief at spawn."
      blurb="Durable preferences and guardrails, written as prose. Global policies apply everywhere; project policies apply only to that project's tasks."
      count={policies.length}
      action={
        <button className="btn btn-primary btn-new" onClick={() => setEditing("new")}>
          + Add policy
        </button>
      }
    >
      {policies.length === 0 ? (
        <EmptyState
          text="No policies yet. Policies are standing instructions (coding conventions, tone, do-not-touch lists) that ride along in every agent brief so you never have to repeat them."
          actionLabel="+ Add your first policy"
          onAction={() => setEditing("new")}
        />
      ) : (
        <div className="pol-list">
          {policies.map((p) => (
            <div key={p.id} className={`pol-card ${p.active ? "" : "pol-inactive"}`}>
              <div className="pol-card-head">
                <span className="chip">{scopeName(p.scope)}</span>
                {!p.active && <span className="chip chip-off">inactive</span>}
                <div className="spacer" />
                <button className="link-btn" onClick={() => setEditing(p)}>
                  edit
                </button>
                <button className="link-btn" onClick={() => toggle(p)}>
                  {p.active ? "deactivate" : "activate"}
                </button>
              </div>
              <strong className="pol-card-title">{p.title}</strong>
              <p className="pol-card-body">{p.body}</p>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <PolicyModal
          policy={editing === "new" ? null : editing}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </Section>
  );
}

function PolicyModal({
  policy,
  projects,
  onClose,
  onSaved,
}: {
  policy: Policy | null;
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(policy?.title || "");
  const [body, setBody] = useState(policy?.body || "");
  const [scope, setScope] = useState(policy?.scope || "global");
  const [busy, setBusy] = useState(false);
  const valid = title.trim() && body.trim();

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      if (policy) await api.updatePolicy(policy.id, { title: title.trim(), body: body.trim(), scope });
      else await api.createPolicy({ title: title.trim(), body: body.trim(), scope });
      toast(policy ? "Policy updated" : "Policy added");
      onSaved();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <h2>{policy ? "Edit policy" : "Add policy"}</h2>
        <label className="fld">
          <span>Title</span>
          <input autoFocus placeholder="e.g. Always write tests" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="fld">
          <span>Body — injected verbatim into briefs</span>
          <textarea
            placeholder="e.g. Every code change ships with tests. No exceptions for logic changes."
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <label className="fld">
          <span>Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="global">Global — every project</option>
            {projects.map((p) => (
              <option key={p.id} value={`project:${p.id}`}>
                {p.name} only
              </option>
            ))}
          </select>
        </label>
        <div className="modal-foot">
          <span className="muted modal-hint">⌘↵ to save · Esc to close</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving…" : policy ? "Save changes" : "Add policy"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 2. standing authority ---------- */

const EFFECTS = [
  {
    key: "allow",
    label: "Allow",
    verb: "is allowed automatically",
    help: "The agent proceeds without asking. Use for actions you trust it to run on its own.",
  },
  {
    key: "require_decision",
    label: "Require decision",
    verb: "requires a decision card",
    help: "hive opens a decision card naming the exact target and waits for your approval before the action runs.",
  },
  {
    key: "deny",
    label: "Deny",
    verb: "is blocked",
    help: "The action is refused server-side and logged. The agent cannot run it at all.",
  },
] as const;

const effectVerb = (e: string) => EFFECTS.find((x) => x.key === e)?.verb || e;

function AuthoritySection({ projects, scopeName }: { projects: Project[]; scopeName: (s: string) => string }) {
  const [rules, setRules] = useState<AuthorityRule[]>([]);
  const [adding, setAdding] = useState(false);

  const load = () => api.authorityRules().then(setRules);
  useEffect(() => {
    load();
  }, []);

  const toggle = async (r: AuthorityRule) => {
    await api.updateAuthorityRule(r.id, { active: !r.active });
    load();
  };

  return (
    <Section
      title="Standing authority"
      when="Enforced server-side on guarded actions."
      blurb="Glob rules that decide what an agent may do before it runs a risky action. Most-specific active rule wins (project over global, longer pattern over shorter); unmatched actions default to allow and are logged."
      count={rules.length}
      action={
        <button className="btn btn-primary btn-new" onClick={() => setAdding(true)}>
          + Add rule
        </button>
      }
    >
      {rules.length === 0 ? (
        <EmptyState
          text="No authority rules yet. A rule matches an action pattern (like deploy.prod* or flag.*) and sets whether it is allowed, needs your sign-off, or is blocked outright before the agent can run it."
          actionLabel="+ Add your first rule"
          onAction={() => setAdding(true)}
        />
      ) : (
        <div className="pol-list">
          {rules.map((r) => (
            <div key={r.id} className={`pol-rule ${r.active ? "" : "pol-inactive"}`}>
              <code className="pol-rule-pattern">{r.action_pattern}</code>
              <span className="pol-rule-arrow">→</span>
              <span className={`chip effect-${r.effect}`}>{effectVerb(r.effect)}</span>
              <span className="chip pol-rule-scope">{scopeName(r.scope)}</span>
              {r.note && <span className="muted pol-rule-note">{r.note}</span>}
              <div className="spacer" />
              {!r.active && <span className="chip chip-off">inactive</span>}
              <button className="link-btn" onClick={() => toggle(r)}>
                {r.active ? "deactivate" : "activate"}
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <AuthorityModal
          projects={projects}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </Section>
  );
}

function AuthorityModal({ projects, onClose, onSaved }: { projects: Project[]; onClose: () => void; onSaved: () => void }) {
  const [pattern, setPattern] = useState("");
  const [effect, setEffect] = useState<string>("require_decision");
  const [project, setProject] = useState("global");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = pattern.trim().length > 0;
  const chosen = EFFECTS.find((e) => e.key === effect)!;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await api.createAuthorityRule({
        project_id: project === "global" ? null : project,
        action_pattern: pattern.trim(),
        effect,
        note: note.trim() || undefined,
      });
      toast("Authority rule added");
      onSaved();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <h2>Add authority rule</h2>
        <label className="fld">
          <span>Action pattern</span>
          <input
            autoFocus
            className="mono"
            placeholder="e.g. deploy.prod*  or  flag.*"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
        </label>

        <div className="fld">
          <span>Effect</span>
          <div className="pol-seg" role="radiogroup" aria-label="Effect">
            {EFFECTS.map((e) => (
              <button
                key={e.key}
                type="button"
                role="radio"
                aria-checked={effect === e.key}
                className={`pol-seg-btn pol-seg-${e.key} ${effect === e.key ? "active" : ""}`}
                onClick={() => setEffect(e.key)}
              >
                {e.label}
              </button>
            ))}
          </div>
          <p className="pol-seg-help muted">{chosen.help}</p>
        </div>

        <label className="fld">
          <span>Scope</span>
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="global">Global — every project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} only
              </option>
            ))}
          </select>
        </label>

        <label className="fld">
          <span>Note (optional)</span>
          <input placeholder="Why this rule exists" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className="pol-rule-preview">
          <code className="pol-rule-pattern">{pattern.trim() || "action"}</code>
          <span className="pol-rule-arrow">→</span>
          <span className={`chip effect-${effect}`}>{chosen.verb}</span>
        </div>

        <div className="modal-foot">
          <span className="muted modal-hint">⌘↵ to add · Esc to close</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Adding…" : "Add rule"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 3. per-project auto-dispatch ---------- */

// Reads live project config (auto_dispatch) and writes it back on toggle. Kept
// as its own fetch (not the store) so the switch reflects the freshest config
// immediately after a write.
export function AutoDispatchSection() {
  const [projects, setProjects] = useState<Project[]>([]);
  // False until a fetch has really landed. An empty list on its own does not
  // mean there are no projects — the fetch may just have failed.
  const [loaded, setLoaded] = useState(false);
  // Rejecting on failure is deliberate: keepTrying needs the rejection to
  // schedule its retry, and the old list stays on screen meanwhile.
  const load = () =>
    api.projects().then((p) => {
      setProjects(p);
      setLoaded(true);
    });
  const loop = useRef<ReturnType<typeof keepTrying>>();
  useEffect(() => {
    loop.current = keepTrying(load);
    return () => loop.current?.stop();
  }, []);

  const toggle = async (p: Project) => {
    const auto_dispatch = !(p.config?.auto_dispatch === true);
    await api.updateProject(p.id, { config: { ...p.config, auto_dispatch } });
    toast(auto_dispatch ? "Auto-dispatch on" : "Auto-dispatch off");
    loop.current?.run();
  };

  return (
    <Section
      title="Auto-dispatch"
      when="Lets hive spawn agents for queued tasks automatically."
      blurb="Per project. When on, the dispatcher spawns an agent for each queued ship/scout task (subject to the concurrency cap and standing authority). Off by default; intake drafts and chores are never auto-dispatched."
    >
      <div className="notice pol-caution">Turning this on spends tokens autonomously — agents start without you clicking dispatch.</div>

      {projects.length === 0 ? (
        loaded ? (
          <div className="pol-empty">
            <p>No projects yet. Auto-dispatch is configured per project, so this list fills in once you have one.</p>
          </div>
        ) : null
      ) : (
        <div className="pol-list">
          {projects.map((p) => {
            const on = p.config?.auto_dispatch === true;
            return (
              <div key={p.id} className="pol-dispatch-row">
                <div className="pol-dispatch-main">
                  <span className="pol-dispatch-name">{p.name}</span>
                  <span className="muted">
                    {on ? "Auto-spawning agents for queued ship/scout tasks" : "Manual dispatch only — you spawn each agent"}
                  </span>
                </div>
                <label className={`pol-switch ${on ? "on" : ""}`} title={on ? "Turn auto-dispatch off" : "Turn auto-dispatch on"}>
                  <input type="checkbox" checked={on} onChange={() => toggle(p)} />
                  <span className="pol-switch-track">
                    <span className="pol-switch-knob" />
                  </span>
                  <span className="pol-switch-label">{on ? "On" : "Off"}</span>
                </label>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
