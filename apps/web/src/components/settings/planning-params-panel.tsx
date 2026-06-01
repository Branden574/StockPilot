'use client';

import { Loader2, Settings2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setPlanningParamsAction } from '@/server/actions/planning-settings';

interface PlanningParams {
  leadTimeDays: number;
  safetyMultiplier: number;
  velocityWindowDays: number;
}

/**
 * Editor for the org's demand-planning parameters (lead time, safety
 * multiplier, velocity window). Renders only for owner/admin; the server
 * action re-gates. Saving re-runs the server suggestions (router.refresh) so
 * the table reflects the new parameters immediately.
 */
export function PlanningParamsPanel({ initial }: { initial: PlanningParams }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [leadTimeDays, setLeadTimeDays] = React.useState(String(initial.leadTimeDays));
  const [safetyMultiplier, setSafetyMultiplier] = React.useState(String(initial.safetyMultiplier));
  const [velocityWindowDays, setVelocityWindowDays] = React.useState(
    String(initial.velocityWindowDays),
  );

  async function save() {
    const params = {
      leadTimeDays: Number(leadTimeDays),
      safetyMultiplier: Number(safetyMultiplier),
      velocityWindowDays: Number(velocityWindowDays),
    };
    if (
      !Number.isFinite(params.leadTimeDays) ||
      !Number.isFinite(params.safetyMultiplier) ||
      !Number.isFinite(params.velocityWindowDays)
    ) {
      toast.error('Enter valid numbers for every field.');
      return;
    }
    setBusy(true);
    const r = await setPlanningParamsAction(params);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Planning settings saved. Suggestions recomputed.');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 className="h-4 w-4" /> Planning settings
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="leadTimeDays">Lead time (days)</Label>
          <Input
            id="leadTimeDays"
            type="number"
            min={1}
            max={180}
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.target.value)}
            disabled={busy}
          />
          <p className="text-muted-foreground text-xs">PO placement → stock on shelf.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="safetyMultiplier">Safety multiplier</Label>
          <Input
            id="safetyMultiplier"
            type="number"
            min={1}
            max={3}
            step={0.1}
            value={safetyMultiplier}
            onChange={(e) => setSafetyMultiplier(e.target.value)}
            disabled={busy}
          />
          <p className="text-muted-foreground text-xs">Buffer on lead-time demand (1.5 = +50%).</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="velocityWindowDays">Velocity window (days)</Label>
          <Input
            id="velocityWindowDays"
            type="number"
            min={14}
            max={365}
            value={velocityWindowDays}
            onChange={(e) => setVelocityWindowDays(e.target.value)}
            disabled={busy}
          />
          <p className="text-muted-foreground text-xs">Lookback for the demand rate.</p>
        </div>
        <div className="sm:col-span-3">
          <Button onClick={save} disabled={busy} size="sm">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
