"use client";

import type { SignalCategory } from "@idx/domain";
import { ALL_CATEGORIES, categoryBadge } from "../lib/category";
import { useUiStore } from "../store/uiStore";
import { toneClassName } from "./tone";

export function SummaryStrip({ counts }: { counts: Record<SignalCategory, number> }) {
  const categoryFilter = useUiStore((s) => s.categoryFilter);
  const toggleCategoryFilter = useUiStore((s) => s.toggleCategoryFilter);
  const clearCategoryFilter = useUiStore((s) => s.clearCategoryFilter);

  return (
    <div className="summary-strip" role="toolbar" aria-label="Filter by category">
      {ALL_CATEGORIES.map((category) => {
        const badge = categoryBadge(category);
        const active = categoryFilter.has(category);
        return (
          <button
            key={category}
            className={`summary-chip ${toneClassName(badge.tone)} ${active ? "summary-chip-active" : ""}`}
            onClick={() => toggleCategoryFilter(category)}
            aria-pressed={active}
          >
            <span className="summary-chip-count">{counts[category] ?? 0}</span>
            <span className="summary-chip-label">{badge.label}</span>
          </button>
        );
      })}
      {categoryFilter.size > 0 ? (
        <button className="btn btn-link" onClick={clearCategoryFilter}>
          Clear filter
        </button>
      ) : null}
    </div>
  );
}
