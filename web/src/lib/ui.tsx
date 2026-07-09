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
