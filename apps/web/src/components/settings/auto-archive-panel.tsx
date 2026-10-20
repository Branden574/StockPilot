'use client';

import { Archive, Loader2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { SettingsPanel } from '@/components/settings/settings-nav';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setAutoArchiveSettingsAction } from '@/server/actions/auto-archive-settings';

interface Props {
  initial: { enabled: boolean; dwellDays: number };
  /**
   * How many items are eligible for auto-archive RIGHT NOW under the saved
   * dwell window (server-computed via countEligibleForAutoArchive — the same
   * predicate the cron itself uses, so this can never overstate or understate
   * what actually happens next run). A snapshot as of page load; it does not
   * live-update as the dwell-days input below is edited before saving.
   */
  eligibleCount: number;
}

/**
 * Editor for the org's "auto-archive out-of-stock items" policy. Archiving is
 * reversible — restocking an auto-archived item brings it back — so the copy
 * and the server action's permission gate (items:update) are lighter than the
 * auto-delete-archived panel's (items:delete).
 */
export function AutoArchivePanel({ initial, eligibleCount }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [enabled, setEnabled] = React.useState(initial.enabled);
  const [dwellDays, setDwellDays] = React.useState(initial.dwellDays);

  async function save() {
    setError(null);
    setBusy(true);
    const r = await setAutoArchiveSettingsAction({ enabled, dwellDays });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    toast.success('Auto-archive settings saved.');
    router.refresh();
  }

  const warn = enabled && eligibleCount > 0;

  return (
    <SettingsPanel
      title={
        <span className="flex items-center gap-2">
          <Archive aria-hidden className="text-muted-foreground h-4 w-4" /> Auto-archive
          out-of-stock items
        </span>
      }
      description="Automatically archive items that stay out of stock. Restocking brings them back."
      bodyClassName="space-y-4"
    >
      <Checkbox
        checked={enabled}
        onCheckedChange={setEnabled}
        disabled={busy}
        className="text-[13.5px] font-medium"
      >
        Automatically archive out-of-stock items
      </Checkbox>

      {/* Amber when items would be archived on the next run; the icon is the
          cue that does not rely on colour. */}
      <p
        className={
          warn
            ? 'text-warning flex items-start gap-1.5 text-[13px] font-medium'
            : 'text-muted-foreground text-[13px]'
        }
      >
        {warn ? <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
        <span>
          {eligibleCount === 0 ? (
            'No items are currently eligible.'
          ) : enabled ? (
            <>
              <strong>{eligibleCount}</strong> {eligibleCount === 1 ? 'item is' : 'items are'}{' '}
              currently out of stock past the window and will be archived on the next daily run.
            </>
          ) : (
            <>
              <strong>{eligibleCount}</strong> {eligibleCount === 1 ? 'item' : 'items'} would be
              archived when you turn this on.
            </>
          )}
        </span>
      </p>

      {enabled && (
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="aa-dwell-days">Archive after an item has been out of stock for</Label>
          <div className="flex items-center gap-2">
            <Input
              id="aa-dwell-days"
              type="number"
              min={1}
              max={365}
              value={dwellDays}
              onChange={(e) => setDwellDays(Math.max(1, Number(e.target.value) || 1))}
              disabled={busy}
              className="w-24 font-mono tabular-nums"
            />
            <span className="text-muted-foreground text-[13px]">days</span>
          </div>
          <p className="text-muted-foreground text-[12.5px]">
            Checked once a day — only items that have been at zero stock longer than this are
            archived. Items with an open order reservation or rental checkout are skipped.
          </p>
        </div>
      )}

      {error ? <p className="text-destructive text-[13px]">{error}</p> : null}

      <div>
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Save settings
        </Button>
      </div>
    </SettingsPanel>
  );
}
