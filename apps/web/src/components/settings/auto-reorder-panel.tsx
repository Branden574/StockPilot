'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  setAutoReorderSettingsAction,
  type AutoReorderSettingsInput,
} from '@/server/actions/auto-reorder-settings';

interface Props {
  initial: { enabled: boolean; mode: 'draft' | 'send'; maxAutoSendCents: number | null };
  /** Whether the org's effective plan (Pro+) entitles it to auto-reorder. */
  entitled: boolean;
}

/**
 * Editor for the org's automatic-reordering settings. Free-tier orgs see an
 * upgrade notice instead of the controls; the server action re-gates on the
 * effective plan + purchase_orders:manage regardless.
 *
 * Drawn as a titled card under the suggestions table (DESIGN-SPEC 6.7). The
 * enable box is the shared checkbox with its words inside it (one control, as
 * the label around the native box was); it is saved with "Save settings".
 */

/** The panel's title, with its icon. */
const TITLE = (
  <span className="inline-flex items-center gap-2">
    <RefreshCw aria-hidden className="text-muted-foreground h-4 w-4" /> Automatic reordering
  </span>
);

/** The native select drawn as the shared Input (DESIGN-SPEC 6.3). */
const SELECT =
  'bg-card flex h-8 w-full rounded-md border border-[var(--ed-line-strong)] px-2.5 text-[13px] transition-colors focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:text-base';
export function AutoReorderPanel({ initial, entitled }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [enabled, setEnabled] = React.useState(initial.enabled);
  const [mode, setMode] = React.useState<'draft' | 'send'>(initial.mode);
  const [capDollars, setCapDollars] = React.useState(
    initial.maxAutoSendCents != null ? (initial.maxAutoSendCents / 100).toFixed(2) : '',
  );

  if (!entitled) {
    return (
      <DetailSection data-slot="auto-reorder" title={TITLE}>
        <p className="text-muted-foreground mb-4 text-[13.5px] leading-[20.25px]">
          Auto-create purchase orders when stock hits its reorder point.
        </p>
        <p className="border-border bg-sunk text-muted-foreground rounded-md border p-4 text-[13.5px] leading-[20.25px]">
          Automatic reordering is a <span className="text-foreground font-medium">Pro</span>{' '}
          feature. Upgrade to Pro or above to enable it.
        </p>
      </DetailSection>
    );
  }

  async function save() {
    const payload: AutoReorderSettingsInput = {
      enabled,
      mode,
      maxAutoSendCents:
        mode === 'send' && capDollars.trim() !== ''
          ? Math.round(parseFloat(capDollars) * 100)
          : null,
    };
    if (payload.maxAutoSendCents != null && !Number.isFinite(payload.maxAutoSendCents)) {
      toast.error('Enter a valid auto-send cap, or leave it blank.');
      return;
    }
    setBusy(true);
    const r = await setAutoReorderSettingsAction(payload);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Auto-reorder settings saved.');
    router.refresh();
  }

  return (
    <DetailSection data-slot="auto-reorder" title={TITLE} bodyClassName="space-y-4">
      <p className="text-muted-foreground text-[13.5px] leading-[20.25px]">
        Once a day, items at or below their reorder point are reordered automatically. Items already
        on an open PO are skipped, so it never double-orders.
      </p>
      <div>
        <Checkbox
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={busy}
          className="text-foreground font-medium"
        >
          Enable automatic reordering
        </Checkbox>
      </div>

      {enabled && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ar-mode">When stock is low</Label>
            <select
              id="ar-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'draft' | 'send')}
              disabled={busy}
              className={SELECT}
            >
              <option value="draft">Create a draft PO for review</option>
              <option value="send">Auto-send the PO to the supplier</option>
            </select>
            <p className="text-muted-foreground text-[12px] leading-[18px]">
              Draft = someone reviews + sends. Auto-send still respects PO approval thresholds — and
              a PO is only auto-sent when it&apos;s under a cap or your approval threshold; without
              either ceiling it&apos;s drafted for review instead.
            </p>
          </div>
          {mode === 'send' && (
            <div className="space-y-1.5">
              <Label htmlFor="ar-cap">Auto-send cap ($, optional)</Label>
              <Input
                id="ar-cap"
                type="number"
                min={0}
                step="0.01"
                placeholder="e.g. 2000.00"
                value={capDollars}
                onChange={(e) => setCapDollars(e.target.value)}
                disabled={busy}
              />
              <p className="text-muted-foreground text-[12px] leading-[18px]">
                A supplier PO above this is left as a draft instead of auto-sent.
              </p>
            </div>
          )}
        </div>
      )}

      <div>
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save settings
        </Button>
      </div>
    </DetailSection>
  );
}
