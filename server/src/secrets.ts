// Secrets management. Hive never invents crypto; it stores only names/refs and
// delegates values to a provider (macOS Keychain, Windows DPAPI, or Bitwarden). Values are
// resolved at spawn time and injected as env vars; they never touch the DB,
// events, evidence, logs, or briefs.
//
// Every provider takes an injectable Exec so tests never invoke the real
// `security` / `bw` CLIs.
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hiveHome } from "./db.ts";

export function serviceName(project: string, name: string): string {
  return `hive/${project}/${name}`;
}

export interface SecretProvider {
  readonly kind: string;
  // Write the value to the backing store, return the ref to persist.
  set(project: string, name: string, value: string): Promise<{ ref: string }>;
  // Resolve a value from the backing store. Never logged.
  get(project: string, name: string, ref: string): Promise<string | null>;
  // Remove the value from the backing store.
  rm(project: string, name: string, ref: string): Promise<void>;
}

// ---- keychain (default): macOS `security` CLI ----
export class KeychainProvider implements SecretProvider {
  readonly kind = "keychain";
  constructor(private exec: Exec = defaultExec) {}

  async set(project: string, name: string, value: string): Promise<{ ref: string }> {
    const svc = serviceName(project, name);
    // -U updates in place if the item already exists.
    const r = await this.exec([
      "security", "add-generic-password", "-U", "-s", svc, "-a", name, "-w", value,
    ]);
    if (r.code !== 0) throw new Error(`keychain set failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { ref: svc };
  }

  async get(project: string, name: string, ref: string): Promise<string | null> {
    const svc = ref || serviceName(project, name);
    const r = await this.exec(["security", "find-generic-password", "-s", svc, "-a", name, "-w"]);
    if (r.code !== 0) return null;
    return r.stdout.replace(/\n$/, "");
  }

  async rm(project: string, name: string, ref: string): Promise<void> {
    const svc = ref || serviceName(project, name);
    const r = await this.exec(["security", "delete-generic-password", "-s", svc, "-a", name]);
    if (r.code !== 0) throw new Error(`keychain rm failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

// ---- Windows credentials: per-user DPAPI encrypted blobs -----------------
// Windows Credential Manager has no built-in CLI that can retrieve a generic
// credential's secret. DPAPI provides the same security boundary Hive needs:
// ciphertext can only be decrypted by this Windows user on this machine. The
// DB still stores only the stable service ref; encrypted blobs live under the
// private Hive home and plaintext travels to PowerShell over stdin, never argv.
const DPAPI_PROTECT = [
  "Add-Type -AssemblyName System.Security",
  "$plain=[Console]::In.ReadToEnd()",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
  "$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)",
  "[Console]::Out.Write([Convert]::ToBase64String($enc))",
].join(";");

const DPAPI_UNPROTECT = [
  "Add-Type -AssemblyName System.Security",
  "$encoded=[Console]::In.ReadToEnd().Trim()",
  "$enc=[Convert]::FromBase64String($encoded)",
  "$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($enc,$null,$scope)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
].join(";");

export class WindowsCredentialProvider implements SecretProvider {
  readonly kind = "keychain";
  constructor(private exec: Exec = defaultExec, private root: string = join(hiveHome(), "secrets")) {}

  private file(ref: string): string {
    const id = createHash("sha256").update(ref).digest("hex");
    return join(this.root, `${id}.dpapi`);
  }

  async set(project: string, name: string, value: string): Promise<{ ref: string }> {
    const ref = serviceName(project, name);
    const r = await this.exec(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", DPAPI_PROTECT],
      { input: value }
    );
    if (r.code !== 0 || !r.stdout.trim())
      throw new Error(`Windows credential set failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.file(ref), r.stdout.trim(), { encoding: "utf8", mode: 0o600 });
    return { ref };
  }

  async get(project: string, name: string, ref: string): Promise<string | null> {
    const key = ref || serviceName(project, name);
    const path = this.file(key);
    if (!existsSync(path)) return null;
    const r = await this.exec(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", DPAPI_UNPROTECT],
      { input: readFileSync(path, "utf8") }
    );
    return r.code === 0 ? r.stdout : null;
  }

  async rm(project: string, name: string, ref: string): Promise<void> {
    rmSync(this.file(ref || serviceName(project, name)), { force: true });
  }
}

// ---- bitwarden: `bw` CLI (David's existing vault) ----
// Writes require an unlocked session (BW_SESSION). `get` is the hot path used at
// spawn injection. ref is the item name `hive/<project>/<name>`.
// ponytail: item lifecycle here is thin (login-type item, name-based lookup);
// upgrade to id-based refs + folders if the vault grows enough to need them.
export class BitwardenProvider implements SecretProvider {
  readonly kind = "bitwarden";
  constructor(private exec: Exec = defaultExec) {}

  private session(): string[] {
    return process.env.BW_SESSION ? ["--session", process.env.BW_SESSION] : [];
  }

  async set(project: string, name: string, value: string): Promise<{ ref: string }> {
    const svc = serviceName(project, name);
    const item = { type: 1, name: svc, notes: null, login: { username: null, password: value } };
    const encoded = Buffer.from(JSON.stringify(item)).toString("base64");
    const r = await this.exec(["bw", "create", "item", encoded, ...this.session()]);
    if (r.code !== 0) throw new Error(`bitwarden set failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { ref: svc };
  }

  async get(project: string, name: string, ref: string): Promise<string | null> {
    const key = ref || serviceName(project, name);
    const r = await this.exec(["bw", "get", "password", key, ...this.session()]);
    if (r.code !== 0) return null;
    return r.stdout.replace(/\n$/, "");
  }

  async rm(_project: string, _name: string, ref: string): Promise<void> {
    // bw delete needs the item id; store it as ref if you want rm to work.
    const r = await this.exec(["bw", "delete", "item", ref, ...this.session()]);
    if (r.code !== 0) throw new Error(`bitwarden rm failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

export function providerFor(
  kind: string | undefined,
  exec: Exec = defaultExec,
  platform: NodeJS.Platform = process.platform
): SecretProvider {
  if (kind === "bitwarden") return new BitwardenProvider(exec);
  if (platform === "win32") return new WindowsCredentialProvider(exec);
  return new KeychainProvider(exec); // default
}

// ------------------------------------------------------------------ redaction
// The server redacts known secret values from any payload it stores. Values are
// registered when they are resolved (at spawn); redaction is a plain string
// substitution over the JSON-serialized payload. Short values (< 4 chars) are
// ignored to avoid nuking innocuous substrings.
const knownValues = new Set<string>();

export function registerSecretValues(values: Iterable<string>): void {
  for (const v of values) if (v && v.length >= 4) knownValues.add(v);
}

export function clearSecretValues(): void {
  knownValues.clear();
}

export function redact<T>(payload: T): T {
  if (knownValues.size === 0 || payload == null) return payload;
  let s = JSON.stringify(payload);
  let hit = false;
  for (const v of knownValues) {
    if (s.includes(v)) {
      s = s.split(v).join("***");
      hit = true;
    }
  }
  return hit ? (JSON.parse(s) as T) : payload;
}

// Resolve every secret configured for a project into an env map, and register
// the values for redaction. Returns {} when there are no secrets or the
// provider is unavailable (degrade, never throw at spawn).
export async function resolveProjectSecrets(
  db: import("./db.ts").DB,
  projectId: string,
  exec: Exec = defaultExec,
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, string>> {
  const rows = db
    .query("SELECT name, provider, ref FROM secrets WHERE project_id = ?")
    .all(projectId) as { name: string; provider: string; ref: string }[];
  const env: Record<string, string> = {};
  for (const row of rows) {
    try {
      const value = await providerFor(row.provider, exec, platform).get(projectId, row.name, row.ref);
      if (value != null) env[row.name] = value;
    } catch {
      /* provider unavailable for this secret; skip it, brief still lists the name */
    }
  }
  registerSecretValues(Object.values(env));
  return env;
}
