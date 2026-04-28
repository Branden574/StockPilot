'use client';

import { Building2, Loader2, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Button } from '@/components/ui/button';
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

export function LocationsManager({ initial }: { initial: LocationRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<LocationRow | null>(null);
  const [open, setOpen] = React.useState(false);

  function openNew() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(row: LocationRow) {
    setEditing(row);
    setOpen(true);
  }

  return (
    <>
      <div className="flex items-center justify-end">
        <Button variant="gradient" onClick={openNew}>
          <Plus className="h-4 w-4" /> New location
        </Button>
      </div>

      {initial.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No locations yet"
          description="Add warehouses, rooms, shelves, vehicles, or job sites to track where stock lives."
          action={
            <Button variant="gradient" onClick={openNew}>
              Add a location
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
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
                    <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={async () => {
                        if (!confirm(`Archive "${row.name}"?`)) return;
                        const res = await archiveLocationAction(row.id);
                        if (!res.ok) toast.error(res.error.message);
                        else {
                          toast.success('Location archived');
                          router.refresh();
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <LocationDialog open={open} onOpenChange={setOpen} editing={editing} />
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
    toast.success(editing ? 'Location updated' : 'Location created');
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
            {errors.name && <p className="text-xs text-destructive">Name is required</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
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
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" rows={3} {...register('notes')} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="gradient" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

LocationDialog.displayName = 'LocationDialog';
