import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-typesafe-settings-"));
const { openDb } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");
const { applyTypesafeSettings, probeTypesafe, typesafeMode } = await import("../src/typesafe.ts");

const db = openDb(":memory:");
const handler = makeHandler(db);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await handler(new Request("http://127.0.0.1" + path, { method, headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};

test("settings page: key and mode round-trip, apply to the live env, and never echo the key", async () => {
  const saved = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, HIVE_TYPESAFE_MODE: process.env.HIVE_TYPESAFE_MODE };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.HIVE_TYPESAFE_MODE;
  try {
    expect((await call("GET", "/api/settings/typesafe")).json).toEqual({ configured: false, key_hint: null, key_source: null, mode: "off" });

    const set = await call("POST", "/api/settings/typesafe", { api_key: "  apikey_abcdef1234  ", mode: "enforce" });
    expect(set.json).toEqual({ configured: true, key_hint: "1234", key_source: "settings", mode: "enforce" });
    expect(JSON.stringify(set.json)).not.toContain("abcdef");
    expect(process.env.TYPESAFE_API_KEY as string | undefined).toBe("apikey_abcdef1234");
    expect(typesafeMode()).toBe("enforce");

    // a fresh process picks the saved values up from the table at boot
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.HIVE_TYPESAFE_MODE;
    applyTypesafeSettings(db);
    expect(process.env.TYPESAFE_API_KEY as string | undefined).toBe("apikey_abcdef1234");
    expect(process.env.HIVE_TYPESAFE_MODE as string | undefined).toBe("enforce");

    // bad mode ignored, mode-only save keeps the key
    expect((await call("POST", "/api/settings/typesafe", { mode: "loud" })).json.mode).toBe("enforce");
    expect((await call("POST", "/api/settings/typesafe", { mode: "shadow" })).json).toMatchObject({ configured: true, mode: "shadow" });

    // clearing the key turns Jev off
    expect((await call("POST", "/api/settings/typesafe", { api_key: "" })).json).toEqual({ configured: false, key_hint: null, key_source: null, mode: "off" });
    expect(process.env.TYPESAFE_API_KEY).toBeUndefined();
  } finally {
    if (saved.TYPESAFE_API_KEY != null) process.env.TYPESAFE_API_KEY = saved.TYPESAFE_API_KEY;
    else delete process.env.TYPESAFE_API_KEY;
    if (saved.HIVE_TYPESAFE_MODE != null) process.env.HIVE_TYPESAFE_MODE = saved.HIVE_TYPESAFE_MODE;
    else delete process.env.HIVE_TYPESAFE_MODE;
  }
});

test("probe reports a bad key as HTTP 401 and a dead network as an error, never throws", async () => {
  const env = { TYPESAFE_API_KEY: "k" } as NodeJS.ProcessEnv;
  const status = (code: number, body: string) => (async () => new Response(body, { status: code })) as unknown as typeof fetch;
  expect(await probeTypesafe({ env: {} })).toMatchObject({ ok: false, status: null, error: "no API key set" });
  expect(await probeTypesafe({ env, fetch: status(401, "bad key") })).toMatchObject({ ok: false, status: 401, error: "bad key" });
  expect(await probeTypesafe({ env, fetch: status(200, JSON.stringify({ model: "jev-1", answers: {} })) })).toMatchObject({ ok: true, status: 200, model: "jev-1" });
  expect(await probeTypesafe({ env, fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch })).toMatchObject({ ok: false, status: null, error: "down" });
});
