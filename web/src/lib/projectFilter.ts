import { useEffect, useState } from "react";

// Single source of truth for the active project filter, shared across the board,
// the decisions/review inboxes, the focus/backlogs queue, and the command
// palette. Persisted in localStorage and broadcast via a window event so every
// mounted view stays in sync when the filter changes from anywhere (board chips
// or palette action).
const KEY = "hive.board.project";
const EVENT = "hive:project-filter";

export function getProjectFilter(): string {
  return localStorage.getItem(KEY) || "";
}

// The scoping rule itself lives in needsYou.ts (React-free, so the server can
// import it). Re-exported here because every caller reaches for it next to the
// filter it scopes by.
export { inProjectFilter } from "./needsYou";

export function setProjectFilter(id: string) {
  if (id) localStorage.setItem(KEY, id);
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

// Read-and-subscribe: returns the current filter id ("" = All) and re-renders
// on any change, wherever it originated.
export function useProjectFilter(): string {
  const [filter, setFilter] = useState<string>(getProjectFilter);
  useEffect(() => {
    const onSet = (e: Event) => setFilter((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, onSet as EventListener);
    return () => window.removeEventListener(EVENT, onSet as EventListener);
  }, []);
  return filter;
}
