'use client';

import { Building2, History, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  archiveLocationAction,
  createLocationAction,
  restoreLocationAction,
  updateLocationAction,
} from '@/server/actions/locations';
import { useRouter } from 'next/navigation';

interface LocationRow {
  id: string;
  name: string;
  type: string | null;
  notes: string | null;
}

interface FormValues {
  name: string;
  type: string;
  notes: string;
}

const TYPES = [
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'room', label: 'Room' },
  { value: 'shelf', label: 'Shelf' },
  { value: 'bin', label: 'Bin' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'jobsite', label: 'Job site' },
  { value: 'other', label: 'Other' },
];

export function LocationsManager({
  initial,
  view = 'active',
}: {
  initial: LocationRow[];
  view?: 'active' | 'archived';
}) {
  const router = useRouter();
  const isArchivedView = view === 'archived';
  const [editing, setEditing] = React.useState<LocationRow | null>(null);
  const [open, setOpen] = React.useState(false);
  const [archiveTarget, setArchiveTarget] = React.useState<LocationRow | null>(null);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [restoreTarget, setRestoreTarget] = React.useState<LocationRow | null>(null);
  const [restoreBusy, setRestoreBusy] = React.useState(false);

  function openNew() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(row: LocationRow) {
    setEditing(row);
    setOpen(true);
  }

  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    const res = await archiveLocationAction(archiveTarget.id);
    setArchiveBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`"${archiveTarget.name}" archived.`);
    setArchiveTarget(null);
    router.refresh();
  }

  async function confirmRestore() {
    if (!restoreTarget) return;
    setRestoreBusy(true);
    const res = await restoreLocationAction(restoreTarget.id);
    setRestoreBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`"${restoreTarget.name}" restored.`);
    setRestoreTarget(null);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <ArchiveViewToggle view={view} />
        {!isArchivedView && (
          <Button variant="gradient" onClick={openNew}>
            <Plus className="h-4 w-4" /> New location
          </Button>
        )}
      </div>

      {initial.length === 0 ? (
        isArchivedView ? (
          <EmptyState
            icon={History}
            title="No archived locations"
            description="Locations you archive show up here so you can restore them later."
          />
        ) : (
          <EmptyState
            icon={Building2}
            title="No locations yet"
            description="Add warehouses, rooms, shelves, vehicles, or job sites to track where stock lives. Use the New location button above to add one."
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-xs uppercase tracking-wider text-muted-foreground">
                    {row.type ?? '—'}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                    {row.notes ?? '—'}
                  </TableCell>
                  <TableCell className="flex justify-end gap-2">
                    {isArchivedView ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRestoreTarget(row)}
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Restore
                      </Button>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setArchiveTarget(row)}
                          aria-label={`Archive ${row.name}`}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <LocationDialog open={open} onOpenChange={setOpen} editing={editing} />

      <DestructiveConfirm
        open={archiveTarget !== null}
        onOpenChange={(v) => {
          if (!v) setArchiveTarget(null);
        }}
        title={archiveTarget ? `Archive "${archiveTarget.name}"?` : 'Archive location?'}
        description={
          <>
            The location is hidden from pick lists and item forms. Items currently assigned to
            it keep their assignment until you move them. You can restore it from the{' '}
            <strong>Archived view</strong>.
          </>
        }
        confirmLabel="Archive"
        pending={archiveBusy}
        onConfirm={confirmArchive}
      />

      <DestructiveConfirm
        open={restoreTarget !== null}
        onOpenChange={(v) => {
          if (!v) setRestoreTarget(null);
        }}
        title={restoreTarget ? `Restore "${restoreTarget.name}"?` : 'Restore location?'}
        description="This brings the location back into the active list."
        confirmLabel="Restore"
        tone="primary"
        pending={restoreBusy}
        onConfirm={confirmRestore}
      />
    </>
  );
}

function LocationDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: LocationRow | null;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<FormValues>({
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { name: '', type: '', notes: '' },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? '',
        type: editing?.type ?? '',
        notes: editing?.notes ?? '',
      });
    }
  }, [open, editing, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      type: (values.type || undefined) as
        | 'warehouse' | 'room' | 'shelf' | 'bin' | 'vehicle' | 'jobsite' | 'other' | undefined,
      notes: values.notes || undefined,
    };
    const res = editing
      ? await updateLocationAction(editing.id, payload)
      : await createLocationAction(payload);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(editing ? 'Location updated.' : 'Location created.');
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit location' : 'New location'}</DialogTitle>
          <DialogDescription>
            Track where stock lives — warehouses, rooms, shelves, vehicles, job sites.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="Main warehouse" {...register('name', { required: true })} />
            {errors.name && <p className="text-xs text-destructive">Name is required.</p>}
          </div>
          <div className="space-y-1.5">
            <Label>
              Type
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Select value={watch('type')} onValueChange={(v: string) => setValue('type', v)}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a type" />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notes">
              Notes
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea id="notes" rows={3} {...register('notes')} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="gradient" disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editing ? (
                'Save changes'
              ) : (
                'Create location'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

LocationDialog.displayName = 'LocationDialog';
