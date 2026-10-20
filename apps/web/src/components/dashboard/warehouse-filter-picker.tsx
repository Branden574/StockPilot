'use client';

import { Check, ChevronDown, Warehouse } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setWarehouseFilterAction } from '@/server/actions/warehouse-filter';

interface WarehouseFilterPickerProps {
  warehouses: Array<{ id: string; name: string }>;
  activeId: string | null;
  warehouseLabel: string;
  /**
   * The org's plural term (terminology.warehouse_plural: "Warehouses",
   * "Backrooms", "Campuses"). Omitted: the singular plus "s", as before.
   */
  warehousePluralLabel?: string;
}

/** "All warehouses": the org's own plural, not the singular with an "s" glued on. */
export function allWarehousesLabel(warehouseLabel: string, warehousePluralLabel?: string): string {
  const plural = warehousePluralLabel?.trim() || `${warehouseLabel}s`;
  return `All ${plural.toLowerCase()}`;
}

export function WarehouseFilterPicker({
  warehouses,
  activeId,
  warehouseLabel,
  warehousePluralLabel,
}: WarehouseFilterPickerProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const active = warehouses.find((w) => w.id === activeId) ?? null;
  const allLabel = allWarehousesLabel(warehouseLabel, warehousePluralLabel);

  function pick(id: string | null) {
    startTransition(async () => {
      const res = await setWarehouseFilterAction(id);
      if (!res.ok) {
        toast.error("Couldn't change the warehouse filter. Try again.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="border-border bg-card flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md border px-2.5 text-[13px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)] disabled:opacity-60"
        disabled={pending}
        aria-label={`Filter by ${warehouseLabel.toLowerCase()}`}
      >
        <Warehouse aria-hidden strokeWidth={1.6} className="size-3.5 shrink-0" />
        {/* min-w-0: in a narrow top bar the name truncates rather than
            pushing the buttons after it past the edge. */}
        <span className="min-w-0 max-w-[160px] truncate">{active ? active.name : allLabel}</span>
        <ChevronDown
          aria-hidden
          strokeWidth={2}
          className="text-muted-foreground size-3 shrink-0"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
          {warehouseLabel} filter
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => pick(null)}>
          {active === null ? (
            <Check aria-hidden className="mr-2 size-3.5" />
          ) : (
            <span aria-hidden className="mr-2 inline-block size-3.5" />
          )}
          {allLabel}
        </DropdownMenuItem>
        {warehouses.length > 0 && <DropdownMenuSeparator />}
        {warehouses.map((w) => (
          <DropdownMenuItem key={w.id} onClick={() => pick(w.id)}>
            {activeId === w.id ? (
              <Check aria-hidden className="mr-2 size-3.5" />
            ) : (
              <span aria-hidden className="mr-2 inline-block size-3.5" />
            )}
            <span className="truncate">{w.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
