'use client';

import { Loader2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setPoApprovalSettingsAction } from '@/server/actions/po-approval-settings';

/**
 * Editor for the org's PO approval threshold (spend governance). Renders only
 * for owner/admin; the server action re-gates. POs at/above the amount can
 * only be PLACED by an owner or admin — managers keep full draft/cancel
 * rights. 0 turns the gate off.
 *
 * Drawn as a titled card under the list (DESIGN-SPEC 6.7).
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
    <DetailSection
      title={
        <span className="inline-flex items-center gap-2">
          <ShieldCheck aria-hidden className="text-muted-foreground h-4 w-4" /> Approval threshold
        </span>
      }
    >
      <p className="text-muted-foreground max-w-3xl text-[13.5px] leading-[20.25px]">
        Purchase orders at or above this amount can only be{' '}
        <span className="text-foreground font-medium">placed</span> by an owner or admin. Managers
        can still draft and edit POs of any size — the gate is on committing the spend. Leave blank
        (or 0) to turn it off.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-2">
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
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </DetailSection>
  );
}
