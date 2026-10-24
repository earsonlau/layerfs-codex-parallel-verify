import { UsageError } from "./errors.js";

/** Runs `fn` over `items` with at most `limit` in flight. Each item is visited once. */
export async function mapPool(items, limit, fn) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("jobs must be a positive integer");
  }
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

export function resolveJobs({ parallel = false, sequenced = false, jobs, count }) {
  if (parallel && sequenced) throw new UsageError("pass either --sequenced or --parallel");
  if (sequenced) return 1;
  if (parallel) return Math.max(1, count);
  if (jobs != null) {
    if (!Number.isSafeInteger(jobs) || jobs < 1) throw new UsageError("--jobs must be a positive integer");
    return Math.min(jobs, Math.max(1, count));
  }
  return Math.min(4, Math.max(1, count));
}
