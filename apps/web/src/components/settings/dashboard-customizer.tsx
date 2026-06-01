'use client';

import { ArrowDown, ArrowUp, Eye, EyeOff } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { setDashboardLayoutAction } from '@/server/actions/dashboard-settings';

import { type DashboardLayout } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// Types passed from the server page.
// ---------------------------------------------------------------------------

interface WidgetDef {
  id: string;
  title: string;
}

interface DashboardCustomizerProps {
  /** The full widget catalog (DASHBOARD_WIDGETS), in canonical order. */
  widgets: WidgetDef[];
  /** Currently-saved layout (v1) or null. */
  initialLayout: DashboardLayout | null;
}

// ---------------------------------------------------------------------------
// Local editor state. An ordered list of widgets (matching what
// `resolveDashboardWidgets` honors): order = array order, visibility = !hidden.
// We serialize back to a DashboardLayout payload on save.
// ---------------------------------------------------------------------------

interface EditableWidget {
  id: string;
  title: string;
  hidden: boolean;
}

/**
 * Build the editor's ordered widget list from the catalog + saved layout. The
 * ordering rule mirrors `resolveDashboardWidgets`:
 *   - widgets listed in the saved layout come first, in saved order, carrying
 *     their saved `hidden` flag (unknown ids in the layout are dropped — they
 *     aren't in the catalog);
 *   - any catalog widget missing from the layout is appended at the end,
 *     visible (so a newly-shipped widget always shows up).
 * A null/garbage layout => catalog order, all visible.
 */
function buildInitialState(
  widgets: WidgetDef[],
  layout: DashboardLayout | null,
): EditableWidget[] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const out: EditableWidget[] = [];
  const placed = new Set<string>();

  const layoutWidgets =
    layout && layout.v === 1 && Array.isArray(layout.widgets) ? layout.widgets : [];

  for (const w of layoutWidgets) {
    if (!w || typeof w.id !== 'string') continue;
    const def = byId.get(w.id);
    if (!def) continue; // drop unknown / retired ids
    if (placed.has(def.id)) continue; // dedupe
    placed.add(def.id);
    out.push({ id: def.id, title: def.title, hidden: w.hidden === true });
  }

  // Append catalog widgets missing from the saved layout, visible, in order.
  for (const def of widgets) {
    if (placed.has(def.id)) continue;
    out.push({ id: def.id, title: def.title, hidden: false });
  }

  return out;
}

export function DashboardCustomizer({ widgets, initialLayout }: DashboardCustomizerProps) {
  const [items, setItems] = React.useState<EditableWidget[]>(() =>
    buildInitialState(widgets, initialLayout),
  );
  const [saving, startTransition] = React.useTransition();

  function toggleHidden(id: string) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, hidden: !it.hidden } : it)));
  }

  function move(index: number, dir: -1 | 1) {
    setItems((prev) => {
      const arr = [...prev];
      const target = index + dir;
      if (target < 0 || target >= arr.length) return prev;
      const a = arr[index];
      const b = arr[target];
      if (!a || !b) return prev;
      arr[index] = b;
      arr[target] = a;
      return arr;
    });
  }

  /**
   * Serialize the editor list into a DashboardLayout payload. We always emit
   * every widget (carrying its `hidden` flag) so order AND visibility round-trip
   * exactly through `resolveDashboardWidgets` — what you see here is what the
   * dashboard renders.
   */
  function buildLayout(): DashboardLayout {
    return {
      v: 1,
      widgets: items.map((it) => (it.hidden ? { id: it.id, hidden: true } : { id: it.id })),
    };
  }

  function save() {
    const layout = buildLayout();
    startTransition(async () => {
      const res = await setDashboardLayoutAction(layout);
      if (res.ok) {
        toast.success('Dashboard saved.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function reset() {
    startTransition(async () => {
      const res = await setDashboardLayoutAction(null);
      if (res.ok) {
        setItems(buildInitialState(widgets, null));
        toast.success('Dashboard reset to default.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="divide-border divide-y rounded-md border">
          {items.map((it, idx) => (
            <div
              key={it.id}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5',
                it.hidden && 'opacity-50',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{it.title}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Move ${it.title} up`}
                  disabled={idx === 0 || saving}
                  onClick={() => move(idx, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Move ${it.title} down`}
                  disabled={idx === items.length - 1 || saving}
                  onClick={() => move(idx, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={it.hidden ? `Show ${it.title}` : `Hide ${it.title}`}
                  aria-pressed={it.hidden}
                  disabled={saving}
                  onClick={() => toggleHidden(it.id)}
                >
                  {it.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="outline" onClick={reset} disabled={saving}>
          Reset to default
        </Button>
      </div>
    </div>
  );
}
