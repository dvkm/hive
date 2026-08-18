import type { ReleaseItem, ReleasePlan } from "./types.ts";

export function planRelease(_items: ReleaseItem[], _completed: string[] = []): ReleasePlan {
  return { next: [], blocked: [], order: [] };
}
