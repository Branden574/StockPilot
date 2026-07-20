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
  /**
   * True while an item auto-created from an inbound PO has never
   * received any stock (inventory_items.awaiting_first_receipt,
   * migration 0277). Replaces the misleading "Out of stock" pill with
   * "Expected" — the item was never in stock to begin with. Cleared by
   * a DB trigger the moment any stock arrives.
   */
  awaitingFirstReceipt?: boolean;
  /**
   * Renders the Expected pill with its long label ("Expected — awaiting
   * first receipt") — used on the item DETAIL page where a search /
   * direct-link visitor needs the context inline, not in a tooltip.
   */
  expectedVerbose?: boolean;
}

export function StockStatusBadge({
  quantity,
  reorderPoint,
  itemStatus = 'active',
  autoArchived = false,
  awaitingFirstReceipt = false,
  expectedVerbose = false,
}: StockStatusBadgeProps) {
  if (itemStatus === 'active' && awaitingFirstReceipt) {
    return (
      <Badge
        variant="secondary"
        title="Created from a purchase order — nothing has been received yet. It appears everywhere the moment the first stock arrives."
      >
        {expectedVerbose ? 'Expected — awaiting first receipt' : 'Expected'}
      </Badge>
    );
  }
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
