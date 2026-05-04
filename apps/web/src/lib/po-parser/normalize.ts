import { createHash } from 'node:crypto';

export function normalizeUom(input: string | null | undefined): string | null {
  if (!input) return null;
  const t = input.trim().toUpperCase();
  return t.length === 0 ? null : t;
}

export function parseMoney(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  // Accounting style: (123.45) means -123.45
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()$,\s]/g, '');
  if (cleaned === '' || !/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function parseQty(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function sha256Hex(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return createHash('sha256').update(u8).digest('hex');
}
