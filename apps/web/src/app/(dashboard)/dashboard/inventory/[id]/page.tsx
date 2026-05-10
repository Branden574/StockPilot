import { AuditTimeline } from '@/components/audit/audit-timeline';
import { ItemDetail } from '@/components/inventory/item-detail';

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <ItemDetail id={id} backHref="/dashboard/inventory" backLabel="Back to inventory" />
      {/* AuditTimeline self-renders null when there are no rows, so this
          card does not appear on items with no recorded audit events.
          The merged movements + audit feed inside <ItemDetail/> covers
          quantity changes; this section surfaces metadata-level events
          (status changes, tracking-type flips, etc.) for admins. */}
      <div className="container mx-auto max-w-6xl px-4 pb-8 sm:px-6">
        <AuditTimeline
          entityType="inventory_item"
          entityId={id}
          limit={20}
          wrapperTitle="Recent activity"
        />
      </div>
    </>
  );
}
