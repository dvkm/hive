import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Location } from "react-router-dom";
import { api } from "../lib/api";
import type { SearchHit } from "../lib/api";
import { useStore } from "../lib/store";
import { toast } from "../lib/ui";
import { setProjectFilter } from "../lib/projectFilter";
import { isTrackingOnly } from "../lib/needsYou";
import { NewTaskModal } from "./Board";

// Cmd+K / "/" command palette + global search, mounted once over every view.

type Item = {
  key: string;
  group: string;
  icon: string;
  label: string;
  sub?: string;
  hint?: string;
  run: () => void;
};

const NAV: { label: string; path: string }[] = [
  { label: "Chief of Staff", path: "/" },
  { label: "Work", path: "/work" },
  { label: "Needs you", path: "/inbox" },
  { label: "Activity", path: "/feed" },
  { label: "Evidence", path: "/evidence" },
  { label: "Agent sessions", path: "/supervisors" },
  { label: "Terminals", path: "/terminals" },
  { label: "Learnings", path: "/learnings" },
  { label: "Analytics", path: "/analytics" },
  { label: "Projects", path: "/projects" },
  { label: "Policies", path: "/policies" },
  { label: "Monitors", path: "/monitors" },
];

const TYPE_ICON: Record<SearchHit["type"], string> = {
  task: "◱",
  decision: "⚖",
  learning: "✦",
  policy: "§",
  project: "▤",
};
const TYPE_GROUP: Record<SearchHit["type"], string> = {
  task: "Tasks",
  decision: "Decisions",
  learning: "Learnings",
  policy: "Policies",
  project: "Projects",
};

// Subsequence fuzzy match: returns a score (lower = better) or -1 for no match.
function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.includes(q)) return t.indexOf(q); // contiguous match ranks best, earliest first
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return -1;
    gaps += at - ti;
    ti = at + 1;
  }
  return 1000 + gaps; // subsequence match, worse than any contiguous hit
}

export default function Palette() {
  const [open, setOpen] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const { tasks, projects } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
    setHits([]);
    setSel(0);
  };

  // Global open shortcuts: Cmd/Ctrl+K, or "/" when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if ((e.metaKey || e.ctrlKey) && (k === "k" || k === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (k === "/" && !open) {
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("hive:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hive:palette", onOpen);
    };
  }, [open]);

  // Lock background scroll + focus the input while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api
        .search(q)
        .then((r) => {
          if (!stale) setHits(r.hits);
        })
        .catch(() => {
          if (!stale) setHits([]);
        });
    }, 160);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, open]);

  // Task hit → task modal over the current view (unless we're already on a modal
  // route, in which case fall back to the plain page navigation).
  const openTask = (id: string) => {
    const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation || location;
    navigate(`/tasks/${id}`, { state: { backgroundLocation: bg } });
  };

  // Commands, rebuilt from live store. Core ones show even with an empty query;
  // per-project / per-task ones only surface once they fuzzy-match.
  const { core, extra } = useMemo(() => {
    const core: Item[] = [
      {
        key: "cmd:new-task",
        group: "Commands",
        icon: "＋",
        label: "New task",
        hint: "create",
        run: () => {
          close();
          setNewTask(true);
        },
      },
      ...NAV.map((n) => ({
        key: `cmd:go:${n.path}`,
        group: "Commands",
        icon: "→",
        label: `Go to ${n.label}`,
        run: () => {
          close();
          navigate(n.path);
        },
      })),
    ];
    const extra: Item[] = [
      {
        key: "cmd:filter:all",
        group: "Commands",
        icon: "⛃",
        label: "Toggle project filter → All",
        run: () => {
          close();
          setProjectFilter("");
          navigate("/work");
        },
      },
      ...projects.map((p) => ({
        key: `cmd:filter:${p.id}`,
        group: "Commands",
        icon: "⛃",
        label: `Toggle project filter → ${p.name}`,
        run: () => {
          close();
          setProjectFilter(p.id);
          navigate("/work");
        },
      })),
      ...tasks
        .filter((t) => t.state === "queued" && !isTrackingOnly(t))
        .map((t) => ({
          key: `cmd:dispatch:${t.id}`,
          group: "Commands",
          icon: "▶",
          label: `Dispatch ${t.title}`,
          hint: "spawn",
          run: () => {
            close();
            api.spawn(t.id).then(
              () => toast("Agent dispatched"),
              (e) => toast((e as Error).message)
            );
          },
        })),
    ];
    return { core, extra };
  }, [projects, tasks, location]);

  // Assemble the visible, ordered item list (drives both render and keyboard nav).
  const items = useMemo(() => {
    const q = query.trim();
    let cmds: Item[];
    if (!q) {
      cmds = core;
    } else {
      cmds = [...core, ...extra]
        .map((it) => ({ it, s: fuzzy(q, it.label) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s)
        .map((x) => x.it);
    }
    // Direct task-number lookup: "#42" or bare "42" jumps straight to that task
    // (the server search is text-only and never matches the numeric handle).
    const numItems: Item[] = [];
    const numMatch = /^#?(\d+)$/.exec(q);
    if (numMatch) {
      const n = Number(numMatch[1]);
      const t = tasks.find((x) => x.number === n);
      if (t)
        numItems.push({
          key: `hit:num:${t.id}`,
          group: "Tasks",
          icon: "◱",
          label: `#${t.number} ${t.title}`,
          sub: t.state,
          hint: t.state,
          run: () => {
            close();
            openTask(t.id);
          },
        });
    }
    const hitItems: Item[] = hits
      .filter((h) => !(h.type === "task" && numItems.some((n) => n.key === `hit:num:${h.id}`)))
      .map((h) => ({
        key: `hit:${h.type}:${h.id}`,
        group: TYPE_GROUP[h.type],
        icon: TYPE_ICON[h.type],
        label: h.title || "(untitled)",
        sub: h.snippet || (h.task_state ? h.task_state : undefined),
        hint: h.type === "task" ? h.task_state : undefined,
        run: () => {
          close();
          if (h.type === "task") openTask(h.id);
          else if (h.type === "decision") navigate(`/decisions#dcard-${h.id}`);
          else if (h.type === "learning") navigate("/learnings");
          else if (h.type === "policy") navigate("/policies");
          else if (h.type === "project") navigate("/projects");
        },
      }));
    return [...numItems, ...cmds, ...hitItems];
  }, [query, core, extra, hits, tasks]);

  useEffect(() => {
    setSel((s) => (s >= items.length ? 0 : s));
  }, [items.length]);

  // Keep the selected row in view.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (items.length ? (s + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[sel]?.run();
    }
  };

  return (
    <>
      {open && (
        <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
          <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
            <input
              ref={inputRef}
              className="palette-input"
              placeholder="Search tasks, decisions, learnings… or run a command"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSel(0);
              }}
            />
            <div className="palette-list" ref={listRef}>
              {items.length === 0 && <div className="palette-empty">No matches.</div>}
              {items.map((it, i) => {
                const first = i === 0 || items[i - 1].group !== it.group;
                return (
                  <div key={it.key}>
                    {first && <div className="palette-group">{it.group}</div>}
                    <div
                      data-idx={i}
                      className={`palette-item ${i === sel ? "palette-item-sel" : ""}`}
                      onMouseEnter={() => setSel(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        it.run();
                      }}
                    >
                      <span className="palette-icon">{it.icon}</span>
                      <span className="palette-label">{it.label}</span>
                      {it.sub && <span className="palette-sub">{it.sub}</span>}
                      {it.hint && <span className="palette-hint">{it.hint}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="palette-foot">
              <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
              <span><kbd>↵</kbd> open</span>
              <span><kbd>esc</kbd> close</span>
              <span className="spacer" />
              <span><kbd>⌘K</kbd> / <kbd>/</kbd> toggle</span>
            </div>
          </div>
        </div>
      )}
      {newTask && <NewTaskModal onClose={() => setNewTask(false)} />}
    </>
  );
}
