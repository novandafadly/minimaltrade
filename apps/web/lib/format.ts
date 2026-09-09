/**
 * IDX-appropriate number/currency formatting helpers. Pure functions, unit
 * tested — the blueprint's own example ("ENTRY Rp1.000 sampai Rp1.005 ...")
 * uses id-ID thousand separators (dot) and the Rp prefix with no decimals for
 * whole-rupiah prices, so we standardize on that everywhere in the UI.
 */

const idrFormatter = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 0
});

const idrDecimalFormatter = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/** Formats a whole-rupiah amount as "Rp1.000" (id-ID grouping, no decimals). */
export function formatRupiah(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `Rp${idrFormatter.format(Math.round(value))}`;
}

/** Formats a rupiah amount with 2 decimals, e.g. for small fee/slippage figures. */
export function formatRupiahDecimal(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `Rp${idrDecimalFormatter.format(value)}`;
}

/** Formats a plain integer count with id-ID thousand separators, e.g. lots/volume. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return idrFormatter.format(value);
}

/** Formats a 0-1 ratio as a percentage string with 1 decimal, e.g. "34,5%". */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toLocaleString("id-ID", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}%`;
}

/** Formats a ratio like net RR as "2,1" (id-ID decimal comma), matching blueprint examples. */
export function formatRatio(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Formats an ISO timestamp as a compact age string, e.g. "3d", "45m", "12s", "just now". */
export function formatAge(sinceIso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!sinceIso) return "unknown";
  const since = new Date(sinceIso).getTime();
  if (Number.isNaN(since)) return "unknown";
  const deltaMs = nowMs - since;
  if (deltaMs < 0) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function ageMs(sinceIso: string | null | undefined, nowMs: number = Date.now()): number {
  if (!sinceIso) return Number.POSITIVE_INFINITY;
  const since = new Date(sinceIso).getTime();
  if (Number.isNaN(since)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - since);
}
