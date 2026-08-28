import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jiraOwnershipMarkdown } from "../server/src/intake/jira-write-scope.ts";

const START = "<!-- BEGIN GENERATED JIRA WRITE SCOPE -->";
const END = "<!-- END GENERATED JIRA WRITE SCOPE -->";
const readme = resolve(dirname(fileURLToPath(import.meta.url)), "../README.md");
const current = readFileSync(readme, "utf8");
const start = current.indexOf(START);
const end = current.indexOf(END);
if (start < 0 || end < start) throw new Error("README Jira write-scope markers are missing");

// Preserve the checkout's newline convention. On Windows, core.autocrlf makes
// README.md CRLF; emitting an LF-only generated block made --check report
// drift even when the normalized Git content was identical.
const newline = current.includes("\r\n") ? "\r\n" : "\n";
const generatedBody = jiraOwnershipMarkdown().replaceAll("\n", newline);
const generated = `${START}${newline}${generatedBody}${newline}${END}`;
const next = current.slice(0, start) + generated + current.slice(end + END.length);
if (process.argv.includes("--check")) {
  if (next !== current) throw new Error("README Jira write scope is stale; run bun run docs:jira");
} else if (next !== current) {
  writeFileSync(readme, next);
}
