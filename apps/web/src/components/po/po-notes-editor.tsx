'use client';

import { Loader2, Pencil, Plus } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { updatePoNotesAction } from '@/server/actions/purchase-orders';

const NOTES_MAX = 2000;

/**
 * Notes block on the PO detail page with inline add/edit. Notes are a pure
 * annotation (no stock/money impact), so this works at ANY PO status —
 * including received/ordered POs that can't use the draft-only edit form.
 */
export function PoNotesEditor({
  poId,
  currentNotes,
}: {
  poId: string;
  currentNotes: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState(currentNotes ?? '');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to current on open
      setValue(currentNotes ?? '');
    }
  }, [open, currentNotes]);

  async function save() {
    setBusy(true);
    const res = await updatePoNotesAction(poId, value);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Notes saved.');
    setOpen(false);
    router.refresh();
  }

  const hasNotes = Boolean((currentNotes ?? '').trim());

  return (
    <div className="space-y-1 border-t pt-3">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs uppercase tracking-wider">Notes</p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs">
              {hasNotes ? (
                <>
                  <Pencil className="h-3 w-3" /> Edit
                </>
              ) : (
                <>
                  <Plus className="h-3 w-3" /> Add
                </>
              )}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{hasNotes ? 'Edit notes' : 'Add notes'}</DialogTitle>
              <DialogDescription>
                Notes can be updated at any time, even after the order is received.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value.slice(0, NOTES_MAX))}
              placeholder="Add a note about this purchase order…"
              rows={5}
              autoFocus
            />
            <p className="text-muted-foreground text-right text-xs">
              {value.length}/{NOTES_MAX}
            </p>
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
      </div>
      {hasNotes ? (
        <p className="whitespace-pre-wrap text-sm">{currentNotes}</p>
      ) : (
        <p className="text-muted-foreground text-sm italic">No notes yet.</p>
      )}
    </div>
  );
}
