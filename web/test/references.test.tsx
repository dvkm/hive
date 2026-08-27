import { expect, test } from "bun:test";
import { create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { ReferenceText, TaskReference } from "../src/lib/references";

test("decision text turns its PR and task references into hover actions", () => {
  const renderer = create(
    <MemoryRouter>
      <p>
        <ReferenceText
          text="PR #125 has nothing left to merge. How should Task #1095 close?"
          taskId="task-1095"
          bundle={{
            task_number: 1095,
            task_display_id: "HIVE-247",
            pr_url: "https://github.com/example-org/example-repo/pull/125",
            branch: "hive/task-1095",
            spend_usd: 0,
            prior_decisions: [],
          }}
        />
      </p>
    </MemoryRouter>
  );

  expect(renderer.root.findAll((node) => node.type === "a" && node.children.includes("PR #125"))).toHaveLength(1);
  expect(renderer.root.findAll((node) => node.type === "a" && node.children.includes("HIVE-247"))).toHaveLength(1);
  expect(renderer.root.findAll((node) => node.type === "button" && node.children.includes("Copy ID"))).toHaveLength(2);
  expect(renderer.root.findAll((node) => node.type === "button" && node.children.includes("Copy link"))).toHaveLength(2);
});

test("a task heading exposes the same actions to keyboard focus", () => {
  const renderer = create(
    <MemoryRouter><TaskReference taskId="task-1095" label="HIVE-247" self /></MemoryRouter>
  );
  expect(renderer.root.findByProps({ tabIndex: 0 }).children).toContain("HIVE-247");
  expect(renderer.root.findAll((node) => node.type === "button" && node.children.includes("Copy ID"))).toHaveLength(1);
});
