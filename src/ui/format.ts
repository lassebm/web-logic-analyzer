const UNITS = [
  [1_000_000_000, "G"],
  [1_000_000, "M"],
  [1_000, "k"],
] as const;

/**
 * Format a sample count compactly (e.g. 10000 → "10 k", 100_000_000 → "100 M").
 * Matches the spacing of `formatSampleRate`.
 *
 * The suffix is only used when two decimals say the number *exactly*; anything
 * else is written out in full ("4,096"). These counts are values the user picks
 * from a list and gets literally — a device with a 4096-sample buffer offering
 * "4.1 k" would be naming a number it can't capture. Binary buffer depths, which
 * is what every SUMP device reports, land in that case constantly.
 */
export function formatSampleCount(n: number): string {
  if (n < 1_000) return String(n);
  for (const [unit, suffix] of UNITS) {
    // `unit / 100` is one hundredth of the unit, so this is "a whole number of
    // hundredths" — the integer way to ask whether two decimals are exact.
    if (n >= unit && n % (unit / 100) === 0) {
      return `${trim(n / unit)} ${suffix}`;
    }
  }
  return n.toLocaleString();
}

function trim(x: number): string {
  return parseFloat(x.toFixed(2)).toString();
}
