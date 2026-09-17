import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TypesafeProbe, TypesafeStatus } from "../lib/api";
import { toast } from "../lib/ui";

// Settings: server-wide switches that used to need a launchd plist edit and a
// restart. Today that is the TypeSafe (Jev) key and mode; the key is written to
// the settings table and applied to the running server on save, never echoed
// back (the page shows its last four characters only).

const MODES: [TypesafeStatus["mode"], string][] = [
  ["shadow", "Shadow: ask Jev, record what it said, change nothing"],
  ["enforce", "Enforce: let confident Jev answers skip the Claude call"],
  ["off", "Off: never call Jev"],
];

export default function Settings() {
  const [status, setStatus] = useState<TypesafeStatus | null>(null);
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<TypesafeStatus["mode"]>("shadow");
  const [probe, setProbe] = useState<TypesafeProbe | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.typesafeSettings().then((s) => {
      setStatus(s);
      setMode(s.mode === "off" && !s.configured ? "shadow" : s.mode);
    });
  useEffect(() => {
    load().catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const s = await api.saveTypesafeSettings({ ...(key ? { api_key: key } : {}), mode });
      setStatus(s);
      setKey("");
      setProbe(null);
      toast(s.configured ? "TypeSafe settings saved" : "TypeSafe key cleared");
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      setStatus(await api.saveTypesafeSettings({ api_key: "" }));
      setProbe(null);
      toast("TypeSafe key cleared");
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      setProbe(await api.testTypesafe());
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pol-section">
      <div className="pol-section-head">
        <div className="pol-section-heading">
          <h2>TypeSafe (Jev)</h2>
          <p className="pol-blurb">
            <span className="pol-when">Used by the reviewer, intake triage, intent checks, auto-approve and command cards.</span> Typed
            judgments in front of Claude calls. Paste a key from typesafe.ai; it takes effect immediately, no restart.
          </p>
        </div>
      </div>

      <p className="muted" data-testid="typesafe-status">
        {status == null
          ? "Loading…"
          : status.configured
            ? `Key set (…${status.key_hint}, from ${status.key_source === "settings" ? "this page" : "the server environment"}). Mode: ${status.mode}.`
            : "No key set. Jev is off."}
      </p>

      <label className="fld">
        <span>API key</span>
        <input
          type="password"
          autoComplete="off"
          placeholder={status?.configured ? "Paste a new key to replace the current one" : "apikey_…"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <label className="fld">
        <span>Mode</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as TypesafeStatus["mode"])}>
          {MODES.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <div className="modal-foot">
        <button className="btn btn-primary" disabled={busy || (!key && !status?.configured)} onClick={save}>
          Save
        </button>
        <button className="btn" disabled={busy || !status?.configured} onClick={test}>
          Test connection
        </button>
        <span className="spacer" />
        {status?.configured && (
          <button className="link-btn" disabled={busy} onClick={clear}>
            Remove key
          </button>
        )}
      </div>

      {probe && (
        <p className={probe.ok ? "muted" : "muted"} data-testid="typesafe-probe">
          {probe.ok
            ? `Connected: ${probe.model} answered in ${probe.ms} ms.`
            : `Failed${probe.status ? ` (HTTP ${probe.status})` : ""}: ${probe.error}`}
        </p>
      )}
    </section>
  );
}
