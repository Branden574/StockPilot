'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { LocalDateTime } from '@/components/ui/local-datetime';
import { signInAlertBadges, signInAlertPlaceWords } from '@/lib/auth/sign-in-alert-words';
import {
  confirmSignInAlertAction,
  reportSignInAlertAction,
} from '@/server/actions/sign-in-alerts';
import type { MySignInAlert } from '@/server/services/sign-in-alerts';

/**
 * A member's own sign-in alerts on Settings > Security (part 3 of the
 * security tools), shown by Active sessions: on the session the sign-in made,
 * and, for alerts whose session has ended, in "Recent sign-in alerts" under
 * the list (the last 30 days, my_sign_in_alerts()).
 *
 * While an alert is open the member can say "This was me" or "This was not
 * me". After "This was me" the alert can still be reported. "This was not me"
 * asks once more, because it signs out every session of the account, this
 * one too; then the browser goes to reset the password (a full page load:
 * this session's cookies are gone).
 */

/** Where the page goes after a report. A seam for tests; a full load in the browser. */
export const leaveAfterReport: { go: (path: string) => void } = {
  go: (path) => window.location.assign(path),
};

function AlertBadges({ alert }: { alert: MySignInAlert }) {
  return (
    <>
      {signInAlertBadges({
        newDevice: alert.newDevice,
        newCountry: alert.newCountry,
        country: alert.country,
      }).map((words) => (
        <Badge key={words} variant="warning" className="shrink-0">
          {words}
        </Badge>
      ))}
    </>
  );
}

function AnswerButtons({ alert }: { alert: MySignInAlert }) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [reporting, setReporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function wasMe() {
    setConfirming(true);
    const res = await confirmSignInAlertAction({ alertId: alert.id });
    setConfirming(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Thanks. We marked this sign-in as yours.');
    router.refresh();
  }

  async function notMe() {
    setError(null);
    setReporting(true);
    const res = await reportSignInAlertAction({ alertId: alert.id });
    if (!res.ok) {
      setReporting(false);
      setError(res.error.message);
      return;
    }
    leaveAfterReport.go('/reset');
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {alert.status === 'open' && (
        <Button variant="outline" size="sm" disabled={confirming || reporting} onClick={() => void wasMe()}>
          {confirming ? <Loader2 aria-hidden className="animate-spin" /> : null}
          This was me
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        className="text-destructive"
        disabled={confirming || reporting}
        onClick={() => {
          setError(null);
          setAsking(true);
        }}
      >
        This was not me
      </Button>
      <DestructiveConfirm
        open={asking}
        onOpenChange={(open) => {
          if (!reporting) setAsking(open);
        }}
        title="Sign out everywhere?"
        description="This signs you out on every device, this one too. Then reset your password, so whoever signed in cannot sign in again. The owners and admins of your organization are told."
        confirmLabel="Sign me out everywhere"
        pending={reporting}
        error={error}
        onConfirm={() => void notMe()}
      />
    </div>
  );
}

/** The alert of one active session: what was new and, while it is open, the two answers. */
export function SignInAlertOnSession({ alert }: { alert: MySignInAlert }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <AlertBadges alert={alert} />
      </div>
      {alert.status === 'open' ? (
        <AnswerButtons alert={alert} />
      ) : (
        <p className="text-muted-foreground text-[12.5px]">You said this was you.</p>
      )}
    </div>
  );
}

/** Alerts whose session has ended (or was never known), last 30 days, newest first. */
export function RecentSignInAlerts({ alerts }: { alerts: MySignInAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <section aria-labelledby="recent-sign-in-alerts-heading" className="space-y-2 pt-2">
      <h3 id="recent-sign-in-alerts-heading" className="text-[13.5px] font-medium">
        Recent sign-in alerts
      </h3>
      <p className="text-muted-foreground text-[12.5px]">
        The last 30 days. These sign-ins no longer have an active session.
      </p>
      <ul className="divide-border divide-y rounded-lg border">
        {alerts.map((alert) => {
          const place = signInAlertPlaceWords(alert.country, alert.city);
          return (
            <li key={alert.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
                <span>{alert.deviceLabel}</span>
                <AlertBadges alert={alert} />
              </div>
              <div className="text-muted-foreground text-[12.5px]">
                {place ? `${place} (approximate) · ` : ''}
                <LocalDateTime iso={alert.createdAt} />
              </div>
              {alert.status === 'not_me' ? (
                <p className="text-muted-foreground text-[12.5px]">You reported this sign-in.</p>
              ) : (
                <>
                  {alert.status === 'was_me' && (
                    <p className="text-muted-foreground text-[12.5px]">You said this was you.</p>
                  )}
                  <AnswerButtons alert={alert} />
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
