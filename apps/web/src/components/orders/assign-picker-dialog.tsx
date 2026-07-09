'use client';

import { ClipboardList, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import type { DriverOption } from '@/components/orders/assign-delivery-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { assignPickingAction } from '@/server/actions/order-requests';

interface Props {
  orderId: string;
  pickers: DriverOption[];
  currentPickerId: string | null;
  trigger: React.ReactNode;
}

export function AssignPickerDialog({
  orderId,
  pickers,
  currentPickerId,
  trigger,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string>(currentPickerId ?? '');
  const [pending, setPending] = React.useState(false);

  async function submit() {
    if (!selected) {
      toast.error('Pick a picker.');
      return;
    }
    setPending(true);
    const res = await assignPickingAction({ id: orderId, pickerUserId: selected });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Picker assigned.');
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-block">
        {trigger}
      </span>
      <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign picker</DialogTitle>
            <DialogDescription>
              Pick the staff member who&apos;ll pick this order. It&apos;s locked to
              them until they finish or a manager reassigns it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="picker">Picker</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="picker">
                <SelectValue placeholder="Pick someone" />
              </SelectTrigger>
              <SelectContent>
                {pickers.map((p) => (
                  <SelectItem key={p.userId} value={p.userId}>
                    {p.fullName ?? p.email}
                    {p.fullName ? ` (${p.email})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !selected}>
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <ClipboardList className="mr-1 h-4 w-4" /> Assign
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
