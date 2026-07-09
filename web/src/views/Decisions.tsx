import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useStore } from "../lib/store";
import { DecisionCard } from "./DecisionCard";

export default function Decisions() {
  const { decisions } = useStore();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const list = decisions.filter((d) => !hidden.has(d.id));
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
      {list.length === 0 && (
        <div className="empty">
          <div className="empty-big">Inbox zero</div>
          <div className="muted">No decisions need you right now.</div>
        </div>
      )}
      {list.map((d) => (
        <DecisionCard key={d.id} d={d} onDone={hide} />
      ))}
    </div>
  );
}
