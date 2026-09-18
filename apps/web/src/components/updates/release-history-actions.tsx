'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { capture } from '@/lib/analytics';
import { markAllRead, markReleaseRead } from '@/lib/updates/update-store';

import { TOUCH_TARGET } from './constants';

/**
 * "Mark all as read" is a BUTTON the person presses. Opening the history never
 * marks anything read by itself: a list of titles is not the same as having read
 * the releases, and silently clearing the dots would make them meaningless.
 */
export function MarkAllReadButton({ unreadCount }: { unreadCount: number }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  if (unreadCount === 0) return null;
  return (
    <div className="flex items-center gap-3">
      {failed ? (
        <p role="status" className="text-[12.5px] text-amber-700 dark:text-amber-400">
          That could not be saved. Try again.
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className={TOUCH_TARGET}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setFailed(false);
          const ok = await markAllRead();
          setPending(false);
          if (!ok) return setFailed(true);
          router.refresh();
        }}
      >
        {pending ? 'Saving…' : 'Mark all as read'}
      </Button>
    </div>
  );
}

/**
 * Records READ for a release opened by its own URL. Arriving here is an
 * intentional open and this only mounts once the release has rendered, which is
 * the documented rule for "read". The store posts through the same stable
 * /api/v1 route as the drawer, then tells the topbar dot and every other tab.
 */
export function MarkReleaseRead({
  releaseId,
  alreadyRead,
}: {
  releaseId: string;
  alreadyRead: boolean;
}) {
  const router = useRouter();
  const [failed, setFailed] = React.useState(false);
  // One view per release per visit. router.refresh() below re-renders this page
  // with alreadyRead = true, which re-runs the effect: without the guard every
  // FIRST read, the population being measured, was counted twice.
  const viewed = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (viewed.current !== releaseId) {
      viewed.current = releaseId;
      capture('release_details_viewed', { releaseId, entryPoint: 'page' });
    }
    if (alreadyRead) return;
    let cancelled = false;
    void markReleaseRead(releaseId).then((ok) => {
      if (cancelled) return;
      if (!ok) return setFailed(true);
      // This app keeps dynamic pages in the client router cache for 90 seconds
      // (staleTimes.dynamic), so pressing Back would show the history list as it
      // was BEFORE this read, "Unread" label and all. refresh() drops that cache.
      // It re-renders this page with alreadyRead = true, so this effect does not
      // run the write again.
      router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [releaseId, alreadyRead, router]);

  if (!failed) return null;
  return (
    <p
      role="status"
      className="mt-4 rounded-lg border border-amber-600/40 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-400"
    >
      We could not save that you read this, so it may show as unread again.
    </p>
  );
}
