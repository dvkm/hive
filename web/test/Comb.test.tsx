import { expect, test } from "bun:test";
import { combCells } from "../src/lib/comb";

test("comb cells run heaviest first (capped, waiting on you, in flight, failed, empty), capped at one glance", () => {
  expect(combCells({ capped: 2, bee: 1, full: 1, empty: 1 })).toEqual(["capped", "capped", "full", "bee", "empty"]);
  expect(combCells({ capped: 30, bee: 10, empty: 10 })).toHaveLength(36);
  expect(combCells({})).toEqual([]);
});
