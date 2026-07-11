// Plain label maps. Kept out of ui.tsx (which imports react) so react-free
// logic — eventText.ts, and the server tests that import it — can use them
// without pulling in the web app's dependency tree.
import type { State, Health } from "./api";

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
