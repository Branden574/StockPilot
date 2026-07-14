import { Badge } from '@/components/ui/badge';

interface StockStatusBadgeProps {
  quantity: number;
  reorderPoint: number;
  itemStatus?: 'active' | 'archived' | 'discontinued';
  /**
   * True when the SYSTEM auto-archived this item on zero stock
   * (inventory_items.auto_archived, migration 0266), as opposed to a
   * human archiving it. Only rendered when itemStatus is 'archived' —
   * an active row never carries this (the flag is cleared on restore).
   */
  autoArchived?: boolean;
}

export function StockStatusBadge({
  quantity,
  reorderPoint,
  itemStatus = 'active',
  autoArchived = false,
}: StockStatusBadgeProps) {
  if (itemStatus === 'archived') {
    return (
      // Badge renders a <div> — wrap in a <div> too (not <span>) so two
      // adjacent badges don't produce invalid div-inside-span nesting.
      <div className="inline-flex items-center gap-1">
        <Badge variant="outline">Archived</Badge>
        {autoArchived && (
          <Badge
            variant="secondary"
            title="The system archived this item automatically after it sat at zero stock past the org's dwell window."
          >
            Auto-archived
          </Badge>
        )}
      </div>
    );
  }
  if (itemStatus === 'discontinued') return <Badge variant="outline">Discontinued</Badge>;
  if (quantity <= 0) return <Badge variant="destructive">Out of stock</Badge>;
  if (reorderPoint > 0 && quantity <= reorderPoint) return <Badge variant="warning">Low stock</Badge>;
  return <Badge variant="success">In stock</Badge>;
}
