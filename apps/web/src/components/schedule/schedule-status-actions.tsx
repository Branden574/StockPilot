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
 *   scheduled    → Start, Cancel
 *   in_progress  → Mark complete, Cancel
 *   completed    → Reopen
 *   cancelled    → Reopen
 *
 * "Reopen" sets the status back to 'scheduled' so the event flows
 * through the normal lifecycle again.
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
          variant="gradient"
          size="sm"
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
        <Button
          type="button"
          variant="outline"
          size="sm"
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
      </>
    );
  }

  if (currentStatus === 'in_progress') {
    return (
      <>
        <Button
          type="button"
          variant="gradient"
          size="sm"
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
        <Button
          type="button"
          variant="outline"
          size="sm"
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
      </>
    );
  }

  // completed | cancelled
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
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
