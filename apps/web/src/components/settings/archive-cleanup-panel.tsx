'use client';

import { Loader2, Trash2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { SettingsPanel } from '@/components/settings/settings-nav';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { setAutoDeleteArchivedSettingsAction } from '@/server/actions/inventory-cleanup-settings';

const DAY_PRESETS = [30, 60, 90, 180, 365];

interface Props {
  initial: { enabled: boolean; days: number };
  /** How many items are currently archived (context for the impact note). */
  archivedCount: number;
  /** Per-window count of items ALREADY past that retention window — i.e. how
   *  many would be removed on the next run if you pick that number of days. */
  windowedCounts: Record<number, number>;
}

/**
 * Editor for the org's "auto-delete archived items" policy. Soft-delete only —
 * the copy makes clear deletions are recoverable + don't break history. The
 * server action re-gates on items:delete + the inventory module regardless.
 */
export function ArchiveCleanupPanel({ initial, archivedCount, windowedCounts }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [enabled, setEnabled] = React.useState(initial.enabled);
  const [days, setDays] = React.useState(initial.days);

  // Always include the current value so a non-preset stored value stays selectable.
  const dayOptions = React.useMemo(
    () => Array.from(new Set([...DAY_PRESETS, initial.days])).sort((a, b) => a - b),
    [initial.days],
  );

  // How many items are ALREADY past the selected window — what the next nightly
  // run would remove. Live as the dropdown changes (counts came from the server
  // for every selectable window).
  const dueNow = windowedCounts[days] ?? 0;

  async function save() {
    // Confirm before arming a sweep that would remove a backlog on the next run —
    // soft-delete is recoverable, but a silent overnight mass-removal is a nasty
    // surprise.
    if (enabled && dueNow > 0) {
      const ok = window.confirm(
        `${dueNow} item${dueNow === 1 ? '' : 's'} ${dueNow === 1 ? 'has' : 'have'} already been ` +
          `archived longer than ${days} days and will be removed on the next nightly run. ` +
          `They stay recoverable from Settings → Recovery. Continue?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    const r = await setAutoDeleteArchivedSettingsAction({ enabled, days });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Archived-item cleanup settings saved.');
    router.refresh();
  }

  return (
    <SettingsPanel
      title={
        <span className="flex items-center gap-2">
          <Trash2 aria-hidden className="text-muted-foreground h-4 w-4" /> Auto-delete archived
          items
        </span>
      }
      description={
        <>
          Automatically remove items that have stayed archived past a set time. Deleted items
          disappear from every list but are{' '}
          <span className="text-foreground font-medium">recoverable</span> from Settings → Recovery,
          and the history on past purchase orders and receipts is preserved.
        </>
      }
      bodyClassName="space-y-4"
    >
      <Checkbox
        checked={enabled}
        onCheckedChange={setEnabled}
        disabled={busy}
        className="text-[13.5px] font-medium"
      >
        Automatically delete archived items
      </Checkbox>

      {enabled && (
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="ac-days">Delete after an item has been archived for</Label>
          <select
            id="ac-days"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={busy}
            className="bg-card focus-visible:ring-ring focus-visible:ring-offset-background h-8 w-full rounded-md border border-[var(--ed-line-strong)] px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:text-base"
          >
            {dayOptions.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-[12.5px]">
            Checked once a day — only items archived longer than this are removed.{' '}
            {archivedCount > 0
              ? `You have ${archivedCount} archived item${archivedCount === 1 ? '' : 's'} in total.`
              : 'You have no archived items right now.'}
          </p>
          {dueNow > 0 ? (
            // The warning glyph is an icon now (no symbol characters in UI
            // copy); the words are unchanged and the icon is the non-colour cue.
            <p className="text-warning flex items-start gap-1.5 text-[12.5px] font-medium">
              <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                {dueNow} item{dueNow === 1 ? '' : 's'} {dueNow === 1 ? 'is' : 'are'} already past
                this window and would be removed on the next nightly run (recoverable from Settings
                → Recovery).
              </span>
            </p>
          ) : null}
        </div>
      )}

      <div>
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Save settings
        </Button>
      </div>
    </SettingsPanel>
  );
}
