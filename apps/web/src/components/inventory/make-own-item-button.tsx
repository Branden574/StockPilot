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
 *
 * `offer` says whether to show the button (other records the viewer can see
 * share this SKU). The page mounts this host for every editor of a record that
 * can be ungrouped, offered or not, because a split makes the SKU the
 * record's own: the refreshed page then stops offering it, and a host mounted
 * only while offered would take its open dialog, with the split's result (the
 * new SKU, Print labels), down with it (fix round 1, P1). The dialog stays
 * until the person closes it.
 */
export function MakeOwnItemButton({ itemId, offer }: { itemId: string; offer: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const ids = React.useMemo(() => [itemId], [itemId]);
  return (
    <>
      {offer ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Ungroup className="h-3.5 w-3.5" /> {UNGROUP_COPY.makeOwnItem}
        </Button>
      ) : null}
      {open ? (
        <UngroupDialog open itemIds={ids} onOpenChange={setOpen} onDone={() => router.refresh()} />
      ) : null}
    </>
  );
}
