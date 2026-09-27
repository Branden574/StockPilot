'use client';

import { ClipboardCheck } from 'lucide-react';
import * as React from 'react';

import {
  LOCATION_RECOUNT_LABEL,
  recountUnavailableCopy,
  type RecountUnavailableReason,
} from '@stockpilot/core';

import { RecountDialog } from '@/components/exceptions/recount-dialog';
import { Button } from '@/components/ui/button';
import { listItemsRecountTargetsAction } from '@/server/actions/exceptions';

type Targets =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      occurrenceIds: string[];
      truncated: boolean;
      canRecount: boolean;
      unavailableReason: RecountUnavailableReason | null;
    }
  | { kind: 'failed' };

/**
 * "Recount items here" on a location's page (F1-3), for a reader the server
 * says may start a recount (the page renders it only then).
 *
 * It starts ONE recount of every item held here that can be counted, through
 * the F1-2 recount dialog and service (startRecountAction, the same
 * ExceptionRecountService the phone reaches), so the count is an ordinary
 * cycle count a manager posts. The ids are the server's (VerificationService
 * recountItemIds: every page, not just the one shown), and the service and
 * start_targeted_recount re-check each one.
 *
 * Disabled, with the reason beside it, when nothing here can be counted or
 * more items can be counted than one recount may hold. When the dialog opens
 * it asks which open exceptions about these items a count can settle, so the
 * count is linked to them, as "Count this item" does; if that read fails the
 * items can still be counted, and the dialog says the count will not be
 * linked.
 */
export function LocationRecountButton({
  itemIds,
  problem,
  timeZone,
}: {
  itemIds: string[];
  /** Why the button cannot be pressed (VerificationService recountProblem). */
  problem: string | null;
  timeZone?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [targets, setTargets] = React.useState<Targets>({ kind: 'loading' });
  // Only the latest opening's answer is used (an earlier one can land late).
  const seqRef = React.useRef(0);
  const disabled = problem !== null || itemIds.length === 0;
  const problemId = React.useId();

  async function openDialog() {
    if (disabled) return;
    const seq = ++seqRef.current;
    setTargets({ kind: 'loading' });
    setOpen(true);
    let res: Awaited<ReturnType<typeof listItemsRecountTargetsAction>> | null;
    try {
      res = await listItemsRecountTargetsAction(itemIds);
    } catch {
      // The request itself failed: the same as a failed read, never a dialog
      // stuck on "Checking...".
      res = null;
    }
    if (seq !== seqRef.current) return;
    setTargets(
      res === null || 'error' in res
        ? { kind: 'failed' }
        : {
            kind: 'ready',
            occurrenceIds: res.occurrenceIds,
            truncated: res.truncated,
            canRecount: res.canRecount,
            unavailableReason: res.recountUnavailableReason ?? null,
          },
    );
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void openDialog()}
        disabled={disabled}
        aria-describedby={problem ? problemId : undefined}
        data-testid="location-recount"
      >
        <ClipboardCheck className="h-4 w-4" aria-hidden /> {LOCATION_RECOUNT_LABEL}
      </Button>
      {problem ? (
        <p
          id={problemId}
          className="text-muted-foreground max-w-sm text-xs sm:text-right"
          data-testid="location-recount-problem"
        >
          {problem}
        </p>
      ) : null}
      <RecountDialog
        open={open}
        onOpenChange={setOpen}
        title={LOCATION_RECOUNT_LABEL}
        itemIds={itemIds}
        occurrenceIds={targets.kind === 'ready' ? targets.occurrenceIds : []}
        preparing={targets.kind === 'loading'}
        preparingLabel="Checking these items’ open exceptions..."
        blocked={
          targets.kind === 'ready' && !targets.canRecount
            ? recountUnavailableCopy(targets.unavailableReason)
            : null
        }
        note={locationRecountNote(itemIds.length, targets)}
        timeZone={timeZone}
      />
    </div>
  );
}

/** What the recount will include, and what it will be linked to. */
function locationRecountNote(items: number, targets: Targets): string {
  const parts = [
    `The count will include the ${items === 1 ? 'item' : `${items} items`} held here that can be counted.`,
  ];
  if (targets.kind === 'failed') {
    parts.push(
      'Their open exceptions could not be read, so the count will not be linked to them. The system still checks them after the count is posted.',
    );
  } else if (targets.kind === 'ready') {
    const k = targets.occurrenceIds.length;
    if (k > 0) {
      parts.push(
        `It will be linked to ${k === 1 ? 'one open exception' : `${k} open exceptions`} about these items.`,
      );
    }
    if (targets.truncated) {
      parts.push(
        'Some open exceptions may not be linked. The system still checks them after the count is posted.',
      );
    }
  }
  return parts.join(' ');
}
