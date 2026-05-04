'use client';

import { Building2, Loader2, Plus, Trash2 } from 'lucide-react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  archiveCharterAction,
  createCharterAction,
  updateCharterAction,
} from '@/server/actions/charters';

interface CharterRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  notes: string | null;
  status: 'active' | 'inactive' | 'archived';
  warehouse_count: number;
  user_count: number;
}

interface FormValues {
  name: string;
  code: string;
  description: string;
  notes: string;
}

export function ChartersManager({
  initial,
  termSingular,
}: {
  initial: CharterRow[];
  termSingular: string;
}) {
  const [editing, setEditing] = React.useState<CharterRow | null>(null);
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
          icon={Building2}
          title={`No ${termSingular.toLowerCase()}s yet`}
          description={`Create your first ${termSingular.toLowerCase()} to start grouping warehouses.`}
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
                <TableHead className="text-right">Warehouses</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((row) => (
                <CharterTableRow
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

      <CharterDialog
        open={open}
        onOpenChange={setOpen}
        editing={editing}
        termSingular={termSingular}
      />
    </>
  );
}

function CharterTableRow({ row, onEdit }: { row: CharterRow; onEdit: () => void }) {
  const router = useRouter();

  async function archive() {
    if (!confirm(`Archive "${row.name}"? Existing warehouses keep working.`)) return;
    const res = await archiveCharterAction(row.id);
    if (!res.ok) toast.error(res.error.message);
    else {
      toast.success('Archived');
      router.refresh();
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{row.code ?? '—'}</TableCell>
      <TableCell className="text-right tabular-nums">{row.warehouse_count}</TableCell>
      <TableCell className="text-right tabular-nums">{row.user_count}</TableCell>
      <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
        {row.description ?? '—'}
      </TableCell>
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

function CharterDialog({
  open,
  onOpenChange,
  editing,
  termSingular,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: CharterRow | null;
  termSingular: string;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<FormValues>({
    defaultValues: { name: '', code: '', description: '', notes: '' },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? '',
        code: editing?.code ?? '',
        description: editing?.description ?? '',
        notes: editing?.notes ?? '',
      });
    }
  }, [open, editing, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      code: values.code || undefined,
      description: values.description || undefined,
      notes: values.notes || undefined,
      status: 'active' as const,
    };
    const res = editing
      ? await updateCharterAction(editing.id, payload)
      : await createCharterAction(payload);
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${termSingular.toLowerCase()}` : `New ${termSingular.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            {termSingular}s group warehouses by region, division, or business unit.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="charter-name">Name</Label>
            <Input
              id="charter-name"
              placeholder="Southern California"
              {...register('name', { required: true, maxLength: 120 })}
            />
            {errors.name && <p className="text-xs text-destructive">Name is required</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="charter-code">Code</Label>
            <Input
              id="charter-code"
              placeholder="SOCAL"
              {...register('code', { maxLength: 32 })}
            />
            <p className="text-[11px] text-muted-foreground">
              Short identifier used in reports and exports. Optional.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="charter-description">Description</Label>
            <Textarea
              id="charter-description"
              rows={2}
              placeholder="What this charter covers"
              {...register('description', { maxLength: 2000 })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="charter-notes">Internal notes</Label>
            <Textarea id="charter-notes" rows={2} {...register('notes', { maxLength: 2000 })} />
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
