/**
 * Sample data for the marketing landing hero preview. Generic
 * charter-school / warehouse-shaped items so the rendered table reads
 * as our actual product, not the pre-pivot coffee-roastery demo.
 *
 * Not wired to real Supabase queries — visual texture only.
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
  { sku: 'TXT-ALG-G9-2026', name: 'Algebra I · Grade 9', origin: 'Curriculum', category: 'Textbooks', uom: 'ea', cost: 64.0, stock: 312, reorder: 150, par: 600, status: 'ok', trend: 'up' },
  { sku: 'TXT-BIO-G10-2026', name: 'Biology · Grade 10', origin: 'Curriculum', category: 'Textbooks', uom: 'ea', cost: 71.5, stock: 96, reorder: 120, par: 480, status: 'warn', trend: 'down' },
  { sku: 'DEV-CHR-11-EDU', name: 'Chromebook 11" (student)', origin: 'Tech', category: 'Devices', uom: 'ea', cost: 289.0, stock: 0, reorder: 40, par: 200, status: 'crit', trend: 'down' },
  { sku: 'SUP-PAP-LTR-CT', name: 'Copy paper · letter (case)', origin: 'Supplies', category: 'Office', uom: 'case', cost: 38.0, stock: 184, reorder: 60, par: 220, status: 'ok', trend: 'flat' },
  { sku: 'UNI-POL-NVY-M', name: 'Polo · navy · medium', origin: 'Apparel', category: 'Uniforms', uom: 'ea', cost: 12.5, stock: 248, reorder: 100, par: 400, status: 'ok', trend: 'up' },
  { sku: 'SPT-BBL-OFC', name: 'Basketball · official', origin: 'Athletics', category: 'PE equipment', uom: 'ea', cost: 24.0, stock: 22, reorder: 18, par: 60, status: 'warn', trend: 'down' },
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
