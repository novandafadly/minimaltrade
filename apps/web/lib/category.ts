import type { SignalCategory } from "@idx/domain";

export const ALL_CATEGORIES: SignalCategory[] = [
  "STRONG_BUY",
  "SPECULATIVE_BUY",
  "WATCHLIST",
  "AVOID",
  "NO_TRADE"
];

export interface CategoryBadge {
  label: string;
  /** semantic tone, mapped to CSS classes in the UI layer — kept out of this
   * pure module so it stays unit-testable without a DOM/CSS dependency. */
  tone: "positive" | "caution" | "neutral" | "negative" | "muted";
}

export function categoryBadge(category: SignalCategory): CategoryBadge {
  switch (category) {
    case "STRONG_BUY":
      return { label: "Strong Buy", tone: "positive" };
    case "SPECULATIVE_BUY":
      return { label: "Speculative Buy", tone: "caution" };
    case "WATCHLIST":
      return { label: "Watchlist", tone: "neutral" };
    case "AVOID":
      return { label: "Avoid", tone: "negative" };
    case "NO_TRADE":
      return { label: "No Trade", tone: "muted" };
    default:
      return { label: category, tone: "neutral" };
  }
}

export function emptyCategoryCounts(): Record<SignalCategory, number> {
  return {
    STRONG_BUY: 0,
    SPECULATIVE_BUY: 0,
    WATCHLIST: 0,
    AVOID: 0,
    NO_TRADE: 0
  };
}

export function countByCategory(categories: SignalCategory[]): Record<SignalCategory, number> {
  const counts = emptyCategoryCounts();
  for (const c of categories) {
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}
