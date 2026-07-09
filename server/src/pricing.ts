// Static Claude price table + server-side cost computation for usage rows.
//
// EDITABLE CONFIG: prices are $ per MILLION tokens and go stale as Anthropic
// updates them — keep this table current. A project can override any family
// (or add new ones) via its config `pricing` key, same shape:
//   config.pricing = { "opus": { "input": 15, "output": 75, "cache_read": 1.5 } }
// The table is keyed by a lowercase substring matched against the model id;
// the LONGEST matching key wins (so "claude-3-5-haiku-…" matches "haiku").
// An unmatched model yields a null cost and is surfaced as "unpriced" — we
// never block ingestion on an unknown model.

export interface ModelPrice {
  input: number; // $/MTok on fresh input (incl. cache-write, which our schema folds into input)
  output: number; // $/MTok on output
  cache_read: number; // $/MTok on cache-read input
}

export const PRICES: Record<string, ModelPrice> = {
  opus: { input: 15, output: 75, cache_read: 1.5 },
  sonnet: { input: 3, output: 15, cache_read: 0.3 },
  haiku: { input: 0.8, output: 4, cache_read: 0.08 },
};

export function priceFor(
  model: string,
  overrides?: Record<string, ModelPrice> | null
): ModelPrice | null {
  const table = { ...PRICES, ...(overrides ?? {}) };
  const id = (model ?? "").toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (id.includes(key) && (best === null || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

export interface Tokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

// Cost in USD, or null when the model is unpriced.
export function costUsd(
  model: string,
  t: Tokens,
  overrides?: Record<string, ModelPrice> | null
): number | null {
  const p = priceFor(model, overrides);
  if (!p) return null;
  return (
    (t.input_tokens * p.input +
      t.output_tokens * p.output +
      t.cache_read_tokens * p.cache_read) /
    1_000_000
  );
}
