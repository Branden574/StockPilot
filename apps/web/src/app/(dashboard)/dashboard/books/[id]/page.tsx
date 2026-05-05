import { ItemDetail } from '@/components/inventory/item-detail';

export default async function BookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ItemDetail id={id} backHref="/dashboard/books" backLabel="Back to books" />;
}
