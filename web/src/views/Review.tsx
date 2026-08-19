import { useState } from "react";
import { useStore } from "../lib/store";
import { useProjectFilter, inProjectFilter } from "../lib/projectFilter";
import { Empty } from "../lib/ui";
import { ReviewCard } from "./ReviewCard";
import { isTrackingOnly } from "../lib/needsYou";

// The review queue: every Hive-owned in_review task as a review card, newest-updated first.
// Mirrors the Decisions inbox — the single surface for "things awaiting my
// review & merge". Cards self-remove once acted on (merge/request-changes/reject).
export default function Review() {
  const { tasks } = useStore();
  const projectFilter = useProjectFilter();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const list = tasks.filter(
    (t) => t.state === "in_review" && !isTrackingOnly(t) && !hidden.has(t.id) && inProjectFilter(t.project_id, projectFilter)
  );
  const hide = (id: string) => setHidden((h) => new Set(h).add(id));

  return (
    <div className="inbox">
      <div className="page-head">
        <h1 className="page-title">Review</h1>
        <p className="page-sub">
          {list.length === 0
            ? "Merged work shows up on the board."
            : `${list.length} task${list.length === 1 ? "" : "s"} waiting on your review & merge.`}
        </p>
      </div>
      {list.length === 0 && (
        <Empty
          title="Nothing to review"
          hint="A task lands here once its agent opens a PR and CI goes green. You'll get the diff, the evidence and a merge button."
        />
      )}
      {list.map((t) => (
        <ReviewCard key={t.id} task={t} onDone={() => hide(t.id)} />
      ))}
    </div>
  );
}
