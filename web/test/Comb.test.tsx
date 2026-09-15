import { expect, test } from "bun:test";
import { combCells } from "../src/views/Board";

test("comb cells run landed, then running, then queued, capped at one glance", () => {
  expect(combCells(2, 1, 1)).toEqual(["landed", "landed", "running", "queued"]);
  expect(combCells(30, 10, 10)).toHaveLength(36);
  expect(combCells(0, 0, 0)).toEqual([]);
});
