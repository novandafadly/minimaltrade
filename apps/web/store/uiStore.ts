"use client";

import { create } from "zustand";
import type { SignalCategory } from "@idx/domain";

export type SortKey = "score" | "generatedAt" | "netRR" | "symbol";
export type SortDirection = "asc" | "desc";
export type DashboardView = "trigger" | "journal" | "shadow";

interface UiState {
  view: DashboardView;
  setView: (view: DashboardView) => void;

  selectedSymbol: string | null;
  selectSymbol: (symbol: string | null) => void;

  categoryFilter: Set<SignalCategory>;
  toggleCategoryFilter: (category: SignalCategory) => void;
  clearCategoryFilter: () => void;

  sortKey: SortKey;
  sortDirection: SortDirection;
  setSort: (key: SortKey) => void;

  drawerOpen: boolean;
  openDrawer: (symbol: string) => void;
  closeDrawer: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "trigger",
  setView: (view) => set({ view }),

  selectedSymbol: null,
  selectSymbol: (symbol) => set({ selectedSymbol: symbol }),

  categoryFilter: new Set(),
  toggleCategoryFilter: (category) =>
    set((state) => {
      const next = new Set(state.categoryFilter);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return { categoryFilter: next };
    }),
  clearCategoryFilter: () => set({ categoryFilter: new Set() }),

  sortKey: "score",
  sortDirection: "desc",
  setSort: (key) =>
    set((state) => {
      if (state.sortKey === key) {
        return { sortDirection: state.sortDirection === "desc" ? "asc" : "desc" };
      }
      return { sortKey: key, sortDirection: "desc" };
    }),

  drawerOpen: false,
  openDrawer: (symbol) => set({ drawerOpen: true, selectedSymbol: symbol }),
  closeDrawer: () => set({ drawerOpen: false })
}));
