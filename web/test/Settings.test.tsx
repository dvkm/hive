import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { api } from "../src/lib/api";
import Settings from "../src/views/Settings";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

function flatten(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten(node.children);
}

test("Settings shows key state without the key, and the probe result", async () => {
  const original = { typesafeSettings: api.typesafeSettings, testTypesafe: api.testTypesafe };
  Object.assign(api, {
    typesafeSettings: async () => ({ configured: true, key_hint: "9f17", key_source: "settings", mode: "shadow" }),
    testTypesafe: async () => ({ ok: false, status: 401, ms: 120, model: null, error: "authentication_error" }),
  });
  try {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<Settings />);
    });
    const shown = flatten(r.toJSON());
    expect(shown).toContain("…9f17");
    expect(shown).toContain("from this page");
    expect(shown).toContain("Mode: shadow");
    const buttons = r.root.findAllByType("button");
    const testBtn = buttons.find((b) => flatten(b.children) === "Test connection")!;
    await act(async () => {
      testBtn.props.onClick();
    });
    expect(flatten(r.toJSON())).toContain("Failed (HTTP 401): authentication_error");
  } finally {
    Object.assign(api, original);
  }
});
