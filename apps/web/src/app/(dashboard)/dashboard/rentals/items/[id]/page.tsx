import { ItemDetail } from '@/components/inventory/item-detail';
import { safeReturnPath } from '@/lib/safe-return-path';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import { InventoryService } from '@/server/services/inventory';

// The Liquid Glass item page (Item-Detail.dc.html): this route renders the same
// ItemDetail as the Items and Books pages, glass summary, side column and More
// actions included, so it takes the same composition. Every rule is scoped to
// ItemDetail's [data-glass-page] root and to glass, so classic never matches
// it (styles/liquid-glass/glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/item-detail.css';

const DEFAULT_BACK = '/dashboard/rentals/items';

export default async function RentalItemDetailPage({
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
  const validated = safeReturnPath(returnParam);
  const backHref = validated ?? DEFAULT_BACK;

  // Rentals reserve stock instead of decrementing on-hand, so the detail
  // page surfaces out-on-rental + available. Same active-reservation sum
  // the /rentals/new catalog uses. Best-effort: a read failure leaves the
  // prop undefined and the detail renders exactly like inventory/books.
  let reservedQuantity: number | undefined;
  try {
    const inventorySvc = await InventoryService.forCurrentUser();
    const reservedByItem = await inventorySvc.reservedQuantityByItemIds([id]);
    reservedQuantity = reservedByItem.get(id) ?? 0;
  } catch {
    reservedQuantity = undefined;
  }

  return (
    <ItemDetail
      id={id}
      backHref={backHref}
      backLabel="Back to rental items"
      tab={tab}
      returnParam={validated ?? undefined}
      reservedQuantity={reservedQuantity}
    />
  );
}
