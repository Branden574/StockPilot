'use client';

import { Loader2, Plus, Tag, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Button } from '@/components/ui/button';
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
  updateCategoryAction,
} from '@/server/actions/categories';

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
}

interface FormValues {
  name: string;
  description: string;
  color: string;
}

const PRESET_COLORS = ['#6366f1', '#10b981', '#f97316', '#0ea5e9', '#a855f7', '#ec4899', '#64748b', '#eab308'];

export function CategoriesManager({ initial }: { initial: CategoryRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<CategoryRow | null>(null);
  const [open, setOpen] = React.useState(false);

  function openNew() {
    setEditing(null);
    setOpen(true);
  }
  function openEdit(row: CategoryRow) {
    setEditing(row);
    setOpen(true);
  }

  return (
    <>
      <div className="flex items-center justify-end">
        <Button variant="gradient" onClick={openNew}>
          <Plus className="h-4 w-4" /> New category
        </Button>
      </div>

      {initial.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No categories yet"
          description="Group items by type so reports and filters make sense."
          action={
            <Button variant="gradient" onClick={openNew}>
              Add a category
            </Button>
          }
        />
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
                <button
                  type="button"
                  onClick={() => openEdit(cat)}
                  className="block text-left font-medium transition-colors hover:text-primary"
                >
                  {cat.name}
                </button>
                {cat.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{cat.description}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="opacity-0 transition-opacity group-hover:opacity-100"
                onClick={async () => {
                  if (!confirm(`Archive "${cat.name}"?`)) return;
                  const res = await archiveCategoryAction(cat.id);
                  if (!res.ok) toast.error(res.error.message);
                  else {
                    toast.success('Category archived');
                    router.refresh();
                  }
                }}
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <CategoryDialog open={open} onOpenChange={setOpen} editing={editing} />
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
    defaultValues: { name: '', description: '', color: '#6366f1' },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? '',
        description: editing?.description ?? '',
        color: editing?.color ?? '#6366f1',
      });
    }
  }, [open, editing, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      description: values.description || undefined,
      color: values.color || undefined,
    };
    const res = editing
      ? await updateCategoryAction(editing.id, payload)
      : await createCategoryAction(payload);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(editing ? 'Category updated' : 'Category created');
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
            {errors.name && <p className="text-xs text-destructive">Name is required</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
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

// Required by Radix; suppress unused warnings on DialogTrigger import.
void DialogTrigger;
