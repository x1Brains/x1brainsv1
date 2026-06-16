// Small shared formatters used by v2 pages.

export function pow10(n: number): number {
  let r = 1;
  for (let i = 0; i < n; i++) r *= 10;
  return r;
}

export function fmtUSD(v: number): string {
  if (!isFinite(v)) return '$—';
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return '$' + (v / 1_000).toFixed(2) + 'K';
  return '$' + v.toFixed(2);
}

export function fmtNum(v: number, dec = 2): string {
  if (!isFinite(v)) return '—';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(2) + 'K';
  return v.toFixed(dec);
}

export function shortAddr(s: string, head = 4, tail = 4): string {
  if (!s) return '';
  return s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}
