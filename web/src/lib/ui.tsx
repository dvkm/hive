import { useRef, useState, type ReactNode } from "react";
import type { State, CiStatus, Health } from "./api";

export const STATE_LABEL: Record<State, string> = {
  queued: "Queued",
  in_progress: "In Progress",
  needs_decision: "Needs Decision",
  in_review: "In Review",
  verifying: "Verifying",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const HEALTH_LABEL: Record<Health["status"], string> = {
  healthy: "Healthy",
  silent: "Silent",
  stuck: "Stuck",
  dead: "Agent gone",
};

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

export function CiBadge({ status }: { status: CiStatus }) {
  if (!status) return null;
  return <span className={`ci ci-${status}`}>CI {status}</span>;
}

// Which transitions the director can trigger from the current state.
export const NEXT: Partial<Record<State, State[]>> = {
  queued: ["in_progress", "cancelled"],
  in_progress: ["in_review", "needs_decision", "failed", "cancelled"],
  needs_decision: ["in_progress", "cancelled"],
  in_review: ["verifying", "in_progress", "cancelled"],
  verifying: ["done", "in_progress", "failed"],
};

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// Wraps a composer (steer box, brief textarea) to make it a drop zone, and
// renders the picker + the list of staged files beneath it. Controlled: the
// caller owns `files` and clears them once the request succeeds.
// ponytail: no clipboard paste — the brief asks for picker + drag-drop.
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
    >
      {children}
      <div className="attach-bar">
        <button type="button" className="btn" onClick={() => input.current?.click()}>
          Attach files
        </button>
        <span className="muted attach-hint">or drop them here</span>
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
