import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockedBy } from "../src/lib/ui";

const dep = (state: string) => ({ id: "dep-1", number: 87, title: "Some dep", state: state as any });

test("BlockedBy clears once the dependency reaches 'verifying', matching the dispatcher's DEP_MET_STATES gate", () => {
  const verifying = renderToStaticMarkup(createElement(BlockedBy, { depends_on: ["dep-1"], tasks: [dep("verifying")] }));
  expect(verifying).toBe("");

  const done = renderToStaticMarkup(createElement(BlockedBy, { depends_on: ["dep-1"], tasks: [dep("done")] }));
  expect(done).toBe("");
});

test("BlockedBy still shows the chip for dependencies the dispatcher treats as unmet", () => {
  const inReview = renderToStaticMarkup(createElement(BlockedBy, { depends_on: ["dep-1"], tasks: [dep("in_review")] }));
  expect(inReview).toContain("blocked by #87");

  const cancelled = renderToStaticMarkup(createElement(BlockedBy, { depends_on: ["dep-1"], tasks: [dep("cancelled")] }));
  expect(cancelled).toContain("blocked by #87");
});
