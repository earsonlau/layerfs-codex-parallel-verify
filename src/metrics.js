/** Decimal units, matching Docker's volume size figure. */
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return "unknown";
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(Number(bytes));
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const text = index === 0 ? String(Math.round(value)) : value.toFixed(digits);
  return `${sign}${text} ${units[index]}`;
}

/**
 * One Store versus N full worktrees.
 * `stored` is the Store volume's on-disk size (or the store file when that
 * is all this process can see). `unitBytes` is one materialized tree.
 */
export function spaceReport({ stored = null, unitBytes = null, candidates = 0 } = {}) {
  const worktreeBaseline = unitBytes == null ? null : unitBytes * candidates;
  const savedBytes = worktreeBaseline == null || stored == null ? null : worktreeBaseline - stored;
  const timesSmaller = worktreeBaseline == null || stored == null || stored <= 0
    ? null
    : worktreeBaseline / stored;
  return { stored, unitBytes, candidates, worktreeBaseline, savedBytes, timesSmaller };
}
