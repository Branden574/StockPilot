import type { Metadata } from 'next';

import { ItemDetail } from '@/components/inventory/item-detail';
import { safeReturnPath } from '@/lib/safe-return-path';
import { notFoundUnlessUuid } from '@/server/lib/path-id';

// The browser tab's title (CONFLICTS D16: the item page had none, so it read
// "Dashboard · StockPilot"). A fixed word, as the Exception and Location pages
// have: the record's name would cost a read of its own before the page renders.
export const metadata: Metadata = { title: 'Item' };

const DEFAULT_BACK = '/dashboard/inventory';

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; return?: string }>;
}) {
  const { id } = await params;
  // A malformed id (a mistyped or cut-off link) is Page not found before
  // anything is read with it (B63).
  notFoundUnlessUuid(id);
  const { tab, return: returnParam } = await searchParams;
  // Validate the back-link target — `return` is user-controlled so we
  // never trust it without going through safeReturnPath. Cross-origin
  // and protocol-relative values are rejected; we then fall back to the
  // hardcoded inventory list root.
  const validated = safeReturnPath(returnParam);
  const backHref = validated ?? DEFAULT_BACK;
  return (
    <ItemDetail
      id={id}
      backHref={backHref}
      backLabel="Back to inventory"
      tab={tab}
      returnParam={validated ?? undefined}
    />
  );
}
