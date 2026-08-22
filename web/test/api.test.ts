import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("API token entry avoids Electron's unsupported window.prompt", () => {
  const source = readFileSync(join(import.meta.dir, "../src/lib/api.ts"), "utf8");
  expect(source).not.toContain("window.prompt(");
  expect(source).toContain('document.createElement("dialog")');
});
