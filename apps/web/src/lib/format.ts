import { formatEther } from "viem";

/** Wei decimal string → ETH, trimmed to ≤ 6 significant fractional digits (leading zeros don't count). */
export function eth(wei: string | null | undefined): string {
  if (!wei) return "0";
  let big: bigint;
  try {
    big = BigInt(wei);
  } catch {
    return "?";
  }
  const s = formatEther(big);
  const [int, frac = ""] = s.split(".");
  if (!frac) return int;
  const lead = frac.match(/^0*/)?.[0].length ?? 0;
  const trimmed = frac.slice(0, lead + 6).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}

export function sumWei(values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const v of values) {
    if (!v) continue;
    try {
      total += BigInt(v);
    } catch {
      /* skip malformed */
    }
  }
  return total.toString();
}

export function shortAddr(addr: string | null | undefined, n = 4): string {
  if (!addr) return "—";
  if (addr.length <= 2 + n * 2) return addr;
  return `${addr.slice(0, 2 + n)}…${addr.slice(-n)}`;
}

export function shortHash(h: string | null | undefined): string {
  return shortAddr(h, 6);
}

export function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Remaining time until `iso`, e.g. "2d 3h", "3h 12m", "12m 05s". Negative → "expired". */
export function countdown(iso: string, now: number): { text: string; ms: number } {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return { text: "—", ms: 0 };
  if (ms <= 0) return { text: "expired", ms };
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return { text: `${d}d ${h}h`, ms };
  if (h > 0) return { text: `${h}h ${String(m).padStart(2, "0")}m`, ms };
  return { text: `${m}m ${String(sec).padStart(2, "0")}s`, ms };
}

export function pct(num: number, den: number): string {
  if (!den) return "—";
  return `${Math.round((num / den) * 100)}%`;
}
