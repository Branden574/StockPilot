'use client';

import { Loader2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setPoApprovalSettingsAction } from '@/server/actions/po-approval-settings';

/**
 * Editor for the org's PO approval threshold (spend governance). Renders only
 * for owner/admin; the server action re-gates. POs at/above the amount can
 * only be PLACED by an owner or admin — managers keep full draft/cancel
 * rights. 0 turns the gate off.
 */
export function PoApprovalPanel({ initialAmount }: { initialAmount: number }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [amount, setAmount] = React.useState(initialAmount > 0 ? String(initialAmount) : '');

  async function save() {
    const value = amount.trim() === '' ? 0 : Number(amount);
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Enter a dollar amount (or leave blank to turn the gate off).');
      return;
    }
    setBusy(true);
    const r = await setPoApprovalSettingsAction({ approvalThresholdAmount: value });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success(
      value > 0
        ? `POs of $${value.toLocaleString()} or more now require an owner or admin to place.`
        : 'PO approval threshold turned off.',
    );
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" /> Approval threshold
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Purchase orders at or above this amount can only be <span className="text-foreground font-medium">placed</span>{' '}
          by an owner or admin. Managers can still draft and edit POs of any size — the gate is on
          committing the spend. Leave blank (or 0) to turn it off.
        </p>
        <div className="flex items-end gap-2">
          <div className="w-44 space-y-1.5">
            <Label htmlFor="poApprovalThreshold">Threshold ($)</Label>
            <Input
              id="poApprovalThreshold"
              type="number"
              min={0}
              step="0.01"
              placeholder="Off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button onClick={save} disabled={busy} size="sm">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
