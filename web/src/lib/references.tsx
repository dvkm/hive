import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DecisionBundle, Task } from "./api";
import { toast } from "./ui";

export const taskLabel = (task: Pick<Task, "number" | "display_id">): string => task.display_id || `#${task.number}`;

function copy(event: MouseEvent, value: string, message: string) {
  event.preventDefault();
  event.stopPropagation();
  navigator.clipboard.writeText(value).then(() => toast(message)).catch(() => toast("Could not copy"));
}

function Actions({ label, href, external = false }: { label: string; href: string; external?: boolean }) {
  return (
    <span className="hover-actions" role="group" aria-label={`${label} actions`}>
      {external ? <a href={href} target="_blank" rel="noreferrer">Open ↗</a> : <Link to={href}>Open</Link>}
      <button type="button" onClick={(event) => copy(event, label, `Copied ${label}`)}>Copy ID</button>
      <button type="button" onClick={(event) => copy(event, new URL(href, window.location.href).href, "Copied link")}>Copy link</button>
    </span>
  );
}

export function TaskReference({ taskId, label, self = false, className }: { taskId: string; label: string; self?: boolean; className?: string }) {
  const href = `/tasks/${taskId}`;
  return (
    <span className="hover-reference">
      {self ? <span className={className}>{label}</span> : <Link className={className} to={href}>{label}</Link>}
      <Actions label={label} href={href} />
    </span>
  );
}

export function TaskRef({ task, self = false, className }: { task: Pick<Task, "id" | "number" | "display_id">; self?: boolean; className?: string }) {
  return <TaskReference taskId={task.id} label={taskLabel(task)} self={self} className={className} />;
}

export function prLabel(url: string): string {
  const number = url.match(/\/pull\/(\d+)/)?.[1];
  return number ? `PR #${number}` : "PR";
}

export function PrReference({ url, label, className }: { url: string; label?: string; className?: string }) {
  const identifier = prLabel(url);
  return (
    <span className="hover-reference">
      <a className={className} href={url} target="_blank" rel="noreferrer">{label || identifier}</a>
      <Actions label={identifier} href={url} external />
    </span>
  );
}

export function ReferenceText({ text, taskId, bundle }: { text: string; taskId: string; bundle?: DecisionBundle | null }): ReactNode {
  const taskNumber = bundle?.task_number;
  const taskDisplayId = bundle?.task_display_id;
  const prNumber = bundle?.pr_url?.match(/\/pull\/(\d+)/)?.[1];
  if (!taskNumber && !prNumber) return text;
  const matches = [
    prNumber ? `PR\\s+#${prNumber}\\b` : "",
    taskNumber ? `Task\\s+#${taskNumber}\\b` : "",
  ].filter(Boolean);
  const pattern = new RegExp(`(${matches.join("|")})`, "gi");
  return text.split(pattern).map((part, index) => {
    if (prNumber && new RegExp(`^PR\\s+#${prNumber}$`, "i").test(part))
      return <PrReference key={index} url={bundle!.pr_url!} />;
    if (taskNumber && new RegExp(`^Task\\s+#${taskNumber}$`, "i").test(part))
      return <span key={index}>Task <TaskReference taskId={taskId} label={taskDisplayId || `#${taskNumber}`} /></span>;
    return part;
  });
}
