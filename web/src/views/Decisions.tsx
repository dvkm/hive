import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useStore } from "../lib/store";
import { useProjectFilter, inProjectFilter } from "../lib/projectFilter";
import { Empty } from "../lib/ui";
import { DecisionCard } from "./DecisionCard";
import { CheckpointsInbox } from "./Checkpoints";

export default function Decisions() {
  const { decisions, tasks } = useStore();
  const projectFilter = useProjectFilter();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Decisions carry task_id, not project_id — resolve the project via the task.
  const taskProject = new Map(tasks.map((t) => [t.id, t.project_id]));
  const list = decisions.filter(
    (d) => !hidden.has(d.id) && inProjectFilter(taskProject.get(d.task_id), projectFilter)
  );
  const hide = (id: string) => setHidden((h) => new Set(h).add(id));

  // Scroll to and briefly highlight a card when arrived from the palette
  // (navigate("/decisions#dcard-<id>")).
  const location = useLocation();
  useEffect(() => {
    const id = location.hash.replace(/^#/, "");
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("dcard-flash");
    const t = setTimeout(() => el.classList.remove("dcard-flash"), 1600);
    return () => clearTimeout(t);
  }, [location.hash, list.length]);

  return (
    <div className="inbox">
      <div className="page-head">
        <h1 className="page-title">Decisions</h1>
        <p className="page-sub">
          {list.length === 0
            ? "Agents are unblocked."
            : `${list.length} agent${list.length === 1 ? " is" : "s are"} blocked waiting on you.`}
        </p>
      </div>
      <CheckpointsInbox />
      {list.length === 0 && (
        <Empty
          title="Inbox zero"
          hint="When an agent hits a call only you can make, its question shows up here with options and a recommendation."
        />
      )}
      {list.map((d) => (
        <DecisionCard key={d.id} d={d} onDone={hide} />
      ))}
    </div>
  );
}
