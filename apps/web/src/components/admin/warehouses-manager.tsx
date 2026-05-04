'use client';

import { Loader2, Plus, Trash2, Warehouse } from 'lucide-react';
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
  charter_id: string | null;
  charter_name: string | null;
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
  charterId: string;
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
        <div className="overflow-hidden rounded-xl border border-border bg-card">
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
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{row.code}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{row.charter_name ?? '—'}</TableCell>
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
      charterId: '',
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
        charterId: editing?.charter_id ?? '',
        managerUserId: editing?.manager_user_id ?? '',
        contactName: editing?.contact_name ?? '',
        contactEmail: editing?.contact_email ?? '',
        contactPhone: editing?.contact_phone ?? '',
        notes: editing?.notes ?? '',
      });
    }
  }, [open, editing, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      code: values.code,
      charterId: values.charterId || null,
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

          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Charter"
              value={watch('charterId') || NONE_VALUE}
              onChange={(v: string) => setValue('charterId', v === NONE_VALUE ? '' : v)}
              options={charters}
              placeholder="No charter"
            />
            <SelectField
              label="Manager"
              value={watch('managerUserId') || NONE_VALUE}
              onChange={(v: string) => setValue('managerUserId', v === NONE_VALUE ? '' : v)}
              options={managers}
              placeholder="No manager"
            />
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

function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ id: string; name: string }>;
  placeholder: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>{placeholder}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
