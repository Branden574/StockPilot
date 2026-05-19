'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { setUserCategoryAccessAction } from '@/server/actions/user-categories';

interface Props {
  targetUserId: string;
  targetUserName: string;
  allCategories: Array<{ id: string; name: string }>;
  initiallyGranted: string[];
}

/**
 * Checkbox grid for granting a viewer access to specific categories.
 * Mounts inside the existing user-edit dialog in team-manager.
 * Only renders when the target user's role is 'viewer' — the parent
 * gates this; managers and above always see every category and the
 * control would be meaningless for them.
 *
 * No grants checked = unrestricted. Saving with zero boxes removes
 * all restrictions for the target user. The line below the grid
 * spells this out so admins don't get confused.
 */
export function CategoryAccessCard({
  targetUserId,
  targetUserName,
  allCategories,
  initiallyGranted,
}: Props) {
  const [granted, setGranted] = useState<Set<string>>(new Set(initiallyGranted));
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setGranted(new Set(allCategories.map((c) => c.id)));
  }
  function clearAll() {
    setGranted(new Set());
  }

  function save() {
    startTransition(async () => {
      const result = await setUserCategoryAccessAction({
        userId: targetUserId,
        categoryIds: [...granted],
      });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      const n = result.data.count;
      toast.success(
        n === 0
          ? `${targetUserName} can now see all categories.`
          : `${targetUserName} can now see ${n} categor${n === 1 ? 'y' : 'ies'}.`,
      );
    });
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Category access</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Pick which categories <span className="text-foreground">{targetUserName}</span>{' '}
          can see. Leave empty for unrestricted access (sees everything
          in their warehouses).
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={selectAll} disabled={pending}>
          Select all
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={clearAll} disabled={pending}>
          Clear all
        </Button>
      </div>

      {allCategories.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-3 text-xs">
          No categories exist yet. Create some at{' '}
          <span className="font-mono">/dashboard/categories</span> first.
        </p>
      ) : (
        <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto rounded-md border p-2 sm:grid-cols-3">
          {allCategories.map((c) => (
            <label
              key={c.id}
              className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                checked={granted.has(c.id)}
                onChange={() => toggle(c.id)}
                disabled={pending}
                className="cursor-pointer"
              />
              <span className="truncate">{c.name}</span>
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-[11px]">
          {granted.size === 0
            ? 'No categories selected — sees everything.'
            : `${granted.size} categor${granted.size === 1 ? 'y' : 'ies'} selected.`}
        </p>
        <Button onClick={save} disabled={pending} size="sm">
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </section>
  );
}
