'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
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
import { Textarea } from '@/components/ui/textarea';
import { cancelRentalAction, markRentalReturnedAction } from '@/server/actions/rentals';
import type { RentalStatus } from '@/server/services/rentals';

interface RentalActionsPanelProps {
  rentalId: string;
  status: RentalStatus;
  canManage: boolean;
}

function MarkReturnedDialog({ rentalId, onClose }: { rentalId: string; onClose: () => void }) {
  const [notes, setNotes] = React.useState('');
  const [isPending, startTransition] = React.useTransition();

  function handleSubmit() {
    startTransition(async () => {
      const res = await markRentalReturnedAction({ id: rentalId, returnNotes: notes || null });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Rental marked as returned. Reservations released.');
      onClose();
    });
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Mark returned</DialogTitle>
        <DialogDescription>
          Confirm all items are back. Reservations will be released so the items are available for
          future rentals.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="panel-return-notes">Notes (optional)</Label>
        <Textarea
          id="panel-return-notes"
          placeholder="Condition notes, damage, etc."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          disabled={isPending}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : null}
          Confirm return
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelDialog({ rentalId, onClose }: { rentalId: string; onClose: () => void }) {
  const [reason, setReason] = React.useState('');
  const [isPending, startTransition] = React.useTransition();

  function handleSubmit() {
    if (!reason.trim()) {
      toast.error('A cancellation reason is required.');
      return;
    }
    startTransition(async () => {
      const res = await cancelRentalAction({ id: rentalId, reason: reason.trim() });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Rental cancelled.');
      onClose();
    });
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel rental</DialogTitle>
        <DialogDescription>
          This marks the rental as cancelled and releases all reservations. A reason is required.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="panel-cancel-reason">
          Reason <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="panel-cancel-reason"
          placeholder="Never picked up, booking error, etc."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          disabled={isPending}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          Back
        </Button>
        <Button variant="destructive" onClick={handleSubmit} disabled={isPending || !reason.trim()}>
          {isPending ? <Loader2 className="animate-spin" /> : null}
          Cancel rental
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function RentalActionsPanel({ rentalId, status, canManage }: RentalActionsPanelProps) {
  const [showReturn, setShowReturn] = React.useState(false);
  const [showCancel, setShowCancel] = React.useState(false);

  // Only show actions panel when there's something to do
  if (status !== 'out') {
    return null;
  }

  return (
    // The card for the work in front of you: Mark returned is the ink commit
    // button (DESIGN-SPEC 6.2); it releases this rental's holds only, and is
    // not a Returns RMA (no receipt, no dispositions).
    <DetailSection title="Actions" headingLevel={3}>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setShowReturn(true)}>Mark returned</Button>

        {canManage && (
          <Button
            variant="outline"
            className="text-destructive hover:text-destructive"
            onClick={() => setShowCancel(true)}
          >
            Cancel rental…
          </Button>
        )}
      </div>

      <Dialog
        open={showReturn}
        onOpenChange={(o) => {
          if (!o) setShowReturn(false);
        }}
      >
        <MarkReturnedDialog rentalId={rentalId} onClose={() => setShowReturn(false)} />
      </Dialog>

      <Dialog
        open={showCancel}
        onOpenChange={(o) => {
          if (!o) setShowCancel(false);
        }}
      >
        <CancelDialog rentalId={rentalId} onClose={() => setShowCancel(false)} />
      </Dialog>
    </DetailSection>
  );
}
