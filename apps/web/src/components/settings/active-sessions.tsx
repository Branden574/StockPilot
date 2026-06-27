'use client';

import { Loader2, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  revokeOtherSessionsAction,
  revokeSessionAction,
} from '@/server/actions/sessions';
import type { SessionInfo } from '@/server/services/sessions';

function formatLastActive(iso: string | null): string {
  if (!iso) return 'unknown';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export function ActiveSessions({ sessions }: { sessions: SessionInfo[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const others = sessions.filter((s) => !s.isCurrent);

  async function signOut(id: string) {
    setBusyId(id);
    const res = await revokeSessionAction({ sessionId: id });
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Signed out of that device.');
    router.refresh();
  }

  async function signOutOthers() {
    setBusyId('others');
    const res = await revokeOtherSessionsAction();
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Signed out of all other devices.');
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <ul className="divide-border divide-y rounded-md border">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-3">
            <MonitorSmartphone className="text-muted-foreground h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{s.label}</span>
                {s.isMfa && (
                  <ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--accent))]" aria-label="MFA verified" />
                )}
                {s.isCurrent && (
                  <span className="rounded-full bg-[hsl(var(--accent)/0.12)] px-2 py-0.5 text-[10.5px] font-medium text-[hsl(var(--accent))]">
                    This device
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-xs">
                {s.ip ?? 'unknown IP'} · active {formatLastActive(s.lastActiveAt)}
              </div>
            </div>
            {!s.isCurrent && (
              <Button
                variant="outline"
                size="sm"
                disabled={busyId === s.id}
                onClick={() => signOut(s.id)}
              >
                {busyId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Sign out'}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {others.length > 0 && (
        <Button variant="outline" size="sm" disabled={busyId === 'others'} onClick={signOutOthers}>
          {busyId === 'others' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            'Sign out all other devices'
          )}
        </Button>
      )}
      <p className="text-muted-foreground text-xs">
        Signing out takes effect immediately on devices that are online; a device
        that&apos;s offline is signed out within the hour.
      </p>
    </div>
  );
}
