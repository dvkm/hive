import { describe, expect, test } from "bun:test";
import { judge, noul, choice, typesafeMode } from "./typesafe.ts";

const env = { TYPESAFE_API_KEY: "k" } as NodeJS.ProcessEnv;
const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("typesafe", () => {
  test("mode: off without key, shadow by default, enforce when asked", () => {
    expect(typesafeMode({})).toBe("off");
    expect(typesafeMode(env)).toBe("shadow");
    expect(typesafeMode({ ...env, HIVE_TYPESAFE_MODE: "enforce" })).toBe("enforce");
  });

  test("returns typed answers and sends the documented request shape", async () => {
    let sent: any;
    const f = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ model: "jev-1", answers: { a: { type: "noul", noul: 0.9 }, b: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 } }, usage: { input_tokens: 3, output_tokens: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const j = await judge({ t: 1 }, { a: { type: "noul", instructions: "q" }, b: { type: "choice", instructions: "q", criteria: { x: null } } }, { fetch: f, env });
    expect(sent.model).toBe("jev-latest");
    expect(sent.state).toEqual({ t: 1 });
    expect(noul(j?.answers.a)).toBe(0.9);
    expect(choice(j?.answers.b)).toBe("x");
  });

  test("fails open: no key, non-200, missing answer, thrown fetch", async () => {
    const q = { a: { type: "noul", instructions: "q" } } as const;
    expect(await judge({}, q, { fetch: ok({ answers: { a: { type: "noul", noul: 1 } } }), env: {} })).toBeNull();
    expect(await judge({}, q, { fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch, env })).toBeNull();
    expect(await judge({}, q, { fetch: ok({ answers: {} }), env })).toBeNull();
    expect(await judge({}, q, { fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch, env })).toBeNull();
  });
});
