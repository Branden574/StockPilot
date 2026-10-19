'use client';

import { Check, History, Loader2, Plus, RotateCcw, Trash2, Warehouse } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { STICKY_ACTIONS } from '@/components/admin/sticky-actions';
import { FilterChip, MetaChip } from '@/components/patterns/chip';
import { PageHeader } from '@/components/patterns/page-header';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  archiveWarehouseAction,
  createWarehouseAction,
  restoreWarehouseAction,
  updateWarehouseAction,
} from '@/server/actions/warehouses';

interface WarehouseRow {
  id: string;
  name: string;
  code: string;
  charters: Array<{ id: string; name: string }>;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  manager_user_id: string | null;
  manager_name: string | null;
  status: 'active' | 'inactive' | 'archived';
  notes: string | null;
  user_count: number;
  item_count: number;
}

interface CharterOption {
  id: string;
  name: string;
}
interface ManagerOption {
  id: string;
  name: string;
}

interface FormValues {
  name: string;
  code: string;
  charterIds: string[];
  managerUserId: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
}

const NONE_VALUE = '__none';

export function WarehousesManager({
  initial,
  charters,
  managers,
  termSingular,
  charterSingular,
  view = 'active',
  eyebrow,
  title,
  subline,
}: {
  initial: WarehouseRow[];
  charters: CharterOption[];
  managers: ManagerOption[];
  termSingular: string;
  charterSingular: string;
  view?: 'active' | 'archived';
  /** The page header's words, resolved by the page (terminology included). */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subline?: React.ReactNode;
}) {
  const isArchivedView = view === 'archived';
  const [editing, setEditing] = React.useState<WarehouseRow | null>(null);
  const [open, setOpen] = React.useState(false);

  return (
    <>
      {/* The header lives here because "New" and each row's Edit share one
          dialog. The Active / Archived toggle is the header's view control
          (DESIGN-SPEC 6.21); "New" is the page-level create (accent primary),
          hidden in the archived view as before. */}
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        subline={subline}
        actions={<ArchiveViewToggle view={view} />}
        primaryAction={
          !isArchivedView ? (
            <Button
              variant="gradient"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> New {termSingular.toLowerCase()}
            </Button>
          ) : null
        }
      />

      {initial.length === 0 ? (
        isArchivedView ? (
          <EmptyState
            icon={History}
            title={`No archived ${termSingular.toLowerCase()}s`}
            description={`${termSingular}s you archive show up here so you can restore them later.`}
          />
        ) : (
          <EmptyState
            icon={Warehouse}
            title={`No ${termSingular.toLowerCase()}s yet`}
            description={`Create your first ${termSingular.toLowerCase()} to start tracking stock by location, assign managers, and route orders. Use the New ${termSingular.toLowerCase()} button above to add one.`}
          />
        )
      ) : (
        // Scrolls sideways inside its card on a narrow screen, so Actions
        // stay reachable and never push the page wider.
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>{charterSingular}</TableHead>
                <TableHead>Manager</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Items</TableHead>
                {/* Below md the Actions column stays pinned to the card's right edge
                    while the other columns scroll under it, so Edit and Archive
                    are always on screen. */}
                <TableHead className={cn('w-32 text-right', STICKY_ACTIONS)}>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((row) => (
                <WarehouseTableRow
                  key={row.id}
                  row={row}
                  isArchivedView={isArchivedView}
                  onEdit={() => {
                    setEditing(row);
                    setOpen(true);
                  }}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <WarehouseDialog
        open={open}
        onOpenChange={setOpen}
        editing={editing}
        charters={charters}
        managers={managers}
        termSingular={termSingular}
      />
    </>
  );
}

function WarehouseTableRow({
  row,
  isArchivedView,
  onEdit,
}: {
  row: WarehouseRow;
  isArchivedView: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const [restoreBusy, setRestoreBusy] = React.useState(false);
  // Why the last try was refused, shown inside the confirm: a toast alone
  // sits behind the open dialog. Cleared on open and on each try.
  const [confirmError, setConfirmError] = React.useState<string | null>(null);

  async function confirmArchive() {
    setArchiveBusy(true);
    setConfirmError(null);
    const res = await archiveWarehouseAction(row.id);
    setArchiveBusy(false);
    if (!res.ok) {
      setConfirmError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    setArchiveOpen(false);
    toast.success(`"${row.name}" archived.`);
    router.refresh();
  }

  async function confirmRestore() {
    setRestoreBusy(true);
    setConfirmError(null);
    const res = await restoreWarehouseAction(row.id);
    setRestoreBusy(false);
    if (!res.ok) {
      setConfirmError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    setRestoreOpen(false);
    toast.success(`"${row.name}" restored.`);
    router.refresh();
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link
          href={`/dashboard/warehouses/${row.id}`}
          className="text-foreground underline-offset-2 hover:underline"
        >
          {row.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground font-mono text-[12.5px]">{row.code}</TableCell>
      <TableCell className="text-muted-foreground max-w-[260px]">
        {row.charters.length === 0 ? (
          '—'
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.charters.map((c) => (
              <MetaChip key={c.id}>{c.name}</MetaChip>
            ))}
          </span>
        )}
      </TableCell>
      <TableCell className="text-ink-2">{row.manager_name ?? '—'}</TableCell>
      <TableCell className="text-right font-mono tabular-nums">{row.user_count}</TableCell>
      <TableCell className="text-right font-mono tabular-nums">{row.item_count}</TableCell>
      <TableCell className={cn('whitespace-nowrap', STICKY_ACTIONS)}>
        {/* The buttons sit in their own flex box: a flex table cell stops
            being a table cell (its row border and alignment break). */}
        <div className="flex items-center justify-end gap-2">
          {isArchivedView ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setConfirmError(null);
                  setRestoreOpen(true);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Restore
              </Button>
              <DestructiveConfirm
                open={restoreOpen}
                onOpenChange={setRestoreOpen}
                title={`Restore "${row.name}"?`}
                description="This brings the warehouse back into the active list."
                confirmLabel="Restore"
                tone="primary"
                pending={restoreBusy}
                error={confirmError}
                onConfirm={confirmRestore}
              />
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onEdit}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setConfirmError(null);
                  setArchiveOpen(true);
                }}
                aria-label="Archive"
              >
                <Trash2 className="text-muted-foreground h-4 w-4" />
              </Button>
              <DestructiveConfirm
                open={archiveOpen}
                onOpenChange={setArchiveOpen}
                title={`Archive "${row.name}"?`}
                description={
                  <>
                    Existing inventory in this warehouse stays put but the warehouse is hidden from
                    pick lists and reports. You can restore it from the{' '}
                    <strong>Archived view</strong>.
                  </>
                }
                confirmLabel="Archive"
                pending={archiveBusy}
                error={confirmError}
                onConfirm={confirmArchive}
              />
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function WarehouseDialog({
  open,
  onOpenChange,
  editing,
  charters,
  managers,
  termSingular,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: WarehouseRow | null;
  charters: CharterOption[];
  managers: ManagerOption[];
  termSingular: string;
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
    defaultValues: {
      name: '',
      code: '',
      charterIds: [],
      managerUserId: '',
      contactName: '',
      contactEmail: '',
      contactPhone: '',
      notes: '',
    },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? '',
        code: editing?.code ?? '',
        charterIds: editing?.charters.map((c) => c.id) ?? [],
        managerUserId: editing?.manager_user_id ?? '',
        contactName: editing?.contact_name ?? '',
        contactEmail: editing?.contact_email ?? '',
        contactPhone: editing?.contact_phone ?? '',
        notes: editing?.notes ?? '',
      });
    }
  }, [open, editing, reset]);

  const charterIds = watch('charterIds');

  function toggleCharter(id: string) {
    const set = new Set(charterIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    setValue('charterIds', [...set]);
  }

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      code: values.code,
      charterIds: values.charterIds,
      managerUserId: values.managerUserId || null,
      contactName: values.contactName || undefined,
      contactEmail: values.contactEmail || undefined,
      contactPhone: values.contactPhone || undefined,
      notes: values.notes || undefined,
      status: 'active' as const,
    };
    const res = editing
      ? await updateWarehouseAction(editing.id, payload)
      : await createWarehouseAction(payload);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(editing ? `${termSingular} updated.` : `${termSingular} created.`);
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${termSingular.toLowerCase()}` : `New ${termSingular.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            Stock and assigned users are scoped to a {termSingular.toLowerCase()}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wh-name">Name</Label>
              <Input
                id="wh-name"
                placeholder="San Diego Main"
                {...register('name', { required: true, maxLength: 120 })}
              />
              {errors.name && <p className="text-destructive text-[12px]">Name is required.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-code">Code</Label>
              <Input
                id="wh-code"
                placeholder="SD-MAIN"
                {...register('code', { required: true, maxLength: 32 })}
              />
              {errors.code && <p className="text-destructive text-[12px]">Code is required.</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label id="wh-charters-label">Charters serviced</Label>
            <p id="wh-charters-help" className="text-muted-foreground text-[12px]">
              Pick every charter this {termSingular.toLowerCase()} carries inventory for. Items can
              be tagged to one of these, or marked Generic for shared stock.
            </p>
            {charters.length === 0 ? (
              <div className="border-border bg-sunk text-muted-foreground rounded-md border px-3 py-2 text-[12px]">
                No charters defined yet. Create one in Admin → Charters first.
              </div>
            ) : (
              // A real multi-select: each chip is a toggle button with
              // aria-pressed, and a selected chip shows a tick as well as
              // the ink fill, so its state never rests on colour alone.
              <div
                role="group"
                aria-labelledby="wh-charters-label"
                aria-describedby="wh-charters-help"
                className="flex flex-wrap gap-2"
              >
                {charters.map((c) => {
                  const active = charterIds.includes(c.id);
                  return (
                    <FilterChip
                      key={c.id}
                      pressed={active}
                      data-charter-id={c.id}
                      onClick={() => toggleCharter(c.id)}
                    >
                      {active ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                      {c.name}
                    </FilterChip>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wh-manager">
              Manager
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            <Select
              value={watch('managerUserId') || NONE_VALUE}
              onValueChange={(v: string) => setValue('managerUserId', v === NONE_VALUE ? '' : v)}
            >
              <SelectTrigger id="wh-manager">
                <SelectValue placeholder="No manager" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>No manager</SelectItem>
                {managers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Contact
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            {/* Each box is named for assistive technology, as on the charter
                dialog (they had only a placeholder). */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input
                placeholder="Name"
                aria-label="Contact name"
                {...register('contactName', { maxLength: 120 })}
              />
              <Input
                placeholder="Email"
                type="email"
                aria-label="Contact email"
                {...register('contactEmail', { maxLength: 254 })}
              />
              <Input
                placeholder="Phone"
                aria-label="Contact phone"
                {...register('contactPhone', { maxLength: 40 })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wh-notes">
              Notes
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            <Textarea id="wh-notes" rows={2} {...register('notes', { maxLength: 2000 })} />
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
            {/* The button keeps its words beside the spinner while it saves. */}
            <Button
              type="submit"
              variant="gradient"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {editing ? 'Save changes' : `Create ${termSingular.toLowerCase()}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
