import { ItemDetail } from '@/components/inventory/item-detail';
import { safeReturnPath } from '@/lib/safe-return-path';

const DEFAULT_BACK = '/dashboard/inventory';

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; return?: string }>;
}) {
  const { id } = await params;
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
