import { test, expect, beforeEach } from "bun:test";
import type { Exec, ExecResult } from "../src/exec.ts";
import {
  KeychainProvider,
  WindowsCredentialProvider,
  BitwardenProvider,
  providerFor,
  serviceName,
  redact,
  registerSecretValues,
  clearSecretValues,
  resolveProjectSecrets,
} from "../src/secrets.ts";
import { openDb, newId, now } from "../src/db.ts";
import { writeEvent } from "../src/state.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stubExec(handler: (argv: string[], input?: string) => ExecResult): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push(argv);
    return handler(argv, opts?.input);
  };
  return { exec, calls };
}
const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

test("keychain provider builds security CLI commands, service-namespaced", async () => {
  const { exec, calls } = stubExec((argv) => (argv.includes("find-generic-password") ? OK("hunter2\n") : OK()));
  const p = new KeychainProvider(exec);

  const { ref } = await p.set("proj_1", "API_KEY", "hunter2");
  expect(ref).toBe(serviceName("proj_1", "API_KEY"));
  expect(calls[0]).toContain("add-generic-password");
  expect(calls[0]).toContain("hive/proj_1/API_KEY");
  expect(calls[0]).toContain("hunter2");

  const val = await p.get("proj_1", "API_KEY", ref);
  expect(val).toBe("hunter2"); // trailing newline stripped
  expect(calls[1]).toContain("find-generic-password");

  await p.rm("proj_1", "API_KEY", ref);
  expect(calls[2]).toContain("delete-generic-password");
});

test("keychain get returns null when the item is missing", async () => {
  const { exec } = stubExec(() => ({ code: 44, stdout: "", stderr: "not found" }));
  const val = await new KeychainProvider(exec).get("p", "N", "hive/p/N");
  expect(val).toBeNull();
});

test("Windows credential provider keeps plaintext off argv and stores a DPAPI blob", async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-dpapi-test-"));
  const inputs: (string | undefined)[] = [];
  const exec: Exec = async (argv, opts) => {
    inputs.push(opts?.input);
    const script = argv.at(-1) || "";
    return script.includes("Unprotect") ? OK("hunter2") : OK("encrypted-base64");
  };
  const p = new WindowsCredentialProvider(exec, root);
  const { ref } = await p.set("proj_1", "API_KEY", "hunter2");
  expect(ref).toBe("hive/proj_1/API_KEY");
  expect(inputs[0]).toBe("hunter2");
  expect(await p.get("proj_1", "API_KEY", ref)).toBe("hunter2");
  expect(inputs[1]).toBe("encrypted-base64");
  await p.rm("proj_1", "API_KEY", ref);
  expect(await p.get("proj_1", "API_KEY", ref)).toBeNull();
});

test("bitwarden provider builds bw commands and encodes the item", async () => {
  const { exec, calls } = stubExec((argv) => (argv.includes("password") ? OK("s3cret\n") : OK("id123")));
  const p = new BitwardenProvider(exec);
  await p.set("proj_1", "TOKEN", "s3cret");
  expect(calls[0].slice(0, 3)).toEqual(["bw", "create", "item"]);
  const decoded = JSON.parse(Buffer.from(calls[0][3], "base64").toString());
  expect(decoded.name).toBe("hive/proj_1/TOKEN");
  expect(decoded.login.password).toBe("s3cret");

  expect(await p.get("proj_1", "TOKEN", "hive/proj_1/TOKEN")).toBe("s3cret");
});

test("providerFor selects backend, defaulting to keychain", () => {
  expect(providerFor("bitwarden").kind).toBe("bitwarden");
  expect(providerFor("keychain").kind).toBe("keychain");
  expect(providerFor(undefined).kind).toBe("keychain");
});

beforeEach(() => clearSecretValues());

test("redaction replaces registered secret values in payloads", () => {
  registerSecretValues(["supersecretvalue"]);
  const out = redact({ note: "the key is supersecretvalue ok", nested: { x: "supersecretvalue" } });
  expect(out.note).toBe("the key is *** ok");
  expect(out.nested.x).toBe("***");
});

test("redaction ignores very short values and leaves clean payloads untouched", () => {
  registerSecretValues(["ab"]); // too short, ignored
  const clean = { note: "abc" };
  expect(redact(clean)).toBe(clean); // same reference, no work done
});

test("writeEvent redacts known secret values before storing", () => {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  const taskId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, kind, created_at, updated_at) VALUES (?,?,?, 'queued','ship', ?, ?)"
  ).run(taskId, projectId, "t", t, t);

  registerSecretValues(["leakytoken1234"]);
  writeEvent(db, { task_id: taskId, source: "agent", type: "status", payload: { note: "used leakytoken1234 here" } });
  const row = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'status'").get(taskId) as { payload: string };
  expect(row.payload).not.toContain("leakytoken1234");
  expect(row.payload).toContain("***");
});

test("resolveProjectSecrets resolves via the provider and registers values", async () => {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, created_at) VALUES (?,?,?)").run(projectId, "p", now());
  db.query("INSERT INTO secrets (id, project_id, name, provider, ref, created_at) VALUES (?,?,?,?,?,?)").run(
    newId("sec"), projectId, "API_KEY", "keychain", serviceName(projectId, "API_KEY"), now()
  );
  const { exec } = stubExec(() => OK("resolvedvalue99\n"));
  const env = await resolveProjectSecrets(db, projectId, exec, "darwin");
  expect(env).toEqual({ API_KEY: "resolvedvalue99" });
  // value is now registered for redaction
  expect(redact({ v: "resolvedvalue99" }).v).toBe("***");
});
