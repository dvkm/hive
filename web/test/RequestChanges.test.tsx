import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { api } from "../src/lib/api";
import { RequestChanges } from "../src/views/RequestChanges";

const find = (root: any, type: string, text: string) =>
  root.find((node: any) => node.type === type && node.children.includes(text));

test("the note files a follow-up and the new task id is shown right there", async () => {
  const original = api.requestChanges;
  const calls: { id: string; notes: string }[] = [];
  api.requestChanges = (async (id: string, notes: string) => {
    calls.push({ id, notes });
    return { ok: true, followup_task_id: "t-99", followup_label: "HIVE-99" };
  }) as typeof api.requestChanges;

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <RequestChanges taskId="t-1" />
        </MemoryRouter>
      );
    });
    await act(async () => find(renderer.root, "button", "Request changes").props.onClick());
    const box = renderer.root.find((node) => node.type === "textarea");
    await act(async () => box.props.onChange({ target: { value: "Hold pushes for 4 hours" } }));
    await act(async () => {
      await find(renderer.root, "button", "File follow-up").props.onClick();
    });

    expect(calls).toEqual([{ id: "t-1", notes: "Hold pushes for 4 hours" }]);
    expect(JSON.stringify(renderer.toJSON())).toContain("HIVE-99");
  } finally {
    api.requestChanges = original;
  }
});

test("an empty note cannot be filed", async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <RequestChanges taskId="t-1" />
      </MemoryRouter>
    );
  });
  await act(async () => find(renderer.root, "button", "Request changes").props.onClick());
  expect(find(renderer.root, "button", "File follow-up").props.disabled).toBe(true);
});
