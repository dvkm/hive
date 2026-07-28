import { expect, test } from "bun:test";
import { inProjectFilter } from "../src/lib/projectFilter";

// The scoping rule shared by the board and the decisions/review inboxes.
test("empty filter (All) matches every item", () => {
  expect(inProjectFilter("proj_a", "")).toBe(true);
  expect(inProjectFilter("proj_b", "")).toBe(true);
  expect(inProjectFilter(undefined, "")).toBe(true);
});

test("active filter keeps only its own project", () => {
  expect(inProjectFilter("proj_a", "proj_a")).toBe(true);
  expect(inProjectFilter("proj_b", "proj_a")).toBe(false);
});

test("unresolved project (e.g. a decision whose task is missing) is excluded when a filter is active", () => {
  expect(inProjectFilter(undefined, "proj_a")).toBe(false);
});
