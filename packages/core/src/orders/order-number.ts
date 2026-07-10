/**
 * Display format for order-request numbers — matches the PO look
 * (prefix + zero-padded): order_number 49 → "SO-000049". Shared by web
 * and mobile so every surface prints the identical handle.
 */
export function formatOrderNumber(n: number | null | undefined): string | null {
  if (!n || n <= 0) return null;
  return `SO-${String(n).padStart(6, '0')}`;
}
