'use client';

import { RefreshCw } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
 *
 * In the redesign it is the page header's secondary button (DESIGN-SPEC 6.2:
 * 32 px, outline), with its result under it, right-aligned beside the title
 * and left-aligned once the header wraps on a phone.
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
      <Button type="button" variant="outline" onClick={onClick} disabled={pending}>
        <RefreshCw aria-hidden />
        {pending ? 'Starting...' : 'Check now'}
      </Button>
      {message ? (
        <p
          role={message.failed ? 'alert' : 'status'}
          className={cn(
            'max-w-[320px] text-[12px] leading-[18px] sm:text-right',
            message.failed ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
