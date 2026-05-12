'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { markShipmentDeliveredAction } from '@/server/actions/shipments';

function todayLocalIsoDate(): string {
  // <input type="date"> wants YYYY-MM-DD in the user's local TZ.
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function MarkDeliveredDialog({
  shipmentId,
  defaultReceiverName,
}: {
  shipmentId: string;
  /** Pre-fills the receiver field — typically the attention_to_name on
   * the shipment so the manager doesn't have to re-type it. */
  defaultReceiverName?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [receiverName, setReceiverName] = React.useState(defaultReceiverName ?? '');
  const [deliveredAt, setDeliveredAt] = React.useState(todayLocalIsoDate());

  // Reset on open so a re-opened dialog after a previous submit starts
  // with today's date and the canonical attention-to fallback.
  React.useEffect(() => {
    if (open) {
      setReceiverName(defaultReceiverName ?? '');
      setDeliveredAt(todayLocalIsoDate());
    }
  }, [open, defaultReceiverName]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = receiverName.trim();
    if (!trimmed) {
      toast.error('Receiver name is required.');
      return;
    }
    setBusy(true);
    // <input type="date"> gives YYYY-MM-DD; convert to midnight-local ISO
    // for the service. The service parses with `new Date(...)` which
    // treats YYYY-MM-DD as UTC; that's close enough for a date-only
    // field and matches how ship_date is handled elsewhere.
    const res = await markShipmentDeliveredAction({
      id: shipmentId,
      receiverName: trimmed,
      deliveredAt,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setOpen(false);
    toast.success('Shipment marked as delivered.');
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default">
          <CheckCircle2 className="h-4 w-4" /> Mark delivered
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark shipment as delivered</DialogTitle>
          <DialogDescription>
            Use this when a paper-signed slip comes back from the field. The
            shipment will move to delivered and the printed packing slip will
            show the receiver name + date for your records.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="md-receiver">Received by</Label>
            <Input
              id="md-receiver"
              value={receiverName}
              onChange={(e) => setReceiverName(e.target.value)}
              placeholder="Name as signed"
              autoFocus
              required
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="md-date">Delivered on</Label>
            <Input
              id="md-date"
              type="date"
              value={deliveredAt}
              onChange={(e) => setDeliveredAt(e.target.value)}
              required
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Mark delivered
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
