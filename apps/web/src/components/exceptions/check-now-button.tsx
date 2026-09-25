'use client';

import { RefreshCw } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { requestExceptionCheckAction } from '@/server/actions/exceptions';

import { exceptionCheckNowCopy } from '@stockpilot/core';

/**
 * A manager's "Check now" (F1-1, owner decision Q9). It SCHEDULES a check to
 * run on the server after the answer comes back and returns at once: nothing
 * waits for the check, and this page does not reload itself. The result
 * shows as a new "Checked at" the next time the page loads.
 *
 * The outcome is written inline (role="status", or role="alert" on a failure)
 * rather than only as a toast, which a reader watching the button can miss
 * (recurring pattern #20).
 */
export function CheckNowButton() {
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<{ text: string; failed: boolean } | null>(null);

  function onClick() {
    setMessage(null);
    startTransition(async () => {
      const res = await requestExceptionCheckAction();
      if ('error' in res) {
        setMessage({ text: res.error.message, failed: true });
        return;
      }
      // Core words it, so the web and the phone say the same thing. The
      // server allows one check per org a minute (a claim shared by every
      // manager and both surfaces), so a second click says so.
      setMessage({ text: exceptionCheckNowCopy(res), failed: false });
    });
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={pending}>
        <RefreshCw className="mr-1.5 size-3.5" aria-hidden />
        {pending ? 'Starting...' : 'Check now'}
      </Button>
      {message ? (
        <p
          role={message.failed ? 'alert' : 'status'}
          className={message.failed ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
