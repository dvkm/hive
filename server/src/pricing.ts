// Static Claude price table + server-side cost computation for usage rows.
//
// EDITABLE CONFIG: prices are $ per MILLION tokens and go stale as Anthropic
// updates them — keep this table current. A project can override any family
// (or add new ones) via its config `pricing` key, same shape:
//   config.pricing = { "opus": { "input": 5, "output": 25, "cache_read": 0.5 } }
// The table is keyed by a lowercase substring matched against the model id;
// the LONGEST matching key wins (so "claude-3-5-haiku-…" matches "haiku").
// An unmatched model yields a null cost and is surfaced as "unpriced" — we
// never block ingestion on an unknown model.
//
// Cache tokens are NOT priced like fresh input: a cache read costs 0.1x input,
// a 5-minute cache write costs 1.25x. We bill writes at the 5m rate; a 1h-TTL
// write is 2x and would be undercharged.
// ponytail: single write rate, split by TTL if 1h caching is ever used.

export interface ModelPrice {
  input: number; // $/MTok on fresh input
  output: number; // $/MTok on output
  cache_read: number; // $/MTok on cache-read input (0.1x input)
  cache_write?: number; // $/MTok on cache-write input; defaults to 1.25x input
}

export const PRICES: Record<string, ModelPrice> = {
  opus: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  sonnet: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  haiku: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
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
  cache_write_tokens?: number;
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
      t.cache_read_tokens * p.cache_read +
      (t.cache_write_tokens ?? 0) * (p.cache_write ?? p.input * 1.25)) /
    1_000_000
  );
}
