'use client';

import { Archive, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { setAutoArchiveSettingsAction } from '@/server/actions/auto-archive-settings';

interface Props {
  initial: { enabled: boolean; dwellDays: number };
}

/**
 * Editor for the org's "auto-archive out-of-stock items" policy. Archiving is
 * reversible — restocking an auto-archived item brings it back — so the copy
 * and the server action's permission gate (items:update) are lighter than the
 * auto-delete-archived panel's (items:delete).
 */
export function AutoArchivePanel({ initial }: Props) {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Archive className="h-4 w-4" /> Auto-archive out-of-stock items
        </CardTitle>
        <CardDescription>
          Automatically archive items that stay out of stock. Restocking brings them back.
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
          Automatically archive out-of-stock items
        </label>

        {enabled && (
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="aa-dwell-days">Archive after an item has been out of stock for</Label>
            <div className="flex items-center gap-2">
              <input
                id="aa-dwell-days"
                type="number"
                min={1}
                max={365}
                value={dwellDays}
                onChange={(e) => setDwellDays(Math.max(1, Number(e.target.value) || 1))}
                disabled={busy}
                className="border-input bg-background focus:border-ring h-9 w-24 rounded-md border px-2.5 text-sm outline-none"
              />
              <span className="text-muted-foreground text-sm">days</span>
            </div>
            <p className="text-muted-foreground text-xs">
              Checked once a day — only items that have been at zero stock longer than this are
              archived. Items with an open order reservation or rental checkout are skipped.
            </p>
          </div>
        )}

        {error ? <p className="text-destructive text-sm">{error}</p> : null}

        <Button onClick={save} disabled={busy} size="sm">
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Save settings
        </Button>
      </CardContent>
    </Card>
  );
}
