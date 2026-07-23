/**
 * Format a sample count compactly with a k/M/G suffix (e.g. 10000 → "10 k",
 * 100_000_000 → "100 M"). Matches the spacing of `formatSampleRate`. Values
 * below 1000 are shown as-is; non-round values keep up to two decimals.
 */
export function formatSampleCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1_000)} k`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)} M`;
  return `${trim(n / 1_000_000_000)} G`;
}

function trim(x: number): string {
  return parseFloat(x.toFixed(2)).toString();
}
