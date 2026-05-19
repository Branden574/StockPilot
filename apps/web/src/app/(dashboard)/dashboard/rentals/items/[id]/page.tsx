import { ItemDetail } from '@/components/inventory/item-detail';
import { safeReturnPath } from '@/lib/safe-return-path';

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
  return (
    <ItemDetail
      id={id}
      backHref={backHref}
      backLabel="Back to rental items"
      tab={tab}
      returnParam={validated ?? undefined}
    />
  );
}
