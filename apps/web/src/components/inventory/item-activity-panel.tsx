'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { ActivityFeed } from '@/components/inventory/activity-feed';
import { Button } from '@/components/ui/button';
import { mergeOlderActivityEvents, nextActivityCursor } from '@/lib/activity-pagination';
import { loadOlderItemActivityAction } from '@/server/actions/activity';

import type { ActivityEvent } from '@/server/services/activity';

interface ItemActivityPanelProps {
  itemId: string;
  /**
   * The first, server-rendered page — already filtered to this tab's kind
   * by the caller (movement-only for the Movements tab, the full merged
   * feed for the Activity tab).
   */
  initialEvents: ActivityEvent[];
  initialLocationNames: Record<string, string>;
  /**
   * `nextActivityCursor` applied to the FULL first page (both kinds, not
   * the display-filtered `initialEvents`) — item-detail computes this once
   * from the same `activity` array it derives both tabs from. `null` means
   * the first page already returned nothing, so there's nothing to page
   * through.
   */
  initialCursor: string | null;
  /** Whether the first page already hit BOTH per-kind caps (see the
   * server action's `exhausted` doc) — hides the button from the very
   * first render when there's nothing more to load. */
  initialExhausted: boolean;
  /**
   * When set, only events of this kind are kept after each append — the
   * Movements tab wants movement-only display even though every fetch
   * (first page and "Load older") returns the full merged feed under the
   * hood. The Activity tab omits this and keeps everything.
   */
  kindFilter?: 'movement';
}

export function ItemActivityPanel({
  itemId,
  initialEvents,
  initialLocationNames,
  initialCursor,
  initialExhausted,
  kindFilter,
}: ItemActivityPanelProps) {
  const [events, setEvents] = React.useState<ActivityEvent[]>(initialEvents);
  const [locationNames, setLocationNames] = React.useState(initialLocationNames);
  const [cursor, setCursor] = React.useState<string | null>(initialCursor);
  const [exhausted, setExhausted] = React.useState(initialExhausted || initialCursor === null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function loadOlder() {
    if (!cursor) {
      setExhausted(true);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await loadOlderItemActivityAction({ itemId, before: cursor });
    setLoading(false);
    if (!res.ok) {
      setError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    const page = res.data.events;
    const display = kindFilter ? page.filter((e) => e.kind === kindFilter) : page;
    setEvents((prev) => mergeOlderActivityEvents(prev, display));
    setLocationNames((prev) => ({ ...prev, ...res.data.locationNames }));
    // Cursor advances from the FULL fetched page (both kinds), never the
    // display-filtered subset — otherwise a Movements-tab fetch would never
    // advance past whatever audit rows happened to sit between movements.
    setCursor(nextActivityCursor(page));
    setExhausted(res.data.exhausted);
  }

  return (
    <>
      <ActivityFeed events={events} locationNames={locationNames} />
      {!exhausted && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadOlder()}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load older'}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive mt-2 text-center text-xs">
          {error}
        </p>
      )}
    </>
  );
}
