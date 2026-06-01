'use client';

import { RotateCcw } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { setOrderStatusConfigAction } from '@/server/actions/order-status-settings';

import {
  ORDER_STATUS_COLORS,
  ORDER_STATUS_KEYS,
  ORDER_STATUS_LABEL_MAX,
  ORDER_STATUS_META,
  resolveOrderStatusConfig,
  type OrderStatusColor,
  type OrderStatusConfig,
  type OrderStatusKey,
} from '@stockpilot/core';

const COLOR_LABELS: Record<OrderStatusColor, string> = {
  default: 'Primary',
  secondary: 'Neutral',
  destructive: 'Red',
  success: 'Green',
  warning: 'Amber',
  outline: 'Outline',
};

/** One editable row's working state (label + color). */
interface RowState {
  label: string;
  color: OrderStatusColor;
}

export function OrderStatusesEditor({ initialConfig }: { initialConfig: unknown }) {
  // Seed the working rows from the resolved meta (override merged over defaults)
  // so every row shows what the org currently renders.
  const seed = React.useCallback((config: unknown): Record<OrderStatusKey, RowState> => {
    const resolved = resolveOrderStatusConfig(
      config as Parameters<typeof resolveOrderStatusConfig>[0],
    );
    const rows = {} as Record<OrderStatusKey, RowState>;
    for (const key of ORDER_STATUS_KEYS) {
      rows[key] = { label: resolved[key].label, color: resolved[key].color };
    }
    return rows;
  }, []);

  const [rows, setRows] = React.useState<Record<OrderStatusKey, RowState>>(() =>
    seed(initialConfig),
  );
  const [pending, setPending] = React.useState(false);

  function setRow(key: OrderStatusKey, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  /** Build the minimal config: only keys that differ from the canonical default. */
  function buildConfig(): OrderStatusConfig {
    const config: OrderStatusConfig = {};
    for (const key of ORDER_STATUS_KEYS) {
      const row = rows[key];
      const def = ORDER_STATUS_META[key];
      const entry: { label?: string; color?: OrderStatusColor } = {};
      const label = row.label.trim();
      if (label.length > 0 && label !== def.label) entry.label = label;
      if (row.color !== def.color) entry.color = row.color;
      if (entry.label !== undefined || entry.color !== undefined) {
        config[key] = entry;
      }
    }
    return config;
  }

  async function save() {
    // Guard empty labels client-side (the server also rejects them).
    for (const key of ORDER_STATUS_KEYS) {
      if (rows[key].label.trim().length === 0) {
        toast.error('Status labels cannot be empty.');
        return;
      }
    }
    const config = buildConfig();
    setPending(true);
    try {
      // No diffs → clear the override entirely (reset to canonical).
      const payload = Object.keys(config).length === 0 ? null : config;
      const result = await setOrderStatusConfigAction(payload);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success('Order status labels saved.');
    } finally {
      setPending(false);
    }
  }

  async function reset() {
    setPending(true);
    try {
      const result = await setOrderStatusConfigAction(null);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setRows(seed(null));
      toast.success('Order statuses reset to defaults.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <ul className="divide-border divide-y rounded-md border">
        {ORDER_STATUS_KEYS.map((key) => {
          const row = rows[key];
          const def = ORDER_STATUS_META[key];
          const changed = row.label.trim() !== def.label || row.color !== def.color;
          return (
            <li key={key} className="grid items-end gap-3 px-3 py-3 sm:grid-cols-[1fr_10rem_8rem]">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={`label-${key}`} className="flex items-center gap-2">
                  <Badge variant={row.color}>{row.label.trim() || def.label}</Badge>
                  <code className="text-muted-foreground text-xs">{key}</code>
                </Label>
                <Input
                  id={`label-${key}`}
                  value={row.label}
                  maxLength={ORDER_STATUS_LABEL_MAX}
                  disabled={pending}
                  onChange={(e) => setRow(key, { label: e.target.value })}
                  placeholder={def.label}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">Color</Label>
                <Select
                  value={row.color}
                  onValueChange={(v) => setRow(key, { color: v as OrderStatusColor })}
                >
                  <SelectTrigger disabled={pending}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ORDER_STATUS_COLORS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {COLOR_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center pb-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending || !changed}
                  onClick={() => setRow(key, { label: def.label, color: def.color })}
                  aria-label={`Reset ${key} to default`}
                >
                  <RotateCcw className="mr-1 h-3.5 w-3.5" /> Default
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex gap-2">
        <Button onClick={save} disabled={pending}>
          Save changes
        </Button>
        <Button variant="outline" onClick={reset} disabled={pending}>
          Reset all to defaults
        </Button>
      </div>
    </div>
  );
}
