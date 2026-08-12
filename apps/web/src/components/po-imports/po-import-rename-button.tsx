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
import { prettifyFileNameForDisplay } from '@/lib/po-imports/display-name';
import { renamePoImportAction } from '@/server/actions/po-imports';

import { PO_IMPORT_DISPLAY_NAME_MAX } from '@stockpilot/core';

/**
 * Inline "name this import" affordance next to the import's H1. Follows
 * PoRenameButton (components/po/po-rename-button.tsx) beat for beat — same
 * ghost pencil trigger, same dialog, same reset-on-open, same
 * toast-then-router.refresh() — because this is the same act on a different
 * record and there is no reason for the two to feel different.
 *
 * `currentName` is the stored display_name, which is null for every import
 * created before naming existed. In that case the field opens PRE-FILLED with
 * the filename prettified, so the fix for an `image.jpg` row is one click and
 * one edit rather than typing from nothing.
 */
export function PoImportRenameButton({
  poImportId,
  currentName,
  fileName,
}: {
  poImportId: string;
  currentName: string | null;
  fileName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to current on open
      setValue(currentName ?? prettifyFileNameForDisplay(fileName));
    }
  }, [open, currentName, fileName]);

  async function save() {
    const next = value.trim();
    if (!next) {
      toast.error('Enter a name for this import.');
      return;
    }
    setBusy(true);
    const res = await renamePoImportAction({ poImportId, displayName: next });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Renamed to ${res.data.displayName}.`);
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit import name">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit import name</DialogTitle>
          <DialogDescription>
            Give this import a name so it is easy to find later. This only changes
            the label — the uploaded file keeps its own name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="po-import-display-name">PO name</Label>
          <Input
            id="po-import-display-name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void save();
            }}
            maxLength={PO_IMPORT_DISPLAY_NAME_MAX}
            placeholder="Example: August DC4 Book Order"
            autoFocus
          />
          <p className="text-muted-foreground text-xs">Source file: {fileName}</p>
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
