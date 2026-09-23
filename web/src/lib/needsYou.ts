import type { Decision, Intent, Task } from "./domain";

// Does an item belong to the active project filter? An empty filter ("" = All)
// matches everything. Lives here, next to the needs-you rules, so this module
// stays free of React and the server can import it too (server/src/attention.ts
// counts the SAME items the board counts). projectFilter.ts re-exports it, so
// every existing caller is unchanged.
export function inProjectFilter(projectId: string | undefined, filter: string): boolean {
  return !filter || projectId === filter;
}

export interface BlockingTaskRef {
  id: string;
  number: number;
  display_id?: string;
  title: string;
  state: string;
  pr_url: string | null;
}

// The only things that ask the director for something: a decision hive left
// for them, an ask with a question only a person can answer, and a review that
// needs their own Ship. Everything else hive handles and reports in the digest.
export type NeedsYouItem =
  | { kind: "decision"; id: string; decision: Decision }
  | { kind: "intent"; id: string; intent: Intent }
  | { kind: "review"; id: string; task: Task };

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY_HEAD_START: Record<NonNullable<Task["priority"]>, number> = {
  now: 3 * DAY_MS,
  next: 2 * DAY_MS,
  normal: DAY_MS,
  later: 0,
};

function focusItemKey(item: NeedsYouItem, tasks: Map<string, Task>): [number, number] {
  const candidates = item.kind === "intent"
    ? [{ ts: item.intent.updated_at, task: item.intent.task_id ? tasks.get(item.intent.task_id) : undefined }]
    : item.kind === "decision"
      ? [{ ts: item.decision.ts, task: tasks.get(item.decision.task_id) }]
      : [{ ts: item.task.needs_you_since ?? item.task.updated_at, task: item.task }];

  return candidates.reduce<[number, number]>((best, { ts, task }) => {
    const time = Date.parse(ts);
    const key: [number, number] = Number.isNaN(time)
      ? [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
      : [time - PRIORITY_HEAD_START[task?.priority ?? "normal"], time];
    return key[0] < best[0] || (key[0] === best[0] && key[1] < best[1]) ? key : best;
  }, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
}

// A draft intent outranks everything else, and its siblings group by project.
// Accepting an ask is what lets work start at all, so it is not competing with
// the age of work that already ran — it comes first, whatever the clock says.
const intentRank = (item: NeedsYouItem) => (item.kind === "intent" ? 0 : 1);
const intentProject = (item: NeedsYouItem) => (item.kind === "intent" ? item.intent.project_id : "");

// Priority is a head start, not a permanent lane: one day per level means an
// old lower-priority item eventually outranks a steady stream of new urgent work.
// Which slot the focus view shows: the pinned item wherever the re-sort put
// it, and only when that item has left the queue the slot it was in (clamped),
// which is the next thing in line. -1 when the queue is empty.
export function focusSlot(keys: string[], pinned: string | null, slot: number): number {
  if (!keys.length) return -1;
  const at = pinned ? keys.indexOf(pinned) : -1;
  return at >= 0 ? at : Math.min(Math.max(0, slot), keys.length - 1);
}

export function orderFocusItems(items: NeedsYouItem[], tasks: Task[]): NeedsYouItem[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return items
    .map((item, index) => ({ item, index, key: focusItemKey(item, byId) }))
    .sort((a, b) =>
      intentRank(a.item) - intentRank(b.item) ||
      intentProject(a.item).localeCompare(intentProject(b.item)) ||
      a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map(({ item }) => item);
}

// Auto-review exclusion is owned by #974/PR #87; keep this browser-side guard here so the changes merge independently.
// A mirror of someone else's Jira ticket: hive never runs an agent on it, ever.
export function isJiraMirror(task: Pick<Task, "source_ref">): boolean {
  return String(task.source_ref ?? "").startsWith("jira:");
}

// Tracking-only: hive records it but does no work of its own on it. Broader than
// isJiraMirror, and the two are NOT interchangeable. Gate HIVE-OWNED-WORK UI
// (PR/CI panels, code review) on this; gate AGENT controls on isJiraMirror plus
// never_dispatched, because a source='external' task a director actually
// spawned has a live agent those controls should still reach.
export function isTrackingOnly(task: Pick<Task, "source" | "source_ref">): boolean {
  return task.source === "external" || isJiraMirror(task);
}

// A Jira mirror rides one column behind its work (advanceJiraMirror): while any
// work task under it is still live, the work task's own card is the one to act
// on, and a second card for the ticket carried nothing. The mirror gets its own
// turn once all its work is finished, with that work's context on the card.
const LIVE_WORK = new Set(["queued", "in_progress", "needs_decision", "in_review", "verifying"]);
export function mirrorStillWorking(task: Task, tasks: Task[]): boolean {
  if (!isJiraMirror(task)) return false;
  return tasks.some((t) => t.jira_mirror_task_id === task.id && LIVE_WORK.has(t.state));
}

// Work hive is actually moving right now — what "N in motion" counts. A
// tracking-only row (a mirrored ticket, another agent's board entry) parked in a
// work column is deliberate: the real work runs under its children, and hive
// never dispatches an agent for the row itself. Counting those told the director
// six things were moving on corebeat when none of them were (HIVE-541). One a
// director spawned by hand is real hive work and still counts — that is what
// agent_target distinguishes, same test as taskNeedsAttention.
const IN_MOTION_STATES = ["in_progress", "needs_decision", "in_review", "verifying"];

export function isInMotion(task: Task): boolean {
  if (task.source === "chat_supervisor") return false;
  if (isTrackingOnly(task) && !task.agent_target) return false;
  return IN_MOTION_STATES.includes(task.state);
}

// Tracking cards are containers, not execution owners. Plain tracked cards use
// their direct children; Jira cards also group Hive work carrying the same
// stable issue-key prefix (e.g. [WEB-7]). Retry chains stay owned by their
// original supervisor, so collapse each one to its newest attempt instead of
// rewriting parent_task_id or showing every failed attempt as another subtask.
export function trackedSubtasks(task: Task, tasks: Task[]): Task[] {
  if (!isTrackingOnly(task)) return [];
  const direct = tasks.filter((candidate) => candidate.parent_task_id === task.id);
  const jiraKey = isJiraMirror(task) ? String(task.source_ref).slice("jira:".length) : "";
  const keyed = jiraKey
    ? tasks.filter((candidate) =>
        candidate.project_id === task.project_id &&
        !isTrackingOnly(candidate) &&
        candidate.source !== "requeue" &&
        candidate.title.startsWith(`[${jiraKey}]`)
      )
    : [];
  const roots = [...new Map([...direct, ...keyed].map((candidate) => [candidate.id, candidate])).values()];

  return roots.map((root) => {
    let latest = root;
    const seen = new Set([root.id]);
    while (true) {
      const retry = tasks
        .filter((candidate) => candidate.parent_task_id === latest.id && candidate.source === "requeue" && !seen.has(candidate.id))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
      if (!retry) return latest;
      seen.add(retry.id);
      latest = retry;
    }
  }).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

// Can the director act on this review NOW? The server decides (reviewer.ts's
// reviewActionable) because the answer reads events the browser never sees:
// whether the auto-review finished for the live head, and whether a task with
// no pull request left a report behind. Everything else stays visible as
// "in review" but must not be counted as needing the director (HIVE-500).
function reviewIsActionable(task: Task): boolean {
  return task.review_actionable === true;
}

// Browser-safe mirror of server/src/state.ts's dependency gate, so BlockedBy
// uses the same threshold.
export const DEP_MET_STATES = new Set(["verifying", "done"]);

// THE definition of "needs you" (HIVE-556: one set, so no two screens can show
// different numbers). The server decides each part, because each reads state
// the browser never sees:
//   - a decision the advisor has not judged yet is hive's, not the director's
//     (`for_director`), and one it settled is already answered;
//   - a draft ask is the director's only while nothing else is moving it: hive
//     is still reading the code (`hive_working`) or asked the ticket's reporter
//     (`waiting_on`) first;
//   - a review is the director's only when directorHold keeps it (`review_gate`).
// Merged work, catch-up reading, checkpoints and stuck agents are not here:
// hive handles them and the digest reports them.
export function getNeedsYouItems(decisions: Decision[], tasks: Task[], intents: Intent[] = []): NeedsYouItem[] {
  return [
    ...decisions
      .filter((decision) => decision.for_director !== false)
      .map((decision) => ({ kind: "decision" as const, id: decision.id, decision })),
    ...intents
      .filter((intent) => intent.status === "draft" && !intent.hive_working && !intent.waiting_on)
      .map((intent) => ({ kind: "intent" as const, id: intent.id, intent })),
    ...tasks
      .filter((task) => task.state === "in_review" && !isTrackingOnly(task) && reviewIsActionable(task))
      .map((task) => ({ kind: "review" as const, id: task.id, task })),
  ];
}

// Which project does a needs-you item belong to? A decision only knows its
// task, so look that up. Used to honour the shared project filter.
export function itemProject(item: NeedsYouItem, tasks: Task[]): string | undefined {
  if (item.kind === "decision") return tasks.find((task) => task.id === item.decision.task_id)?.project_id;
  if (item.kind === "intent") return item.intent.project_id;
  return item.task.project_id;
}

export function actionableItems(items: NeedsYouItem[], tasks: Task[], projectFilter = ""): NeedsYouItem[] {
  return items.filter((item) => inProjectFilter(itemProject(item, tasks), projectFilter));
}
