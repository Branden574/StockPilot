/**
 * Display format for maintenance request numbers, beside formatOrderNumber.
 * request_number is a single per-org bigint (0314 advisory-lock trigger);
 * the YEAR IS COSMETIC — derived from created_at at format time, never part
 * of the counter, never stored (audit Q4). The display string never exists
 * in the database, so search parses the handle back to the bigint.
 */
export function formatMaintenanceRequestNumber(
  n: number | null | undefined,
  createdAt: string | Date | null | undefined,
): string | null {
  if (!n || n <= 0) return null;
  const d = createdAt instanceof Date ? createdAt : createdAt ? new Date(createdAt) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `MR-${d.getUTCFullYear()}-${String(n).padStart(6, '0')}`;
}

/** 'MR-2026-000123' | 'MR-000123' | '123' -> 123. Anything else -> null. */
export function parseMaintenanceRequestNumber(handle: string): number | null {
  const m = handle.trim().match(/^(?:mr-?(?:\d{4}-)?)?0*(\d{1,12})$/i);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
