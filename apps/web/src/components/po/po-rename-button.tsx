'use client';

import { Loader2, Pencil } from 'lucide-react';
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
import { renamePoNumberAction } from '@/server/actions/purchase-orders';

/**
 * Inline "edit PO number" affordance shown next to the PO number on the detail
 * page. Lets users relabel any non-cancelled PO — notably imported POs, which
 * land in 'expected_inbound' and so can't use the draft-only edit flow.
 */
export function PoRenameButton({ poId, currentNumber }: { poId: string; currentNumber: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState(currentNumber);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to current on open
      setValue(currentNumber);
    }
  }, [open, currentNumber]);

  async function save() {
    const next = value.trim();
    if (!next) {
      toast.error('Enter a PO number.');
      return;
    }
    setBusy(true);
    const res = await renamePoNumberAction(poId, next);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Renamed to ${res.data.poNumber}.`);
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit PO number">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit PO number</DialogTitle>
          <DialogDescription>
            Change this purchase order&apos;s number — for example, to match the vendor&apos;s own PO
            number. It must be unique among your active purchase orders.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="po-number">PO number</Label>
          <Input
            id="po-number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void save();
            }}
            autoFocus
            className="font-mono"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
