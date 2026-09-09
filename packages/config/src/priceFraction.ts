/**
 * IDX price fraction (tick) table. Blueprint says SL/prices must be "rounded
 * to a valid price fraction" without giving the table, so this implements the
 * standard IDX fraction rules (versioned, overridable via strategy_config in
 * future if the exchange changes them).
 */
export interface PriceFractionTier {
  maxPrice: number; // inclusive upper bound of this tier, Infinity for last tier
  tick: number;
}

export const IDX_PRICE_FRACTION_TABLE: PriceFractionTier[] = [
  { maxPrice: 200, tick: 1 },
  { maxPrice: 500, tick: 2 },
  { maxPrice: 2000, tick: 5 },
  { maxPrice: 5000, tick: 10 },
  { maxPrice: Infinity, tick: 25 }
];

export function tickSizeFor(price: number, table: PriceFractionTier[] = IDX_PRICE_FRACTION_TABLE): number {
  for (const tier of table) {
    if (price <= tier.maxPrice) return tier.tick;
  }
  const last = table[table.length - 1];
  if (!last) throw new Error("price fraction table is empty");
  return last.tick;
}

export function roundDownToTick(price: number, table: PriceFractionTier[] = IDX_PRICE_FRACTION_TABLE): number {
  const tick = tickSizeFor(price, table);
  return Math.floor(price / tick) * tick;
}

export function roundUpToTick(price: number, table: PriceFractionTier[] = IDX_PRICE_FRACTION_TABLE): number {
  const tick = tickSizeFor(price, table);
  return Math.ceil(price / tick) * tick;
}
