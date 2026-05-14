'use client';

import { Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { restoreDeletedAction } from '@/server/actions/recovery';

type Entity =
  | 'inventory_items'
  | 'categories'
  | 'locations'
  | 'suppliers'
  | 'tags';

export function RestoreButton({
  entity,
  id,
  label,
}: {
  entity: Entity;
  id: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function restore() {
    setBusy(true);
    try {
      const res = await restoreDeletedAction({ entity, id });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success(`Restored "${label}".`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={restore} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCcw className="h-3.5 w-3.5" />
      )}
      Restore
    </Button>
  );
}
