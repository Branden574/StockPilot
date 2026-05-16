'use client';

import { Loader2, Truck } from 'lucide-react';
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
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { assignDeliveryAction } from '@/server/actions/order-requests';

export interface DriverOption {
  userId: string;
  fullName: string | null;
  email: string;
}

interface Props {
  orderId: string;
  drivers: DriverOption[];
  currentDriverId: string | null;
  trigger: React.ReactNode;
}

export function AssignDeliveryDialog({
  orderId,
  drivers,
  currentDriverId,
  trigger,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string>(currentDriverId ?? '');
  const [pending, setPending] = React.useState(false);

  async function submit() {
    if (!selected) {
      toast.error('Pick a driver.');
      return;
    }
    setPending(true);
    const res = await assignDeliveryAction({ id: orderId, deliveryUserId: selected });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Delivery assigned.');
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
            <DialogTitle>Assign delivery</DialogTitle>
            <DialogDescription>
              Pick the staff member who&apos;ll drive this order. They&apos;ll be
              able to mark it in-transit and collect the signature.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="driver">Driver</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="driver">
                <SelectValue placeholder="Pick someone" />
              </SelectTrigger>
              <SelectContent>
                {drivers.map((d) => (
                  <SelectItem key={d.userId} value={d.userId}>
                    {d.fullName ?? d.email}
                    {d.fullName ? ` (${d.email})` : ''}
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
                  <Truck className="mr-1 h-4 w-4" /> Assign
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
