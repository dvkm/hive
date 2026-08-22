export const NEEDS_DECISION_LABEL = "hive:needs-decision";

export const JIRA_OWNERSHIP = {
  jiraOwnedFields: ["summary", "description", "issue type", "priority"],
  writes: {
    status: true,
    comments: true,
    attachments: true,
    labels: [NEEDS_DECISION_LABEL],
    assignee: false,
  },
} as const;

export const JIRA_WRITE_SCOPE = JIRA_OWNERSHIP.writes;
export type JiraWriteField = keyof typeof JIRA_WRITE_SCOPE;

export function assertJiraWriteAllowed(field: JiraWriteField, value?: string): void {
  const allowed = JIRA_WRITE_SCOPE[field];
  if (allowed === true) return;
  if (Array.isArray(allowed) && value && (allowed as readonly string[]).includes(value)) return;
  throw new Error(`Jira ${field} write is outside the declared scope${value ? `: ${value}` : ""}`);
}

function markdownList(items: string[]): string {
  if (items.length < 2) return items[0] ?? "nothing";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function jiraOwnershipMarkdown(): string {
  const scope = JIRA_WRITE_SCOPE;
  const labels = scope.labels.map((label) => `\`${label}\``);
  const writes = [
    scope.status ? "`status`" : null,
    scope.comments ? "`comments` and evidence receipts" : null,
    scope.attachments ? "`attachments` (up to 3 screenshots hive already holds as evidence, on UI work only)" : null,
    labels.length ? `${markdownList(labels)} label${labels.length === 1 ? "" : "s"}` : null,
    scope.assignee ? "`assignee`" : null,
  ].filter((item): item is string => item !== null);
  const jiraOwned = JIRA_OWNERSHIP.jiraOwnedFields.map((field) => `\`${field}\``);
  const labelOwnership = labels.length ? `all labels except ${markdownList(labels)}` : "all labels";
  const assignee = scope.assignee
    ? "Hive may write the assignee."
    : "**hive never writes the assignee at all.** It reads the field to display it and stops there because Jira Cloud has no compare-and-swap across the separate check and write requests, so \"a human's assignment is never touched\" only holds absolutely if hive never touches it (dec_234877ea4617).";

  return `- **Field ownership.** Jira owns ${markdownList([...jiraOwned, labelOwnership])}. Hive's generated write scope is ${markdownList(writes)}; everything else flows Jira → hive only. ${assignee} \`GET /api/tasks/:id/jira\` exposes the same registry as \`write_scope\`. \`needs_decision\` has no Jira status, \`verifying\` maps to In Review, and \`failed\` and \`cancelled\` never move Jira.`;
}
