'use client';

import { Archive, History, Loader2, Plus, RotateCcw, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { PageHeader } from '@/components/patterns/page-header';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
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
  restoreSupplierAction,
  updateSupplierAction,
} from '@/server/actions/suppliers';

import { supplierMailtoUrl } from './supplier-mailto';

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

export function SuppliersManager({
  initial,
  view = 'active',
  canManage = true,
}: {
  initial: SupplierRow[];
  view?: 'active' | 'archived';
  /** Hides New / Edit / Archive / Restore buttons when false. */
  canManage?: boolean;
}) {
  const router = useRouter();
  const isArchivedView = view === 'archived';
  const [editing, setEditing] = React.useState<SupplierRow | null>(null);
  const [open, setOpen] = React.useState(false);
  const [archiveTarget, setArchiveTarget] = React.useState<SupplierRow | null>(null);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [restoreTarget, setRestoreTarget] = React.useState<SupplierRow | null>(null);
  const [restoreBusy, setRestoreBusy] = React.useState(false);

  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    const res = await archiveSupplierAction(archiveTarget.id);
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
    const res = await restoreSupplierAction(restoreTarget.id);
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
      <PageHeader
        title="Suppliers"
        subline={
          isArchivedView
            ? 'Suppliers you archived. Restore one to bring it back into pick lists.'
            : 'Vendors, contacts, and where to reorder from.'
        }
        actions={<ArchiveViewToggle view={view} />}
        primaryAction={
          canManage && !isArchivedView ? (
            <Button
              variant="gradient"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> New supplier
            </Button>
          ) : null
        }
      />

      {initial.length === 0 ? (
        isArchivedView ? (
          <EmptyState
            icon={History}
            title="No archived suppliers"
            description="Suppliers you archive show up here so you can restore them later."
          />
        ) : (
          <EmptyState
            icon={Truck}
            title="No suppliers yet"
            description="Track who you buy from so they auto-link onto purchase orders. Use the New supplier button above to add one."
          />
        )
      ) : (
        <div
          data-slot="suppliers-table"
          className="border-border bg-card min-w-0 overflow-hidden rounded-lg border"
        >
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((row) => {
                // A link only for one plain address; any other stored text is
                // shown as it is, never as a link (supplierMailtoUrl).
                const mailto = supplierMailtoUrl(row.email);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-foreground font-medium">{row.name}</TableCell>
                    <TableCell className="text-ink-2">{row.contact_name ?? '—'}</TableCell>
                    <TableCell className="[overflow-wrap:anywhere]">
                      {row.email ? (
                        mailto ? (
                          <a
                            href={mailto}
                            className="text-accent hover:text-foreground underline-offset-4 hover:underline"
                          >
                            {row.email}
                          </a>
                        ) : (
                          <span className="text-ink-2">{row.email}</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-ink-2 whitespace-nowrap">
                      {row.phone ? (
                        <span className="font-mono text-[12.5px]">{row.phone}</span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        {canManage &&
                          (isArchivedView ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setRestoreTarget(row)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" /> Restore
                            </Button>
                          ) : (
                            <>
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
                                <Archive className="text-muted-foreground h-4 w-4" />
                              </Button>
                            </>
                          ))}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
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
        description={
          <>
            The supplier is hidden from pick lists and new purchase orders. Existing items and POs
            that reference this supplier keep working. You can restore it from the{' '}
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
        title={restoreTarget ? `Restore "${restoreTarget.name}"?` : 'Restore supplier?'}
        description="This brings the supplier back into the active list."
        confirmLabel="Restore"
        tone="primary"
        pending={restoreBusy}
        onConfirm={confirmRestore}
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
    mode: 'onBlur',
    reValidateMode: 'onChange',
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
    toast.success(editing ? 'Supplier updated.' : 'Supplier created.');
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
            <Input
              id="name"
              placeholder="Acme Supplies Co"
              {...register('name', { required: true })}
            />
            {errors.name && <p className="text-destructive text-xs">Name is required.</p>}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contactName">
                Contact name
                <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
              </Label>
              <Input id="contactName" {...register('contactName')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">
                Phone
                <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
              </Label>
              <Input id="phone" {...register('phone')} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="email">
                Email
                <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
              </Label>
              <Input id="email" type="email" {...register('email')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="website">
                Website
                <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
              </Label>
              <Input id="website" placeholder="https://" {...register('website')} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notes">
              Notes
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            <Textarea id="notes" rows={3} {...register('notes')} />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="gradient" disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editing ? (
                'Save changes'
              ) : (
                'Create supplier'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
