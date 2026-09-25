'use client';

import { ClipboardCheck } from 'lucide-react';
import * as React from 'react';

import { COUNT_THIS_ITEM_LABEL, recountUnavailableCopy, type RecountUnavailableReason } from '@stockpilot/core';

import { RecountDialog } from '@/components/exceptions/recount-dialog';
import { Button } from '@/components/ui/button';
import { listItemRecountTargetsAction } from '@/server/actions/exceptions';

type Targets =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      occurrenceIds: string[];
      canRecount: boolean;
      unavailableReason: RecountUnavailableReason | null;
    }
  | { kind: 'failed' };

/**
 * "Count this item" on the item page (F1-2), for a manager who can start a
 * count, on an item that can be counted (the page decides both; the server
 * and the database re-check).
 *
 * It starts a recount of this one item through the same dialog the
 * Exceptions list uses. When it opens it asks which of the item's open
 * exceptions a count can settle, and names them, so the count is linked to
 * them and they show "Recount in progress" (the database links only the
 * exceptions it is named). If that read fails the item can still be counted;
 * the dialog says the count will not be linked.
 */
export function CountThisItemButton({ itemId, timeZone }: { itemId: string; timeZone?: string }) {
  const [open, setOpen] = React.useState(false);
  const [targets, setTargets] = React.useState<Targets>({ kind: 'loading' });
  // Only the latest opening's answer is used (an earlier one can land late).
  const seqRef = React.useRef(0);

  async function openDialog() {
    const seq = ++seqRef.current;
    setTargets({ kind: 'loading' });
    setOpen(true);
    let res: Awaited<ReturnType<typeof listItemRecountTargetsAction>> | null;
    try {
      res = await listItemRecountTargetsAction(itemId);
    } catch {
      // The action request itself failed (a dropped connection, a deploy
      // that no longer has this action): the same as a failed read, never a
      // dialog stuck on "Checking...".
      res = null;
    }
    if (seq !== seqRef.current) return;
    setTargets(
      res === null || 'error' in res
        ? { kind: 'failed' }
        : {
            kind: 'ready',
            occurrenceIds: res.occurrenceIds,
            canRecount: res.canRecount,
            unavailableReason: res.recountUnavailableReason ?? null,
          },
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="sm:size-auto"
        onClick={() => void openDialog()}
        data-testid="count-this-item"
      >
        <ClipboardCheck className="h-4 w-4" /> {COUNT_THIS_ITEM_LABEL}
      </Button>
      <RecountDialog
        open={open}
        onOpenChange={setOpen}
        title={COUNT_THIS_ITEM_LABEL}
        itemIds={[itemId]}
        occurrenceIds={targets.kind === 'ready' ? targets.occurrenceIds : []}
        preparing={targets.kind === 'loading'}
        blocked={
          targets.kind === 'ready' && !targets.canRecount ? recountUnavailableCopy(targets.unavailableReason) : null
        }
        note={
          targets.kind === 'failed'
            ? 'This item’s open exceptions could not be read, so the count will not be linked to them. The system still checks them after the count is posted.'
            : targets.kind === 'ready' && targets.occurrenceIds.length > 0
              ? `The count will be linked to this item’s ${targets.occurrenceIds.length === 1 ? 'open exception' : `${targets.occurrenceIds.length} open exceptions`}.`
              : null
        }
        timeZone={timeZone}
      />
    </>
  );
}
