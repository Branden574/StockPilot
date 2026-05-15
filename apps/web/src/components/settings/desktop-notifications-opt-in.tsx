'use client';

import { Bell, BellOff, Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  isDesktopNotificationsEnabled,
  setDesktopOptIn,
} from '@/lib/notifications/live-toast';

type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

/**
 * Per-device opt-in for desktop / OS-level notifications. When the
 * user enables this here:
 *   1. We request `Notification.requestPermission()` (must be inside
 *      this click handler — browsers reject programmatic prompts).
 *   2. On grant, we set the `stockpilot:desktop-notifications-opt-in`
 *      localStorage flag. The realtime bell subscription reads both
 *      `Notification.permission === 'granted'` AND that flag, so the
 *      user can revoke from the app without touching browser settings.
 *
 * If the browser permission has already been DENIED, we can't recover
 * silently — Chrome/Safari/Firefox all gate re-prompts behind their
 * own site settings UI. We surface a clear "open browser settings"
 * instruction in that state instead of an enable button that won't
 * work.
 */
export function DesktopNotificationsOptIn() {
  const [perm, setPerm] = React.useState<PermissionState>('unsupported');
  const [optIn, setOptIn] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (typeof Notification === 'undefined') {
      setPerm('unsupported');
      return;
    }
    setPerm(Notification.permission as PermissionState);
    setOptIn(isDesktopNotificationsEnabled());
  }, []);

  async function enable() {
    if (typeof Notification === 'undefined') return;
    setPending(true);
    try {
      const result = await Notification.requestPermission();
      setPerm(result as PermissionState);
      if (result === 'granted') {
        setDesktopOptIn(true);
        setOptIn(true);
        // Friendly confirmation that fires a real notification so the
        // user sees what to expect later.
        try {
          new Notification('Desktop notifications enabled', {
            body: 'StockPilot will surface new updates here when this tab is in the background.',
          });
        } catch {
          /* benign */
        }
        toast.success('Desktop notifications enabled.');
      } else if (result === 'denied') {
        toast.error(
          'Your browser blocked the permission. Open the lock icon in the address bar to allow notifications, then come back.',
        );
      }
    } finally {
      setPending(false);
    }
  }

  function disable() {
    setDesktopOptIn(false);
    setOptIn(false);
    toast.success('Desktop notifications paused for this device.');
  }

  if (perm === 'unsupported') {
    return (
      <div className="text-muted-foreground text-sm">
        This browser doesn&apos;t support desktop notifications.
      </div>
    );
  }

  if (perm === 'denied') {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          Your browser is blocking notifications for StockPilot. Open the
          lock / shield icon next to the URL, allow notifications, and
          reload this page.
        </p>
      </div>
    );
  }

  if (optIn) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="text-sm">
          <p className="font-medium">Enabled on this device</p>
          <p className="text-muted-foreground text-xs">
            New notifications pop up while this tab is in the background.
            We won&apos;t disturb you while the StockPilot tab is in focus —
            you&apos;ll see a toast instead.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={disable} disabled={pending}>
          <BellOff className="mr-1 h-3.5 w-3.5" /> Pause
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-sm">
        <p className="font-medium">Off on this device</p>
        <p className="text-muted-foreground text-xs">
          When StockPilot isn&apos;t the focused tab, new notifications
          stay in the bell. Enable to also see an OS-level pop-up.
        </p>
      </div>
      <Button onClick={enable} disabled={pending} size="sm">
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <>
            <Bell className="mr-1 h-3.5 w-3.5" /> Enable
          </>
        )}
      </Button>
    </div>
  );
}
