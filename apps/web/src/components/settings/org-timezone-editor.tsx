'use client';

import { Loader2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ORG_TIMEZONE_OPTIONS, type OrgTimezoneOption } from '@/lib/timezone-options';
import { updateOrgTimezoneAction } from '@/server/actions/organization';

import { isStorableOrgTimezone, resolveOrgTimezone, zoneOffsetMs } from '@stockpilot/core';

type Timezone = OrgTimezoneOption;

/**
 * Human-readable labels for the curated timezone list. Order matches
 * the allow-list in the server action so the dropdown reads top-to-
 * bottom from common US zones outward.
 */
const LABELS: Record<Timezone, string> = {
  UTC: 'UTC (no offset)',
  'America/New_York': 'Eastern Time — New York',
  'America/Chicago': 'Central Time — Chicago',
  'America/Denver': 'Mountain Time — Denver',
  'America/Phoenix': 'Mountain (no DST) — Phoenix',
  'America/Los_Angeles': 'Pacific Time — Los Angeles',
  'America/Anchorage': 'Alaska — Anchorage',
  'Pacific/Honolulu': 'Hawaii — Honolulu',
  'America/Toronto': 'Eastern Canada — Toronto',
  'America/Vancouver': 'Pacific Canada — Vancouver',
  'America/Mexico_City': 'Central — Mexico City',
  'Europe/London': 'UK — London',
  'Europe/Paris': 'Central Europe — Paris',
  'Europe/Berlin': 'Central Europe — Berlin',
  'Europe/Madrid': 'Central Europe — Madrid',
  'Asia/Tokyo': 'Japan — Tokyo',
  'Asia/Singapore': 'Singapore',
  'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Manila': 'Philippines — Manila',
  'Australia/Sydney': 'Eastern Australia — Sydney',
};

function isListed(zone: string): zone is Timezone {
  return (ORG_TIMEZONE_OPTIONS as readonly string[]).includes(zone);
}

/** "UTC−05:00": how far `zone` is from UTC right now; '' when this browser
 *  cannot tell. */
function utcOffset(zone: string): string {
  try {
    const minutes = Math.round(zoneOffsetMs(Date.now(), zone) / 60_000);
    const abs = Math.abs(minutes);
    const hours = String(Math.floor(abs / 60)).padStart(2, '0');
    return `UTC${minutes < 0 ? '−' : '+'}${hours}:${String(abs % 60).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/** A listed zone's label, else the zone's name and its offset now. */
function labelFor(zone: string): string {
  if (isListed(zone)) return LABELS[zone];
  const offset = utcOffset(zone);
  return offset ? `${zone} (${offset})` : zone;
}

/**
 * Helper to render a tiny "what time is it there right now" preview
 * next to each option so the user can sanity-check their pick. Pulls
 * from the browser clock formatted in the target tz.
 */
function nowInTimezone(tz: string): string {
  try {
    return new Date().toLocaleTimeString('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

/**
 * What the editor shows for the stored zone (B41). It used to show "UTC (no
 * offset)" for any stored zone outside the list, while everything else in the
 * app used the stored zone (core resolveOrgTimezone), and with UTC as its
 * starting value, choosing UTC left Save disabled. The create forms store the
 * creator's browser zone, so such zones exist.
 *
 *   - `shown`: the zone the app uses for the stored value, selected. A zone
 *     outside the list is offered as one extra option while it is stored.
 *   - `stored`: the stored zone when the app and the reports both use it as
 *     it is, else null, so choosing any listed zone is a change worth saving.
 *   - `notice`: why a stored value that is not a usable zone name is replaced.
 */
function storedZoneView(current: string | null): {
  shown: string;
  stored: string | null;
  notice: string | null;
} {
  if (current === null) {
    // The page's read of the organization row failed: the stored zone is
    // unknown. Show the zone the app uses when it has none, and invite no
    // save of a value nobody chose.
    const fallback = resolveOrgTimezone(null);
    return { shown: fallback, stored: fallback, notice: null };
  }
  const raw = current.trim();
  if (isListed(raw) || isStorableOrgTimezone(raw)) return { shown: raw, stored: raw, notice: null };
  const used = resolveOrgTimezone(raw);
  if (used === raw) {
    // Intl takes it, so the web and the phone use it, but the Book Order
    // Totals report's SQL tries only UTC, GMT or an Area/Location name and
    // uses Pacific instead (0379, 0382).
    return {
      shown: raw,
      stored: null,
      notice: `Your workspace's saved time zone, ${raw}, is not a full time zone name such as America/Chicago, so the Book Order Totals report uses Pacific Time. Choose one and save.`,
    };
  }
  // No zone at all: the app and the report both use core's default, Pacific.
  return {
    shown: used,
    stored: null,
    notice: raw
      ? `Your workspace's saved time zone, ${raw}, is not a time zone name, so the app uses Pacific Time. Choose one and save.`
      : "Your workspace's saved time zone is not a time zone name, so the app uses Pacific Time. Choose one and save.",
  };
}

export function OrgTimezoneEditor({ current }: { current: string | null }) {
  const router = useRouter();
  const view = React.useMemo(() => storedZoneView(current), [current]);
  const [tz, setTz] = React.useState<string>(view.shown);
  const [busy, setBusy] = React.useState(false);
  // Measured against the stored zone, not the zone shown in its place, and
  // only a listed zone can be saved (the server action takes the list alone).
  const dirty = tz !== view.stored && isListed(tz);
  // The stored zone, when it is not in the list, leads the options; it goes
  // away once a listed zone is saved, so the list stays the only choice.
  const options: readonly string[] = isListed(view.shown)
    ? ORG_TIMEZONE_OPTIONS
    : [view.shown, ...ORG_TIMEZONE_OPTIONS];

  async function save() {
    if (!dirty) return;
    setBusy(true);
    const r = await updateOrgTimezoneAction({ timezone: tz });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success(`Timezone set to ${labelFor(tz)}.`);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="org-timezone">Workspace timezone</Label>
        <Select value={tz} onValueChange={setTz}>
          <SelectTrigger id="org-timezone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                <span className="inline-flex items-center gap-2">
                  <span>{labelFor(opt)}</span>
                  <span className="text-muted-foreground text-[11px] tabular-nums">
                    {nowInTimezone(opt)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {view.notice ? (
          <p className="text-warning flex items-start gap-1.5 text-[12.5px]">
            <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{view.notice}</span>
          </p>
        ) : null}
        <p className="text-muted-foreground text-[12px]">
          Used everywhere the system renders a date or time — PDFs (pick slips, packing slips,
          reports), the schedule calendar, dashboard timestamps, and emails. Set this to where your
          warehouse operates, not where each user lives.
        </p>
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || busy} variant="gradient">
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Save timezone
        </Button>
      </div>
    </div>
  );
}
