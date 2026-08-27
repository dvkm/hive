import { expect, test } from "bun:test";
import { isAbsoluteRepoPath } from "../src/lib/paths";

test("repo path validation accepts native absolute paths on every desktop platform", () => {
  expect(isAbsoluteRepoPath("/Users/me/code/app")).toBe(true);
  expect(isAbsoluteRepoPath("/mnt/c/Users/me/code/app")).toBe(true);
  expect(isAbsoluteRepoPath("C:\\Users\\me\\code\\app")).toBe(true);
  expect(isAbsoluteRepoPath("D:/src/app")).toBe(true);
  expect(isAbsoluteRepoPath("\\\\server\\share\\app")).toBe(true);
});

test("repo path validation rejects relative and drive-relative paths", () => {
  expect(isAbsoluteRepoPath("src/app")).toBe(false);
  expect(isAbsoluteRepoPath("C:src\\app")).toBe(false);
  expect(isAbsoluteRepoPath("../app")).toBe(false);
  expect(isAbsoluteRepoPath(" ")).toBe(false);
});
