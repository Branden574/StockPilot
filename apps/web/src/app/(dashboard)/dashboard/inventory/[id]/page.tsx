import { ItemDetail } from '@/components/inventory/item-detail';

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ItemDetail id={id} backHref="/dashboard/inventory" backLabel="Back to inventory" />;
}
