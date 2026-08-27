import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Project, PrGardenerItem, Kind, State } from "../lib/api";
import { useStore } from "../lib/store";
import { STATE_LABEL, toast } from "../lib/ui";
import { isAbsoluteRepoPath, repoPathPlaceholder } from "../lib/paths";

// Config keys the structured editor owns; everything else is edited as raw JSON.
const STRUCTURED_KEYS = ["agent", "auto_dispatch", "max_agents", "dispatch_kinds", "supervisor_persona", "playbook"];
const ALL_KINDS: Kind[] = ["ship", "scout", "chore"];
type Agent = "claude" | "codex";
// States worth surfacing as per-project counts (skip terminal cancelled).
const COUNT_STATES: State[] = ["queued", "in_progress", "needs_decision", "in_review", "verifying", "done", "failed"];

function restConfig(config: Project["config"]): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...config };
  for (const k of STRUCTURED_KEYS) delete rest[k];
  return rest;
}

export default function Projects() {
  const { tasks, reloadProjects } = useStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // The Projects surface shows archived projects too (with a toggle to restore).
  const load = () =>
    api.projects({ archived: true }).then(setProjects).catch(() => setProjects([]));
  useEffect(() => {
    load();
  }, []);

  // Any create/edit/archive both refreshes this list and the shared store list
  // (board switcher, new-task modal, policies).
  const refresh = () => {
    load();
    reloadProjects();
  };

  const countsFor = (id: string) => {
    const c: Partial<Record<State, number>> = {};
    for (const t of tasks) if (t.project_id === id) c[t.state] = (c[t.state] || 0) + 1;
    return c;
  };

  return (
    <div className="projects">
      <div className="proj-head">
        <h1>Projects</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + New project
        </button>
      </div>
      <p className="muted proj-intro">
        A project scopes tasks to a repo and carries the config the dispatcher, planner, and monitors
        read. Archiving hides a project without deleting it (existing tasks keep referencing it).
      </p>

      {projects.length === 0 ? (
        <div className="empty">
          <div className="empty-big">No projects yet</div>
          <div className="muted">Add your first to start queueing work against a repo.</div>
        </div>
      ) : (
        <div className="proj-list">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              p={p}
              counts={countsFor(p.id)}
              open={openId === p.id}
              onToggleOpen={() => setOpenId((id) => (id === p.id ? null : p.id))}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {adding && (
        <NewProjectModal
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ProjectCard({
  p,
  counts,
  open,
  onToggleOpen,
  onChanged,
}: {
  p: Project;
  counts: Partial<Record<State, number>>;
  open: boolean;
  onToggleOpen: () => void;
  onChanged: () => void;
}) {
  const archived = p.config?.archived === true;
  const isTest = p.config?.test === true;
  const autoDispatch = p.config?.auto_dispatch === true;
  const agent = p.config?.agent === "codex" ? "codex" : "claude";
  const monitors = (p.config?.monitors?.length as number) || 0;
  const gardenerEnabled = p.config?.pr_gardener?.enabled === true;
  const total = COUNT_STATES.reduce((n, s) => n + (counts[s] || 0), 0);

  const toggleArchive = async () => {
    await api.updateProject(p.id, { config: { ...p.config, archived: !archived } });
    toast(archived ? "Project restored" : "Project archived");
    onChanged();
  };

  return (
    <div className={`proj-card ${archived ? "proj-archived" : ""}`}>
      <div className="proj-card-head">
        <div className="proj-name">
          {p.name}
          {archived && <span className="chip chip-off">archived</span>}
          {isTest && <span className="chip chip-off" title="repo_path pointed at a worktree/scratchpad — hidden from tasks/decisions/notifications">test</span>}
        </div>
        <div className="spacer" />
        <button className="link-btn" onClick={onToggleOpen}>
          {open ? "close" : "edit"}
        </button>
        <button className="link-btn" onClick={toggleArchive}>
          {archived ? "restore" : "archive"}
        </button>
      </div>

      <code className="proj-repo" title={p.repo_path || ""}>
        {p.repo_path || "no repo_path set"}
      </code>

      <div className="proj-meta">
        <span className={`chip ${autoDispatch ? "effect-allow" : ""}`}>
          auto-dispatch {autoDispatch ? "on" : "off"}
        </span>
        <span className="chip">{agent === "codex" ? "ChatGPT · Codex" : "Claude Code"}</span>
        <span className="chip">{monitors} monitor{monitors === 1 ? "" : "s"}</span>
        <span className={`chip ${gardenerEnabled ? "effect-allow" : ""}`}>PR Gardener {gardenerEnabled ? "on" : "off"}</span>
        <span className="chip">{total} task{total === 1 ? "" : "s"}</span>
      </div>

      <div className="proj-counts">
        {total === 0 && <span className="muted">No tasks yet.</span>}
        {COUNT_STATES.map((s) =>
          counts[s] ? (
            <span key={s} className="proj-count">
              <span className={`sdot sdot-${s}`} /> {STATE_LABEL[s]} {counts[s]}
            </span>
          ) : null
        )}
      </div>

      {gardenerEnabled && <GardenerQueue projectId={p.id} />}

      {open && <ProjectEditor p={p} onSaved={onChanged} onClose={onToggleOpen} />}
    </div>
  );
}

function GardenerQueue({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<PrGardenerItem[]>([]);
  const load = () => api.prGardener(projectId).then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, [projectId]);

  const setOverride = async (item: PrGardenerItem, override: PrGardenerItem["override"]) => {
    try {
      await api.setPrGardenerOverride(projectId, item.pr_number, override);
      toast(override === "hold" ? `PR #${item.pr_number} held` : override ? `PR #${item.pr_number} queued for the next sweep` : `PR #${item.pr_number} released`);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="gardener-queue">
      <div className="gardener-title">PR Gardener queue</div>
      {items.length === 0 ? <span className="muted">No open PRs have been classified yet.</span> : items.map((item) => (
        <div className="gardener-row" key={item.pr_number}>
          <a href={item.pr_url} target="_blank" rel="noreferrer">#{item.pr_number} {item.title}</a>
          <span className="chip">{item.classification}</span>
          {item.sensitive === 1 && <span className="chip chip-off">sensitive</span>}
          <span className="gardener-reason">{item.reason}</span>
          <div className="gardener-actions">
            {item.override === "hold" ? (
              <button className="link-btn" onClick={() => setOverride(item, null)}>release</button>
            ) : (
              <button className="link-btn" onClick={() => setOverride(item, "hold")}>hold</button>
            )}
            {item.linked_task_state === "in_review" && <button className="link-btn" onClick={() => setOverride(item, "force_land")}>land</button>}
            <button className="link-btn" onClick={() => setOverride(item, "force_close")}>close</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Inline expand: name/repo_path + a STRUCTURED editor for the common config keys,
// plus a validated raw-JSON editor for everything else. Save via PUT (config is
// replaced wholesale, so we recombine structured fields + the raw remainder).
function ProjectEditor({ p, onSaved, onClose }: { p: Project; onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState(p.name);
  const [repoPath, setRepoPath] = useState(p.repo_path || "");
  const [agent, setAgent] = useState<Agent>(p.config?.agent === "codex" ? "codex" : "claude");
  const [autoDispatch, setAutoDispatch] = useState(p.config?.auto_dispatch === true);
  const [maxAgents, setMaxAgents] = useState(
    p.config?.max_agents != null ? String(p.config.max_agents) : ""
  );
  const [dispatchKinds, setDispatchKinds] = useState<Kind[]>(
    (p.config?.dispatch_kinds as Kind[]) || ["ship", "scout"]
  );
  const [persona, setPersona] = useState(p.config?.supervisor_persona || "");
  const [playbook, setPlaybook] = useState(p.config?.playbook || "");
  const [rawJson, setRawJson] = useState(JSON.stringify(restConfig(p.config), null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleKind = (k: Kind) =>
    setDispatchKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));

  const save = async () => {
    if (!name.trim() || !repoPath.trim() || busy) return;
    let rest: Record<string, unknown>;
    try {
      rest = rawJson.trim() ? JSON.parse(rawJson) : {};
      if (typeof rest !== "object" || Array.isArray(rest)) throw new Error("must be an object");
    } catch (e) {
      setJsonErr((e as Error).message);
      toast("Fix the raw JSON before saving");
      return;
    }
    setJsonErr(null);
    const config: Record<string, unknown> = { ...rest, agent, auto_dispatch: autoDispatch, dispatch_kinds: dispatchKinds };
    if (maxAgents.trim()) config.max_agents = Number(maxAgents);
    if (persona.trim()) config.supervisor_persona = persona;
    if (playbook.trim()) config.playbook = playbook;
    setBusy(true);
    try {
      await api.updateProject(p.id, { name: name.trim(), repo_path: repoPath.trim(), config });
      toast("Project saved");
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="proj-editor">
      <label className="fld">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="fld">
        <span>Repo path (absolute)</span>
        <input className="mono-input" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder={repoPathPlaceholder} />
      </label>

      <div className="proj-config">
        <h3>Config</h3>
        <label className="fld">
          <span>Worker</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
            <option value="claude">Claude Code</option>
            <option value="codex">ChatGPT (Codex CLI)</option>
          </select>
        </label>
        <label className="ck proj-switch">
          <input type="checkbox" checked={autoDispatch} onChange={(e) => setAutoDispatch(e.target.checked)} />
          Auto-dispatch queued ship/scout tasks
        </label>

        <label className="fld">
          <span>Max concurrent agents</span>
          <input type="number" min={1} value={maxAgents} onChange={(e) => setMaxAgents(e.target.value)} placeholder="3 (default)" />
        </label>

        <div className="fld">
          <span>Dispatch kinds</span>
          <div className="proj-kinds">
            {ALL_KINDS.map((k) => (
              <label key={k} className="ck">
                <input type="checkbox" checked={dispatchKinds.includes(k)} onChange={() => toggleKind(k)} />
                {k}
              </label>
            ))}
          </div>
        </div>

        <label className="fld">
          <span>Supervisor persona</span>
          <textarea value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="Planner identity injected into every planner prompt (optional)" />
        </label>
        <label className="fld">
          <span>Playbook</span>
          <textarea value={playbook} onChange={(e) => setPlaybook(e.target.value)} placeholder="Freeform project context injected into planner prompts (optional)" />
        </label>

        <label className="fld">
          <span>Other config (raw JSON)</span>
          <textarea
            className="mono-input proj-raw"
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="proj-raw-warn muted">
          ⚠ Advanced. Holds every key not covered above (monitors, smoke, gchat_spaces, pricing, agent_argv,
          plan_intake, archived, …). Must be a valid JSON object; it is merged with the fields above on save.
        </p>
        {jsonErr && <div className="notice">Invalid JSON: {jsonErr}</div>}
      </div>

      <div className="proj-editor-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !name.trim() || !repoPath.trim()} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// Create-project modal. Esc closes, Cmd/Ctrl+Enter submits (matches NewTaskModal).
function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [agent, setAgent] = useState<Agent>("claude");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || !repoPath.trim() || busy) return;
    if (!isAbsoluteRepoPath(repoPath)) {
      toast("Repo path must be absolute");
      return;
    }
    setBusy(true);
    try {
      // Sensible empty config: default_branch main, everything else off/default.
      await api.createProject({ name: name.trim(), repo_path: repoPath.trim(), config: { default_branch: "main", agent } });
      toast("Project created");
      onCreated();
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
        <h2>New project</h2>
        <label className="fld">
          <span>Name</span>
          <input autoFocus placeholder="acme-web" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="fld">
          <span>Repo path (absolute)</span>
          <input className="mono-input" placeholder={repoPathPlaceholder} value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
        </label>
        <label className="fld">
          <span>Worker</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
            <option value="claude">Claude Code</option>
            <option value="codex">ChatGPT (Codex CLI)</option>
          </select>
        </label>
        <div className="modal-foot">
          <span className="muted modal-hint">⌘↵ to create · Esc to close</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || !repoPath.trim()} onClick={submit}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}
