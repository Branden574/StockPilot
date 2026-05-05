import Link from 'next/link';

import { LabelSheet } from '@/components/inventory/label-sheet';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

interface LabelItem {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
}

export default async function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ items?: string; copies?: string; template?: string }>;
}) {
  const params = await searchParams;
  const ids = (params.items ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const copies = Math.max(1, Math.min(20, Number(params.copies) || 1));
  const template =
    params.template === 'large' || params.template === 'small'
      ? params.template
      : 'medium';

  const inventorySvc = await InventoryService.forCurrentUser();
  let items: LabelItem[] = [];
  if (ids.length > 0) {
    try {
      const list = await inventorySvc.list({ limit: 500, status: 'all', itemType: 'all' });
      const byId = new Map(list.items.map((i) => [i.id, i]));
      items = ids
        .map((id) => byId.get(id))
        .filter((i): i is NonNullable<typeof i> => Boolean(i))
        .map((i) => ({ id: i.id, name: i.name, sku: i.sku, barcode: i.barcode ?? null }));
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
    }
  }

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6 print:max-w-none print:px-0 print:py-0">
      <div className="mb-6 print:hidden">
        <Link
          href="/dashboard/inventory"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to inventory
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Print labels</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {items.length === 0
            ? 'Pick items from the inventory list and click "Print labels" — or pass ?items=id1,id2 to this URL.'
            : `${items.length} item${items.length === 1 ? '' : 's'} selected · ${copies} cop${copies === 1 ? 'y' : 'ies'} each = ${items.length * copies} label${items.length * copies === 1 ? '' : 's'}.`}
        </p>
      </div>
      <LabelSheet items={items} copies={copies} template={template} />
    </div>
  );
}
