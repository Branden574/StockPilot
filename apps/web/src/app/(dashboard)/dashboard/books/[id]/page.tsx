import { ItemDetail } from '@/components/inventory/item-detail';

export default async function BookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return (
    <ItemDetail
      id={id}
      backHref="/dashboard/books"
      backLabel="Back to books"
      editHref={`/dashboard/books/${id}/edit`}
      tab={tab}
    />
  );
}
