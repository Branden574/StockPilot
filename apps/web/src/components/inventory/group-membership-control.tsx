'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { GROUP_COPY } from '@stockpilot/core';

import { Button } from '@/components/ui/button';

import { RemoveFromGroupDialog } from './display-group-dialogs';

/**
 * The item page's group line (Group selected, migration 0400): "In group
 * <name>" and, for someone who can edit items, Remove from group. Removing
 * deletes only the membership: the record, its SKU, stock, charter and rack
 * stay, and records that share its SKU still show together automatically.
 *
 * Mounted at a stable place for every editor, in a group or not: the removal
 * refreshes the page, which then shows no group, and a host mounted only while
 * the record is in a group would take the open dialog and its result with it
 * (the lesson of Ungroup's fix round 1, P1).
 */
export function GroupMembershipControl({
  itemId,
  groupName,
  canEdit,
  view,
}: {
  itemId: string;
  /** The record's display group name, or null when it is in none. */
  groupName: string | null;
  canEdit: boolean;
  view: 'items' | 'books';
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const ids = React.useMemo(() => [itemId], [itemId]);
  if (!groupName && !open) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px] leading-[18px]">
      {groupName ? (
        <span className="text-muted-foreground">{GROUP_COPY.itemPageInGroup(groupName)}</span>
      ) : null}
      {groupName && canEdit ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          {GROUP_COPY.removeAction}
        </Button>
      ) : null}
      {open ? (
        <RemoveFromGroupDialog
          open
          itemIds={ids}
          view={view}
          onOpenChange={setOpen}
          onDone={(o) => (o.outcome === 'applied' ? router.refresh() : undefined)}
        />
      ) : null}
    </span>
  );
}
