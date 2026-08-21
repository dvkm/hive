import { useEffect, useRef, useState, type ReactNode } from "react";
import type { State, CiStatus, Health } from "./api";
import { STATE_LABEL, HEALTH_LABEL } from "./labels";
import { DEP_MET_STATES } from "./needsYou";

export { STATE_LABEL, HEALTH_LABEL, NEXT } from "./labels"; // callers keep importing them from here

// Status dot. When the server reports health, the dot reflects HEALTH (green
// pulse / amber / orange / red) with the reason as tooltip; otherwise it falls
// back to the lifecycle-state color.
export function StatusDot({ state, health }: { state: State; health?: Health | null }) {
  if (health) {
    return (
      <span
        className={`sdot sdot-h-${health.status}`}
        title={health.reason ? `${HEALTH_LABEL[health.status]} — ${health.reason}` : HEALTH_LABEL[health.status]}
      />
    );
  }
  return <span className={`sdot sdot-${state}`} title={STATE_LABEL[state]} />;
}

// Empty state. Every list view in hive uses this, and the contract is that both
// halves are mandatory: `title` says what the emptiness MEANS, `hint` says what
// would fill it. A bare "—" or "Nothing yet" leaves the director guessing
// whether the system is idle or broken.
export function Empty({
  title,
  hint,
  compact,
  action,
}: {
  title: string;
  hint: string;
  compact?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className={`empty${compact ? " empty-compact" : ""}`}>
      <div className="empty-big">{title}</div>
      <p className="empty-hint">{hint}</p>
      {action}
    </div>
  );
}

export function CiBadge({ status }: { status: CiStatus }) {
  if (!status) return null;
  return <span className={`ci ci-${status}`}>{status === "unavailable" ? "CI never ran" : `CI ${status}`}</span>;
}

// "Blocked by #N, #M" chip. Uses the browser-side dependency gate mirror from
// needsYou.ts; an unknown id stays blocking and displays its short id.
// ponytail: plain span, not a Link, because the card wrapping it is already an anchor
// and nested anchors are invalid HTML.
type DepTask = { id: string; number: number; display_id?: string; title: string; state: State };
export function BlockedBy({ depends_on, tasks }: { depends_on: string[]; tasks: DepTask[] }) {
  const deps = depends_on ?? [];
  if (!deps.length) return null;
  const unmet = deps
    .map((id) => ({ id, t: tasks.find((x) => x.id === id) }))
    .filter(({ t }) => !t || !DEP_MET_STATES.has(t.state));
  if (!unmet.length) return null;
  const label = unmet.map(({ id, t }) => (t ? t.display_id || `#${t.number}` : id.slice(0, 6))).join(", ");
  const tip = unmet
    .map(({ id, t }) => (t ? `${t.display_id || `#${t.number}`} ${t.title} (${STATE_LABEL[t.state]})` : `${id} (unknown)`))
    .join("\n");
  return (
    <span className="chip chip-blocked" title={`Blocked by:\n${tip}`}>
      ⛔ blocked by {label}
    </span>
  );
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// A pasted screenshot is always named "image.png", so the name alone can't tell
// two of them apart — show what you actually staged.
function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img className="attach-thumb" src={url} alt="" /> : null;
}

// Wraps a composer (steer box, brief textarea) to make it a drop zone, and
// renders the picker + the list of staged files beneath it. Controlled: the
// caller owns `files` and clears them once the request succeeds.
export function Attach({
  files,
  onChange,
  children,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = (list: FileList | null) => list && onChange([...files, ...Array.from(list)]);

  return (
    <div
      className={`attach${over ? " attach-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      // dragleave also fires when crossing into a child element; ignore those.
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        add(e.dataTransfer.files);
      }}
      // Paste bubbles up from the textarea inside. Only swallow the event when
      // the clipboard actually carried files, so pasting text still types.
      onPaste={(e) => {
        if (!e.clipboardData.files.length) return;
        e.preventDefault();
        add(e.clipboardData.files);
      }}
    >
      {children}
      <div className="attach-bar">
        <button type="button" className="btn" onClick={() => input.current?.click()}>
          Attach files
        </button>
        <span className="muted attach-hint">or drop / paste them here</span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = ""; // let the same file be picked twice
          }}
        />
      </div>
      {files.length > 0 && (
        <ul className="attach-list">
          {files.map((f, i) => (
            <li key={i} className="attach-chip">
              <Thumb file={f} />
              <span className="attach-name" title={f.name}>
                {f.name}
              </span>
              <span className="muted">{kb(f.size)}</span>
              <button
                type="button"
                className="attach-x"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Toast: dead-simple, no lib.
export function toast(msg: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("toast-in"), 10);
  setTimeout(() => {
    el.classList.remove("toast-in");
    setTimeout(() => el.remove(), 300);
  }, 2600);
}
