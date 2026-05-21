'use client';

import { History, Loader2, Plus, RotateCcw, Tag, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  archiveCategoryAction,
  createCategoryAction,
  restoreCategoryAction,
  updateCategoryAction,
} from '@/server/actions/categories';

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  supports_sizes: boolean;
}

interface FormValues {
  name: string;
  description: string;
  color: string;
  supportsSizes: boolean;
}

const PRESET_COLORS = ['#6366f1', '#10b981', '#f97316', '#0ea5e9', '#a855f7', '#ec4899', '#64748b', '#eab308'];

export function CategoriesManager({
  initial,
  view = 'active',
  canManage = true,
}: {
  initial: CategoryRow[];
  view?: 'active' | 'archived';
  /**
   * When false, hides the New / Edit / Archive / Restore action buttons
   * so viewers see a read-only list. Server-side actions still throw on
   * direct calls — this is the user-facing surface gate.
   */
  canManage?: boolean;
}) {
  const router = useRouter();
  const isArchivedView = view === 'archived';
  const [editing, setEditing] = React.useState<CategoryRow | null>(null);
  const [open, setOpen] = React.useState(false);
  const [archiveTarget, setArchiveTarget] = React.useState<CategoryRow | null>(null);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [restoreTarget, setRestoreTarget] = React.useState<CategoryRow | null>(null);
  const [restoreBusy, setRestoreBusy] = React.useState(false);

  function openNew() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(row: CategoryRow) {
    setEditing(row);
    setOpen(true);
  }

  async function confirmArchive() {
    if (!archiveTarget) return;
    setArchiveBusy(true);
    const res = await archiveCategoryAction(archiveTarget.id);
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
    const res = await restoreCategoryAction(restoreTarget.id);
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
      <div className="mb-5 flex items-center justify-between gap-2">
        <ArchiveViewToggle view={view} />
        {canManage && !isArchivedView && (
          <Button variant="gradient" onClick={openNew}>
            <Plus className="h-4 w-4" /> New category
          </Button>
        )}
      </div>

      {initial.length === 0 ? (
        isArchivedView ? (
          <EmptyState
            icon={History}
            title="No archived categories"
            description="Categories you archive show up here so you can restore them later."
          />
        ) : (
          <EmptyState
            icon={Tag}
            title="No categories yet"
            description="Group items by type so reports, filters, and dashboards stay readable. Use the New category button above to add one."
          />
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {initial.map((cat) => (
            <div key={cat.id} className="group flex items-start gap-3 rounded-xl border bg-card p-4 transition-shadow hover:shadow-md">
              <span
                aria-hidden
                className="mt-1 h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: cat.color ?? '#94a3b8' }}
              />
              <div className="flex-1 min-w-0">
                {isArchivedView || !canManage ? (
                  <span className="block text-left font-medium">{cat.name}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => openEdit(cat)}
                    className="block text-left font-medium transition-colors hover:text-primary"
                  >
                    {cat.name}
                  </button>
                )}
                {cat.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{cat.description}</p>
                )}
              </div>
              {canManage && (isArchivedView ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRestoreTarget(cat)}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Restore
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => setArchiveTarget(cat)}
                  aria-label={`Archive ${cat.name}`}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              ))}
            </div>
          ))}
        </div>
      )}

      <CategoryDialog open={open} onOpenChange={setOpen} editing={editing} />

      <DestructiveConfirm
        open={archiveTarget !== null}
        onOpenChange={(v) => {
          if (!v) setArchiveTarget(null);
        }}
        title={archiveTarget ? `Archive "${archiveTarget.name}"?` : 'Archive category?'}
        description={
          <>
            The category is hidden from filters and item forms. Items already in this category
            keep their assignment until you move them. You can restore it from the{' '}
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
        title={restoreTarget ? `Restore "${restoreTarget.name}"?` : 'Restore category?'}
        description="This brings the category back into the active list."
        confirmLabel="Restore"
        tone="primary"
        pending={restoreBusy}
        onConfirm={confirmRestore}
      />
    </>
  );
}

function CategoryDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: CategoryRow | null;
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
      description: '',
      color: '#6366f1',
      supportsSizes: false,
    },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? '',
        description: editing?.description ?? '',
        color: editing?.color ?? '#6366f1',
        supportsSizes: editing?.supports_sizes ?? false,
      });
    }
  }, [open, editing, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      description: values.description || undefined,
      color: values.color || undefined,
      supportsSizes: values.supportsSizes,
    };
    const res = editing
      ? await updateCategoryAction(editing.id, payload)
      : await createCategoryAction(payload);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(editing ? 'Category updated.' : 'Category created.');
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit category' : 'New category'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="Electronics" {...register('name', { required: true })} />
            {errors.name && <p className="text-xs text-destructive">Name is required.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">
              Description
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea id="description" rows={2} {...register('description')} />
          </div>
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => setValue('color', c)}
                  className="h-7 w-7 rounded-full ring-offset-2 ring-offset-background transition-all data-[selected=true]:ring-2 data-[selected=true]:ring-ring"
                  data-selected={watch('color') === c}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          <label
            htmlFor="cat-supports-sizes"
            className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer"
          >
            <input
              id="cat-supports-sizes"
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              {...register('supportsSizes')}
            />
            <div className="space-y-0.5">
              <span className="block text-sm font-medium">
                Has size variants (S, M, L, XL…)
              </span>
              <p className="text-muted-foreground text-xs">
                When on, items in this category get a Sizes selector on the
                item form, and saving creates one variant per chosen size.
              </p>
            </div>
          </label>
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
                'Create category'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Required by Radix; suppress unused warnings on DialogTrigger import.
void DialogTrigger;
