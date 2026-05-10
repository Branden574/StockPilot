'use client';

import { Loader2, Plus, Trash2, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  archiveSupplierAction,
  createSupplierAction,
  updateSupplierAction,
} from '@/server/actions/suppliers';

interface SupplierRow {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
}

interface FormValues {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  website: string;
  notes: string;
}

export function SuppliersManager({ initial }: { initial: SupplierRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<SupplierRow | null>(null);
  const [open, setOpen] = React.useState(false);
  const [archiveTarget, setArchiveTarget] = React.useState<SupplierRow | null>(null);
  const [archiveBusy, setArchiveBusy] = React.useState(false);

  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    const res = await archiveSupplierAction(archiveTarget.id);
    setArchiveBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Supplier archived');
    setArchiveTarget(null);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center justify-end">
        <Button
          variant="gradient"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Plus className="h-4 w-4" /> New supplier
        </Button>
      </div>

      {initial.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No suppliers yet"
          description="Track who you buy from so they auto-link onto purchase orders. Use the New supplier button above to add one."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.contact_name ?? '—'}</TableCell>
                  <TableCell className="text-sm">
                    {row.email ? (
                      <a href={`mailto:${row.email}`} className="text-primary hover:underline">
                        {row.email}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.phone ?? '—'}</TableCell>
                  <TableCell className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(row);
                        setOpen(true);
                      }}
                    >
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <SupplierDialog open={open} onOpenChange={setOpen} editing={editing} />

      <DestructiveConfirm
        open={archiveTarget !== null}
        onOpenChange={(v) => {
          if (!v) setArchiveTarget(null);
        }}
        title={archiveTarget ? `Archive "${archiveTarget.name}"?` : 'Archive supplier?'}
        description="The supplier is hidden from pick lists and new purchase orders. Existing items and POs that reference this supplier keep working. You can restore it from the archived view."
        confirmLabel="Archive"
        pending={archiveBusy}
        onConfirm={confirmArchive}
      />
    </>
  );
}

function SupplierDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SupplierRow | null;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<FormValues>({
    defaultValues: { name: '', contactName: '', email: '', phone: '', website: '', notes: '' },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? '',
        contactName: editing?.contact_name ?? '',
        email: editing?.email ?? '',
        phone: editing?.phone ?? '',
        website: editing?.website ?? '',
        notes: editing?.notes ?? '',
      });
    }
  }, [open, editing, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      contactName: values.contactName || undefined,
      email: values.email || undefined,
      phone: values.phone || undefined,
      website: values.website || undefined,
      notes: values.notes || undefined,
    };
    const res = editing
      ? await updateSupplierAction(editing.id, payload)
      : await createSupplierAction(payload);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(editing ? 'Supplier updated' : 'Supplier created');
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit supplier' : 'New supplier'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="Acme Supplies Co" {...register('name', { required: true })} />
            {errors.name && <p className="text-xs text-destructive">Name is required</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="contactName">Contact name</Label>
              <Input id="contactName" {...register('contactName')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" {...register('phone')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...register('email')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="website">Website</Label>
              <Input id="website" placeholder="https://" {...register('website')} />
            </div>
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
