import { ItemDetail } from '@/components/inventory/item-detail';
import { safeReturnPath } from '@/lib/safe-return-path';

const DEFAULT_BACK = '/dashboard/books';

export default async function BookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; return?: string }>;
}) {
  const { id } = await params;
  const { tab, return: returnParam } = await searchParams;
  // Mirror of /dashboard/inventory/[id]/page.tsx — validate the back
  // link target, fall back to the books list root if absent or
  // invalid. Pass the validated value as `returnParam` so the
  // ItemDetail "Edit" link can carry it forward.
  const validated = safeReturnPath(returnParam);
  const backHref = validated ?? DEFAULT_BACK;
  return (
    <ItemDetail
      id={id}
      backHref={backHref}
      backLabel="Back to books"
      editHref={`/dashboard/books/${id}/edit`}
      tab={tab}
      returnParam={validated ?? undefined}
    />
  );
}
