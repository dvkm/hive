// Pure decision-card display helpers (no React, unit-testable).

// Risk display: a null/empty risk must render as "—", never the literal
// "unknown". Returns the CSS modifier class and the human label.
export function riskDisplay(risk: string | null | undefined): { className: string; label: string } {
  const r = (risk || "").trim().toLowerCase();
  return { className: r ? `risk-${r}` : "risk-none", label: r || "—" };
}
