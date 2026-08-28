import { test, expect } from "bun:test";
import { openDb, homeDbPath } from "../src/db.ts";

// bun test always sets NODE_ENV=test, so this covers the real hole: a test
// (or fixture) that forgets an explicit path and falls through to the live db.
test("openDb refuses the live database under NODE_ENV=test", () => {
  expect(() => openDb(homeDbPath())).toThrow(/refusing to open the live database/);
  expect(() => openDb()).toThrow(/refusing to open the live database/);
});

test("openDb still allows an explicit scratch path", () => {
  const db = openDb(":memory:");
  expect(db.query("SELECT 1 AS ok").get()).toMatchObject({ ok: 1 });
});
