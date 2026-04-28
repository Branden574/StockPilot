import { Badge } from '@/components/ui/badge';

interface StockStatusBadgeProps {
  quantity: number;
  reorderPoint: number;
  itemStatus?: 'active' | 'archived' | 'discontinued';
}

export function StockStatusBadge({ quantity, reorderPoint, itemStatus = 'active' }: StockStatusBadgeProps) {
  if (itemStatus === 'archived') return <Badge variant="outline">Archived</Badge>;
  if (itemStatus === 'discontinued') return <Badge variant="outline">Discontinued</Badge>;
  if (quantity <= 0) return <Badge variant="destructive">Out of stock</Badge>;
  if (reorderPoint > 0 && quantity <= reorderPoint) return <Badge variant="warning">Low stock</Badge>;
  return <Badge variant="success">In stock</Badge>;
}
