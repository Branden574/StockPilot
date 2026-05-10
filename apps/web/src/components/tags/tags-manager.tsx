'use client';

import { Loader2, Plus, Tags as TagsIcon, Trash2 } from 'lucide-react';
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
import {
  createTagAction,
  deleteTagAction,
  updateTagAction,
} from '@/server/actions/tags';

export interface TagManagerRow {
  id: string;
  name: string;
  color: string | null;
  usage_count: number;
}

interface FormValues {
  name: string;
  color: string;
}

const PRESET_COLORS = [
  '#6366f1',
  '#10b981',
  '#f97316',
  '#0ea5e9',
  '#a855f7',
  '#ec4899',
  '#eab308',
  '#64748b',
];
const DEFAULT_COLOR = '#94a3b8';

export function TagsManager({ initial }: { initial: TagManagerRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<TagManagerRow | null>(null);
  const [open, setOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<TagManagerRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  function openNew() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(row: TagManagerRow) {
    setEditing(row);
    setOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    const res = await deleteTagAction(deleteTarget.id);
    setDeleteBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`"${deleteTarget.name}" deleted.`);
    setDeleteTarget(null);
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center justify-end">
        <Button variant="gradient" onClick={openNew}>
          <Plus className="h-4 w-4" /> New tag
        </Button>
      </div>

      {initial.length === 0 ? (
        <EmptyState
          icon={TagsIcon}
          title="No tags yet"
          description="Tags add a flexible label layer on top of categories. Apply many tags per item and pull them into bulk actions. Use the New tag button above to add one."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <ul className="divide-y divide-border">
            {initial.map((tag) => (
              <li
                key={tag.id}
                className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
              >
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color ?? DEFAULT_COLOR }}
                />
                <button
                  type="button"
                  onClick={() => openEdit(tag)}
                  className="flex-1 text-left font-medium transition-colors hover:text-primary"
                >
                  {tag.name}
                </button>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {tag.usage_count} item{tag.usage_count === 1 ? '' : 's'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEdit(tag)}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => setDeleteTarget(tag)}
                  aria-label={`Delete ${tag.name}`}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <TagDialog open={open} onOpenChange={setOpen} editing={editing} />

      <DestructiveConfirm
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title={deleteTarget ? `Delete "${deleteTarget.name}"?` : 'Delete tag?'}
        description={
          deleteTarget && deleteTarget.usage_count > 0
            ? `This tag is currently applied to ${deleteTarget.usage_count} item${deleteTarget.usage_count === 1 ? '' : 's'} — those links will be removed. The items themselves stay intact.`
            : 'This tag will be removed from your workspace.'
        }
        confirmLabel="Delete"
        pending={deleteBusy}
        onConfirm={confirmDelete}
      />
    </>
  );
}

function TagDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: TagManagerRow | null;
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
    defaultValues: { name: '', color: DEFAULT_COLOR },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? '',
        color: editing?.color ?? DEFAULT_COLOR,
      });
    }
  }, [open, editing, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      color: values.color || null,
    };
    const res = editing
      ? await updateTagAction(editing.id, payload)
      : await createTagAction(payload);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(editing ? 'Tag updated.' : 'Tag created.');
    onOpenChange(false);
    router.refresh();
  });

  const currentColor = watch('color');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit tag' : 'New tag'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              placeholder="Fragile"
              maxLength={60}
              {...register('name', { required: true, maxLength: 60 })}
            />
            {errors.name && <p className="text-xs text-destructive">Name is required.</p>}
          </div>
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap items-center gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setValue('color', c)}
                  className="h-7 w-7 rounded-full ring-offset-2 ring-offset-background transition-all data-[selected=true]:ring-2 data-[selected=true]:ring-ring"
                  data-selected={currentColor === c}
                  style={{ backgroundColor: c }}
                  aria-label={`Use color ${c}`}
                />
              ))}
              {/*
                Native color picker covers the long tail. Sized to match
                the swatch row so the picker line stays aligned.
              */}
              <Input
                type="color"
                value={
                  /^#[0-9a-fA-F]{6}$/.test(currentColor)
                    ? currentColor
                    : DEFAULT_COLOR
                }
                onChange={(e) => setValue('color', e.target.value)}
                className="h-7 w-10 cursor-pointer p-0.5"
                aria-label="Custom tag color"
              />
            </div>
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
                'Create tag'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
