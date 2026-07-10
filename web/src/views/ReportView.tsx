import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Inline viewer for text evidence. Markdown (scout reports — the primary scout
// deliverable) renders as sanitized HTML; anything else shows as <pre>.
// DOMPurify matters: agent-authored markdown is same-origin with the board, so
// unsanitized HTML could script against the hive API as the director.
export function ReportView({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => live && setText(t))
      .catch((e) => live && setErr(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [url]);

  if (err) return <div className="report-view report-err">Could not load: {err}</div>;
  if (text == null) return <div className="report-view muted">Loading…</div>;
  if (/\.(md|markdown)(\?|$)/i.test(url)) {
    const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    return <div className="report-view report-md" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <div className="report-view">
      <pre className="report-pre">{text}</pre>
    </div>
  );
}

