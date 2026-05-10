import { ItemDetail } from '@/components/inventory/item-detail';

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  // Tabs (Overview / Movements / Activity) and the AuditTimeline now
  // live inside <ItemDetail/>. The Activity tab renders the merged
  // movements + audit feed and, beneath it, the metadata-level audit
  // log (status flips, tracking-type changes, etc.) for admins.
  return (
    <ItemDetail
      id={id}
      backHref="/dashboard/inventory"
      backLabel="Back to inventory"
      tab={tab}
    />
  );
}
