import { useState } from "react";
import { useStore } from "../lib/store";
import { ReviewCard } from "./ReviewCard";

// The review queue: every in_review task as a review card, newest-updated first.
// Mirrors the Decisions inbox — the single surface for "things awaiting my
// review & merge". Cards self-remove once acted on (merge/request-changes/reject).
export default function Review() {
  const { tasks } = useStore();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const list = tasks.filter((t) => t.state === "in_review" && !hidden.has(t.id));
  const hide = (id: string) => setHidden((h) => new Set(h).add(id));

  return (
    <div className="inbox">
      {list.length === 0 && (
        <div className="empty">
          <div className="empty-big">Nothing to review.</div>
          <div className="muted">No tasks are awaiting your review &amp; merge right now.</div>
        </div>
      )}
      {list.map((t) => (
        <ReviewCard key={t.id} task={t} onDone={() => hide(t.id)} />
      ))}
    </div>
  );
}
