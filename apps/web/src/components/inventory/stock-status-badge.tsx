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

/**
 * The stock status pill (DESIGN-SPEC 6.10): each label on one of the six Badge
 * tones, led by the Badge's own 5px dot in the label's colour (its `dot` prop),
 * so the dot, the gap and the one-line rule live in the Badge alone and a pill
 * never shows two dots. The words are the cue (colour is never the only one):
 * In stock, Low stock, Out of stock, Expected, Archived (+ Auto-archived) and
 * Discontinued, decided by the rule below. There is no other tier: nothing is
 * called "Critical".
 */
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
        dot
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
        <Badge variant="outline" dot>
          Archived
        </Badge>
        {autoArchived && (
          <Badge
            variant="secondary"
            dot
            title="The system archived this item automatically after it sat at zero stock past the org's dwell window."
          >
            Auto-archived
          </Badge>
        )}
      </div>
    );
  }
  if (itemStatus === 'discontinued') {
    return (
      <Badge variant="outline" dot>
        Discontinued
      </Badge>
    );
  }
  if (quantity <= 0) {
    return (
      <Badge variant="destructive" dot>
        Out of stock
      </Badge>
    );
  }
  if (reorderPoint > 0 && quantity <= reorderPoint) {
    return (
      <Badge variant="warning" dot>
        Low stock
      </Badge>
    );
  }
  return (
    <Badge variant="success" dot>
      In stock
    </Badge>
  );
}
