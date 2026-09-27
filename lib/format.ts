const SUFFIXES = ['', 'K', 'M', 'G', 'T', 'P', 'E'];

/** Formats a large number with a magnitude suffix, e.g. 138_960_000_000_000 -> "138.96 T". */
export function diffSuffix(value: number): string {
  if (value == null || value < 0) return '0';
  if (value === 0) return '0';

  const power = Math.max(0, Math.floor(Math.log10(value) / 3));
  const scaled = value / Math.pow(1000, power);
  const suffix = SUFFIXES[power] || '';
  const space = suffix ? ' ' : '';

  return power > 0 ? `${scaled.toFixed(2)}${space}${suffix}` : `${scaled.toFixed(0)}${space}${suffix}`;
}

/** Formats a satoshi amount as a BTC string, e.g. 313969308 -> "3.13969308 BTC". */
export function satsToBtc(satoshis: number): string {
  if (!satoshis) return '0 BTC';
  return (satoshis / 100_000_000).toFixed(8) + ' BTC';
}
