'use client';

import { Loader2, Plus, Trash2, Warehouse } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  archiveWarehouseAction,
  createWarehouseAction,
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
}: {
  initial: WarehouseRow[];
  charters: CharterOption[];
  managers: ManagerOption[];
  termSingular: string;
  charterSingular: string;
}) {
  const [editing, setEditing] = React.useState<WarehouseRow | null>(null);
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <div className="flex items-center justify-end">
        <Button
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Plus className="h-4 w-4" /> New {termSingular.toLowerCase()}
        </Button>
      </div>

      {initial.length === 0 ? (
        <EmptyState
          icon={Warehouse}
          title={`No ${termSingular.toLowerCase()}s yet`}
          description={`Create your first ${termSingular.toLowerCase()} to start tracking stock by location.`}
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              Create {termSingular.toLowerCase()}
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>{charterSingular}</TableHead>
                <TableHead>Manager</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((row) => (
                <WarehouseTableRow
                  key={row.id}
                  row={row}
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

function WarehouseTableRow({ row, onEdit }: { row: WarehouseRow; onEdit: () => void }) {
  const router = useRouter();

  async function archive() {
    if (
      !confirm(
        `Archive "${row.name}"? Existing inventory in this warehouse stays put but the warehouse is hidden.`,
      )
    )
      return;
    const res = await archiveWarehouseAction(row.id);
    if (!res.ok) toast.error(res.error.message);
    else {
      toast.success('Archived');
      router.refresh();
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link
          href={`/dashboard/warehouses/${row.id}`}
          className="hover:underline"
        >
          {row.name}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{row.code}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {row.charters.length === 0 ? (
          '—'
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.charters.map((c) => (
              <span
                key={c.id}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px]"
              >
                {c.name}
              </span>
            ))}
          </span>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{row.manager_name ?? '—'}</TableCell>
      <TableCell className="text-right tabular-nums">{row.user_count}</TableCell>
      <TableCell className="text-right tabular-nums">{row.item_count}</TableCell>
      <TableCell className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="ghost" size="icon" onClick={archive} aria-label="Archive">
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
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
    toast.success(editing ? `${termSingular} updated` : `${termSingular} created`);
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="wh-name">Name</Label>
              <Input
                id="wh-name"
                placeholder="San Diego Main"
                {...register('name', { required: true, maxLength: 120 })}
              />
              {errors.name && <p className="text-xs text-destructive">Name is required</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-code">Code</Label>
              <Input
                id="wh-code"
                placeholder="SD-MAIN"
                {...register('code', { required: true, maxLength: 32 })}
              />
              {errors.code && <p className="text-xs text-destructive">Code is required</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Charters serviced</Label>
            <p className="text-[11px] text-muted-foreground">
              Pick every charter this {termSingular.toLowerCase()} carries inventory for.
              Items can be tagged to one of these, or marked Generic for shared stock.
            </p>
            {charters.length === 0 ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                No charters defined yet. Create one in Admin → Charters first.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {charters.map((c) => {
                  const active = charterIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleCharter(c.id)}
                      className={
                        'rounded-full border px-3 py-1 text-xs transition-colors ' +
                        (active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card hover:bg-muted')
                      }
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Manager</Label>
            <Select
              value={watch('managerUserId') || NONE_VALUE}
              onValueChange={(v: string) =>
                setValue('managerUserId', v === NONE_VALUE ? '' : v)
              }
            >
              <SelectTrigger>
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
            <Label>Contact</Label>
            <div className="grid grid-cols-3 gap-2">
              <Input placeholder="Name" {...register('contactName', { maxLength: 120 })} />
              <Input
                placeholder="Email"
                type="email"
                {...register('contactEmail', { maxLength: 254 })}
              />
              <Input placeholder="Phone" {...register('contactPhone', { maxLength: 40 })} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wh-notes">Notes</Label>
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
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

