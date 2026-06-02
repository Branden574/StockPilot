import { ItemDetail } from '@/components/inventory/item-detail';
import { safeReturnPath } from '@/lib/safe-return-path';
import { InventoryService } from '@/server/services/inventory';

const DEFAULT_BACK = '/dashboard/rentals/items';

export default async function RentalItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; return?: string }>;
}) {
  const { id } = await params;
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
