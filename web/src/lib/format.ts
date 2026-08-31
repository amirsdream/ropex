export function num(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function ms(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 1000) return Math.round(v) + "ms";
  if (v < 60_000) return (v / 1000).toFixed(1) + "s";
  return (v / 60_000).toFixed(1) + "m";
}

export function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = Date.now() - t;
  if (d < 1000) return "now";
  if (d < 60_000) return Math.floor(d / 1000) + "s ago";
  if (d < 3_600_000) return Math.floor(d / 60_000) + "m ago";
  return Math.floor(d / 3_600_000) + "h ago";
}

export function clock(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}
