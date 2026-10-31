'use client';

import { Loader2, Plus, Tags as TagsIcon, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { PageHeader } from '@/components/patterns/page-header';
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
import { createTagAction, deleteTagAction, updateTagAction } from '@/server/actions/tags';

import { TAG_DEFAULT_COLOR, tagColor } from './tag-color';

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
// The editor opens on a tag's colour only when it is the #rrggbb form the app
// writes (tagColor), else on the default, so saving a rename sends a colour
// the server accepts (docket T14).
const DEFAULT_COLOR = TAG_DEFAULT_COLOR;

/**
 * A row's Edit and Delete (CONFLICTS D18). They used to be opacity-0 until the
 * row was hovered, so a phone or tablet never showed them and a keyboard user
 * tabbed onto invisible buttons. Now only a fine pointer (a mouse) hides them
 * until the row is hovered or holds focus; on touch they always show. The two
 * sit 8 px apart, the gap the 44 px touch areas of 28 and 32 px buttons need.
 * Focus in the row is the descendant selector `.group:focus-within &`, not
 * Tailwind's group-focus-within variant, which Safari pays for on every focus
 * change of every page (lib/group-focus-variants.guard.test.ts).
 */
const ROW_ACTIONS =
  'flex shrink-0 items-center gap-2 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:[.group:focus-within_&]:opacity-100';

export function TagsManager({
  initial,
  title = 'Tags',
}: {
  initial: TagManagerRow[];
  /** The page's h1: "Tags", or the org's Settings > Navigation rename of the
   *  sidebar entry, resolved by the page (PLAN rule 10). */
  title?: string;
}) {
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
      <PageHeader
        title={title}
        subline={
          <span className="block max-w-[640px]">
            Flexible labels you can apply to many items at once. Stack them with categories for
            finer-grained filtering.
          </span>
        }
        primaryAction={
          <Button variant="gradient" onClick={openNew}>
            <Plus className="h-4 w-4" /> New tag
          </Button>
        }
      />

      {initial.length === 0 ? (
        <EmptyState
          icon={TagsIcon}
          title="No tags yet"
          description="Tags add a flexible label layer on top of categories. Apply many tags per item and pull them into bulk actions. Use the New tag button above to add one."
        />
      ) : (
        <div className="border-border bg-card min-w-0 overflow-hidden rounded-lg border">
          <ul className="divide-border divide-y" aria-label="Tags">
            {initial.map((tag) => (
              <li
                key={tag.id}
                data-testid="tag-row"
                className="hover:bg-muted group flex min-h-[52px] items-center gap-3 px-[18px] py-2 transition-colors"
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: tagColor(tag.color) }}
                />
                <button
                  type="button"
                  onClick={() => openEdit(tag)}
                  className="text-foreground hover:text-accent min-w-0 flex-1 rounded-sm text-left text-[13.5px] font-medium transition-colors [overflow-wrap:anywhere]"
                >
                  {tag.name}
                </button>
                <span className="text-muted-foreground shrink-0 font-mono text-[12px] tabular-nums">
                  {tag.usage_count} item{tag.usage_count === 1 ? '' : 's'}
                </span>
                {/* Edit and Delete show on hover with a mouse, and always on
                    touch and for the keyboard (CONFLICTS D18): with a fine
                    pointer they hide until the row is hovered or holds focus. */}
                <div className={ROW_ACTIONS}>
                  <Button variant="ghost" size="sm" onClick={() => openEdit(tag)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteTarget(tag)}
                    aria-label={`Delete ${tag.name}`}
                  >
                    <Trash2 className="text-muted-foreground h-4 w-4" />
                  </Button>
                </div>
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
        color: tagColor(editing?.color),
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
            {errors.name && <p className="text-destructive text-xs">Name is required.</p>}
          </div>
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap items-center gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setValue('color', c)}
                  className="ring-offset-background data-[selected=true]:ring-ring h-7 w-7 rounded-full ring-offset-2 transition-all data-[selected=true]:ring-2"
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
                value={/^#[0-9a-fA-F]{6}$/.test(currentColor) ? currentColor : DEFAULT_COLOR}
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
