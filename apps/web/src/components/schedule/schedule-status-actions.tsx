'use client';

import { CheckCircle2, Loader2, Play, RotateCcw, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { updateScheduleEventAction } from '@/server/actions/schedule';

type Status = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

interface Props {
  eventId: string;
  currentStatus: Status;
}

/**
 * One-click status flips on the event detail page. Saves the user
 * having to open Edit → change dropdown → Save just to mark a job
 * complete. Buttons surface contextually:
 *
 *   scheduled    → Cancel, Start
 *   in_progress  → Cancel, Mark complete
 *   completed    → Reopen
 *   cancelled    → Reopen
 *
 * "Reopen" sets the status back to 'scheduled' so the event flows
 * through the normal lifecycle again.
 *
 * Start and Mark complete commit the work in front of you, so they are the
 * page's one ink-filled button (DESIGN-SPEC 6.2); Cancel and Reopen are
 * secondary. All sit in the page header's actions row at 32 px, after the
 * page's Edit, with the ink button last, as PageHeader orders its slots
 * (DESIGN-SPEC 6.1: secondary actions first, the commit action rightmost).
 */
export function ScheduleStatusActions({ eventId, currentStatus }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<Status | null>(null);

  async function flip(next: Status, label: string) {
    if (busy) return;
    setBusy(next);
    try {
      const res = await updateScheduleEventAction(eventId, { status: next });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success(label);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (currentStatus === 'scheduled') {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          onClick={() => flip('cancelled', 'Event cancelled.')}
        >
          {busy === 'cancelled' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          disabled={busy !== null}
          onClick={() => flip('in_progress', 'Event started.')}
        >
          {busy === 'in_progress' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Start
        </Button>
      </>
    );
  }

  if (currentStatus === 'in_progress') {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          onClick={() => flip('cancelled', 'Event cancelled.')}
        >
          {busy === 'cancelled' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          disabled={busy !== null}
          onClick={() => flip('completed', 'Event marked complete.')}
        >
          {busy === 'completed' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          Mark complete
        </Button>
      </>
    );
  }

  // completed | cancelled
  return (
    <Button
      type="button"
      variant="outline"
      disabled={busy !== null}
      onClick={() => flip('scheduled', 'Event reopened.')}
    >
      {busy === 'scheduled' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCcw className="h-3.5 w-3.5" />
      )}
      Reopen
    </Button>
  );
}
