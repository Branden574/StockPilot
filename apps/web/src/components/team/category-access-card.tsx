'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { setUserCategoryAccessAction } from '@/server/actions/user-categories';

interface Props {
  targetUserId: string;
  targetUserName: string;
  allCategories: Array<{ id: string; name: string }>;
  initiallyGranted: string[];
}

/**
 * Checkbox grid (the shared Checkbox) for granting a viewer access to
 * specific categories.
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
  const router = useRouter();
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
      // Refresh the server component so `initiallyGranted` reflects
      // the new state if the dialog is closed and reopened.
      router.refresh();
    });
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-foreground text-[13.5px] font-medium">Category access</h3>
        <p className="text-muted-foreground mt-1 text-[12.5px]">
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
        <p className="border-line-strong bg-sunk text-muted-foreground rounded-lg border border-dashed p-3 text-[12px]">
          No categories exist yet. Create some at{' '}
          <span className="font-mono">/dashboard/categories</span> first.
        </p>
      ) : (
        <div className="border-border grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-lg border p-1.5 min-[420px]:grid-cols-2 sm:grid-cols-3">
          {allCategories.map((c) => (
            // The shared Checkbox: one control per category, named by the
            // category's own name, toggling exactly as the native box did.
            <Checkbox
              key={c.id}
              checked={granted.has(c.id)}
              onCheckedChange={() => toggle(c.id)}
              disabled={pending}
              className="hover:bg-muted min-h-9 w-full min-w-0 rounded-md px-2 py-1.5 text-[13.5px]"
            >
              <span className="min-w-0 truncate">{c.name}</span>
            </Checkbox>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-[12px]">
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
