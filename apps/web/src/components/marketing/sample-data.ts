/**
 * Sample data for the marketing landing — a fictional small-batch coffee
 * roastery, taken from the Claude Design hand-off. Used only for visual
 * texture inside the hero preview, scrollytelling scenes, and dashboard
 * mockup. None of this is wired to real Supabase queries.
 */

export interface SampleItem {
  sku: string;
  name: string;
  origin: string;
  category: string;
  uom: string;
  cost: number;
  stock: number;
  reorder: number;
  par: number;
  status: 'ok' | 'warn' | 'crit';
  trend: 'up' | 'down' | 'flat';
  series: number[];
}

const seedRandom = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
};

const baseItems: Omit<SampleItem, 'series'>[] = [
  { sku: 'GRN-ETH-YIR-G2', name: 'Yirgacheffe Konga', origin: 'Ethiopia', category: 'Green coffee', uom: 'kg', cost: 7.2, stock: 412, reorder: 200, par: 800, status: 'ok', trend: 'up' },
  { sku: 'GRN-COL-LAS-N1', name: 'La Serrania Lot 12', origin: 'Colombia', category: 'Green coffee', uom: 'kg', cost: 8.4, stock: 96, reorder: 150, par: 600, status: 'warn', trend: 'down' },
  { sku: 'GRN-KEN-NYE-AA', name: 'Nyeri Gichathaini AA', origin: 'Kenya', category: 'Green coffee', uom: 'kg', cost: 9.1, stock: 0, reorder: 120, par: 400, status: 'crit', trend: 'down' },
  { sku: 'GRN-BRA-FAZ-N2', name: 'Fazenda Pinhal Natural', origin: 'Brazil', category: 'Green coffee', uom: 'kg', cost: 5.6, stock: 1240, reorder: 400, par: 1500, status: 'ok', trend: 'flat' },
  { sku: 'GRN-GUA-HUE-W1', name: 'Huehuetenango Washed', origin: 'Guatemala', category: 'Green coffee', uom: 'kg', cost: 7.8, stock: 318, reorder: 200, par: 700, status: 'ok', trend: 'up' },
  { sku: 'RST-HSE-12OZ', name: 'House Blend · 12oz', origin: 'Roasted', category: 'Roasted retail', uom: 'bag', cost: 6.4, stock: 84, reorder: 60, par: 200, status: 'ok', trend: 'up' },
  { sku: 'RST-DCF-12OZ', name: 'Decaf Sumatra · 12oz', origin: 'Roasted', category: 'Roasted retail', uom: 'bag', cost: 7.1, stock: 22, reorder: 30, par: 100, status: 'warn', trend: 'down' },
  { sku: 'RST-ESP-1KG', name: 'Wholesale Espresso · 1kg', origin: 'Roasted', category: 'Roasted wholesale', uom: 'bag', cost: 14.8, stock: 156, reorder: 80, par: 240, status: 'ok', trend: 'up' },
  { sku: 'GRN-ETH-GUJ-N1', name: 'Guji Hambela Natural', origin: 'Ethiopia', category: 'Green coffee', uom: 'kg', cost: 8.8, stock: 246, reorder: 150, par: 500, status: 'ok', trend: 'up' },
];

export const SAMPLE_ITEMS: SampleItem[] = baseItems.map((it, idx) => {
  const r = seedRandom(idx + 7);
  const base = it.stock || 50;
  const direction = it.trend === 'up' ? 1 : it.trend === 'down' ? -1 : 0;
  const series: number[] = [];
  let v = base * (1 - direction * 0.35);
  for (let i = 0; i < 14; i++) {
    v = Math.max(0, v + (r() - 0.5) * base * 0.18 + direction * base * 0.04);
    series.push(Math.round(v));
  }
  return { ...it, series };
});

export interface SampleMovement {
  id: string;
  at: string;
  type: string;
  item: string;
  sku: string;
  qty: number;
  user: string;
  ref: string;
}

export const SAMPLE_MOVEMENTS: SampleMovement[] = [
  { id: 'MV-2418', at: 'Apr 28 · 09:42', type: 'Receive', item: 'Yirgacheffe Konga', sku: 'GRN-ETH-YIR-G2', qty: 120, user: 'Mara K.', ref: 'PO-1041' },
  { id: 'MV-2417', at: 'Apr 28 · 09:18', type: 'Roast out', item: 'House Blend · 12oz', sku: 'RST-HSE-12OZ', qty: 48, user: 'Theo L.', ref: 'BATCH-3318' },
  { id: 'MV-2416', at: 'Apr 28 · 08:55', type: 'Roast in', item: 'Fazenda Pinhal Natural', sku: 'GRN-BRA-FAZ-N2', qty: -28, user: 'Theo L.', ref: 'BATCH-3318' },
  { id: 'MV-2415', at: 'Apr 28 · 08:14', type: 'Sale', item: 'Wholesale Espresso · 1kg', sku: 'RST-ESP-1KG', qty: -14, user: 'System', ref: 'INV-9012' },
  { id: 'MV-2414', at: 'Apr 27 · 17:02', type: 'Adjust', item: 'Decaf Sumatra · 12oz', sku: 'RST-DCF-12OZ', qty: -2, user: 'Mara K.', ref: 'Damaged' },
  { id: 'MV-2413', at: 'Apr 27 · 14:48', type: 'Transfer', item: 'Cream stoneware mug 8oz', sku: 'EQP-MUG-CRM', qty: -6, user: 'Jess P.', ref: 'TR-204' },
];

// 30-day inventory value series for the chart-draw scrollytelling scene
export const SAMPLE_CHART_DAYS: Array<{ day: number; value: number }> = (() => {
  const out: Array<{ day: number; value: number }> = [];
  let v = 142000;
  const r = seedRandom(91);
  for (let i = 29; i >= 0; i--) {
    v += (r() - 0.42) * 4200;
    out.push({ day: i, value: Math.round(v) });
  }
  return out;
})();
