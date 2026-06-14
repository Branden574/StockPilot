'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
 */
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="h-4 w-4" /> Automatic reordering
          </CardTitle>
          <CardDescription>
            Auto-create purchase orders when stock hits its reorder point.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            Automatic reordering is a <span className="font-medium text-foreground">Pro</span> feature.
            Upgrade to Pro or above to enable it.
          </p>
        </CardContent>
      </Card>
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="h-4 w-4" /> Automatic reordering
        </CardTitle>
        <CardDescription>
          Once a day, items at or below their reorder point are reordered automatically. Items
          already on an open PO are skipped, so it never double-orders.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={busy}
          />
          Enable automatic reordering
        </label>

        {enabled && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ar-mode">When stock is low</Label>
              <select
                id="ar-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'draft' | 'send')}
                disabled={busy}
                className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus:border-ring"
              >
                <option value="draft">Create a draft PO for review</option>
                <option value="send">Auto-send the PO to the supplier</option>
              </select>
              <p className="text-muted-foreground text-xs">
                Draft = someone reviews + sends. Auto-send still respects PO approval thresholds.
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
                <p className="text-muted-foreground text-xs">
                  A supplier PO above this is left as a draft instead of auto-sent.
                </p>
              </div>
            )}
          </div>
        )}

        <Button onClick={save} disabled={busy} size="sm">
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Save settings
        </Button>
      </CardContent>
    </Card>
  );
}
