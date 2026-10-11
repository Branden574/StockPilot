'use client';

import { Ungroup } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { UNGROUP_COPY } from '@stockpilot/core';

import { Button } from '@/components/ui/button';

import { UngroupDialog } from './ungroup-dialog';

/**
 * The item page's "Make this its own item" (Ungroup for one record, design
 * section 5): the same review dialog as the bulk bar, for this record alone.
 * After a split the page refreshes to show the record's new SKU.
 */
export function MakeOwnItemButton({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const ids = React.useMemo(() => [itemId], [itemId]);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Ungroup className="h-3.5 w-3.5" /> {UNGROUP_COPY.makeOwnItem}
      </Button>
      {open ? (
        <UngroupDialog open itemIds={ids} onOpenChange={setOpen} onDone={() => router.refresh()} />
      ) : null}
    </>
  );
}
