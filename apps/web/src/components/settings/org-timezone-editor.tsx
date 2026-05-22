'use client';

import { Loader2 } from 'lucide-react';
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
import {
  ORG_TIMEZONE_OPTIONS,
  updateOrgTimezoneAction,
} from '@/server/actions/organization';

type Timezone = (typeof ORG_TIMEZONE_OPTIONS)[number];

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

/**
 * Helper to render a tiny "what time is it there right now" preview
 * next to each option so the user can sanity-check their pick. Pulls
 * from the browser clock formatted in the target tz.
 */
function nowInTimezone(tz: Timezone): string {
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

export function OrgTimezoneEditor({ current }: { current: string | null }) {
  const router = useRouter();
  const initial = (
    current && (ORG_TIMEZONE_OPTIONS as readonly string[]).includes(current)
      ? current
      : 'UTC'
  ) as Timezone;
  const [tz, setTz] = React.useState<Timezone>(initial);
  const [busy, setBusy] = React.useState(false);
  const dirty = tz !== initial;

  async function save() {
    if (!dirty) return;
    setBusy(true);
    const r = await updateOrgTimezoneAction({ timezone: tz });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success(`Timezone set to ${LABELS[tz]}.`);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="org-timezone">Workspace timezone</Label>
        <Select
          value={tz}
          onValueChange={(v) => setTz(v as Timezone)}
        >
          <SelectTrigger id="org-timezone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ORG_TIMEZONE_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt}>
                <span className="inline-flex items-center gap-2">
                  <span>{LABELS[opt]}</span>
                  <span className="text-muted-foreground text-[11px] tabular-nums">
                    {nowInTimezone(opt)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-[11px]">
          Used everywhere the system renders a date or time —
          PDFs (pick slips, packing slips, reports), the schedule
          calendar, dashboard timestamps, and emails. Set this to where
          your warehouse operates, not where each user lives.
        </p>
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || busy} variant="gradient">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save timezone'}
        </Button>
      </div>
    </div>
  );
}
