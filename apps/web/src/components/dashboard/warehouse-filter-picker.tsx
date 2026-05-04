'use client';

import { Check, ChevronsUpDown, Warehouse } from 'lucide-react';
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
}

export function WarehouseFilterPicker({
  warehouses,
  activeId,
  warehouseLabel,
}: WarehouseFilterPickerProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const active = warehouses.find((w) => w.id === activeId) ?? null;

  function pick(id: string | null) {
    startTransition(async () => {
      const res = await setWarehouseFilterAction(id);
      if (!res.ok) {
        toast.error('Could not change filter');
        return;
      }
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="border-border bg-card flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] text-[var(--ed-ink-3)] shadow-[0_1px_0_rgba(14,15,13,0.03)] transition-colors hover:border-[var(--ed-line-strong)] disabled:opacity-60"
        disabled={pending}
        aria-label={`Filter by ${warehouseLabel.toLowerCase()}`}
      >
        <Warehouse className="h-3 w-3" />
        <span className="max-w-[160px] truncate">
          {active ? active.name : `All ${warehouseLabel.toLowerCase()}s`}
        </span>
        <ChevronsUpDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {warehouseLabel} filter
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => pick(null)}>
          {active === null ? <Check className="mr-2 h-3.5 w-3.5" /> : <span className="mr-2 inline-block h-3.5 w-3.5" />}
          All {warehouseLabel.toLowerCase()}s
        </DropdownMenuItem>
        {warehouses.length > 0 && <DropdownMenuSeparator />}
        {warehouses.map((w) => (
          <DropdownMenuItem key={w.id} onClick={() => pick(w.id)}>
            {activeId === w.id ? (
              <Check className="mr-2 h-3.5 w-3.5" />
            ) : (
              <span className="mr-2 inline-block h-3.5 w-3.5" />
            )}
            <span className="truncate">{w.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
