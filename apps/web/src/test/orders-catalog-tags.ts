import { expect } from 'vitest';

/**
 * The tags every Place an Order catalog entry carries, for one organization
 * and warehouse (loaders/orders-new-catalog.ts, loadCatalogItemsCached; the
 * loader's own list is checked against this in orders-new-catalog.test.ts).
 * An expired tag marks an entry stale exactly when it is one of these.
 */
export function catalogEntryTags(organizationId: string, warehouseId: string): string[] {
  return [
    'orders-new-v2-catalog',
    `orders-new-v2-catalog:${organizationId}`,
    `orders-new-v2-catalog:${organizationId}:${warehouseId}`,
  ];
}

type Entry = readonly [organizationId: string, warehouseId: string];

/**
 * Asserts which catalog entries the expired tags reach: every entry in `hits`
 * carries at least one of them, and no entry in `misses` carries any.
 */
export function expectCatalogExpiryReaches(
  expiredTags: readonly unknown[],
  { hits, misses }: { hits: readonly Entry[]; misses: readonly Entry[] },
): void {
  const reaches = ([org, wh]: Entry) =>
    catalogEntryTags(org, wh).some((tag) => expiredTags.includes(tag));
  for (const entry of hits) expect(reaches(entry), `entry ${entry.join('/')} expired`).toBe(true);
  for (const entry of misses)
    expect(reaches(entry), `entry ${entry.join('/')} untouched`).toBe(false);
}
