'use client';

import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  createRecurringTemplateAction,
  deleteRecurringTemplateAction,
  setRecurringTemplateEnabledAction,
  updateRecurringTemplateAction,
} from '@/server/actions/recurring-pos';
import { formatCurrency, formatRelative } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RecurringTemplateRow {
  id: string;
  name: string;
  supplier_id: string | null;
  destination_location_id: string | null;
  enabled: boolean;
  cadence: string;
  custom_days: number | null;
  send_mode: string;
  max_auto_send_cents: number | null;
  line_items: unknown;
  notes: string | null;
  last_run_at: string | null;
  next_run_at: string;
}

interface ItemOption {
  id: string;
  name: string;
  sku: string;
  unit_cost: number;
}

interface SupplierOption {
  id: string;
  name: string;
}

interface LocationOption {
  id: string;
  name: string;
}

interface Line {
  itemId: string;
  quantityOrdered: number;
  unitCost: number;
}

type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'custom';
type SendMode = 'draft' | 'send';

const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  custom: 'Custom interval',
};

interface Props {
  initial: RecurringTemplateRow[];
  items: ItemOption[];
  suppliers: SupplierOption[];
  locations: LocationOption[];
  /** Whether the org is entitled to recurring POs (Pro+). */
  entitled: boolean;
  /** Pre-filled seed from "Make recurring" on the PO detail page. */
  seed?: {
    supplierId: string | null;
    destinationLocationId: string | null;
    lineItems: Array<{ itemId: string; quantityOrdered: number; unitCost: number }>;
  } | null;
}

// ── Template form ────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  supplierId: string;
  locationId: string;
  cadence: Cadence;
  customDays: number;
  sendMode: SendMode;
  capDollars: string;
  lines: Line[];
  notes: string;
}

function defaultForm(
  seed?: Props['seed'],
  templates?: RecurringTemplateRow[],
  editId?: string,
): FormState {
  // If editing an existing template, find it.
  if (editId && templates) {
    const t = templates.find((tpl) => tpl.id === editId);
    if (t) {
      const rawLines = Array.isArray(t.line_items) ? (t.line_items as Line[]) : [];
      return {
        name: t.name,
        supplierId: t.supplier_id ?? '',
        locationId: t.destination_location_id ?? '',
        cadence: (t.cadence as Cadence) || 'monthly',
        customDays: t.custom_days ?? 30,
        sendMode: (t.send_mode as SendMode) || 'draft',
        capDollars: t.max_auto_send_cents != null ? (t.max_auto_send_cents / 100).toFixed(2) : '',
        lines: rawLines,
        notes: t.notes ?? '',
      };
    }
  }
  // If a seed was provided (from "Make recurring"), pre-fill supplier + lines.
  if (seed) {
    return {
      name: '',
      supplierId: seed.supplierId ?? '',
      locationId: seed.destinationLocationId ?? '',
      cadence: 'monthly',
      customDays: 30,
      sendMode: 'draft',
      capDollars: '',
      lines: seed.lineItems,
      notes: '',
    };
  }
  return {
    name: '',
    supplierId: '',
    locationId: '',
    cadence: 'monthly',
    customDays: 30,
    sendMode: 'draft',
    capDollars: '',
    lines: [],
    notes: '',
  };
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function RecurringTemplatesPanel({
  initial,
  items,
  suppliers,
  locations,
  entitled,
  seed,
}: Props) {
  const [templates, setTemplates] = React.useState<RecurringTemplateRow[]>(initial);
  // null = list view; 'new' = new form; '<id>' = editing that template
  const [formMode, setFormMode] = React.useState<null | 'new' | string>(
    seed ? 'new' : null,
  );
  const [form, setForm] = React.useState<FormState>(() => defaultForm(seed));
  const [submitting, setSubmitting] = React.useState(false);
  const [toggling, setToggling] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  // Sync external initial list if the server re-renders the page.
  React.useEffect(() => {
    setTemplates(initial);
  }, [initial]);

  // ── upgrade gate ──────────────────────────────────────────────────────────

  if (!entitled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="h-4 w-4" /> Recurring purchase orders
          </CardTitle>
          <CardDescription>
            Auto-create purchase orders on a schedule — weekly, monthly, quarterly, or custom.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            Recurring purchase orders is a{' '}
            <span className="font-medium text-foreground">Pro</span> feature. Upgrade to Pro or
            above to use it.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function patchForm(patch: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function addLine() {
    patchForm({ lines: [...form.lines, { itemId: '', quantityOrdered: 1, unitCost: 0 }] });
  }

  function removeLine(idx: number) {
    patchForm({ lines: form.lines.filter((_, i) => i !== idx) });
  }

  function updateLine(idx: number, patch: Partial<Line>) {
    patchForm({
      lines: form.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    });
  }

  function openNew() {
    setForm(defaultForm(null));
    setFormMode('new');
  }

  function openEdit(tpl: RecurringTemplateRow) {
    setForm(defaultForm(null, templates, tpl.id));
    setFormMode(tpl.id);
  }

  function cancelForm() {
    setFormMode(null);
  }

  // ── toggle enabled ────────────────────────────────────────────────────────

  async function toggleEnabled(tpl: RecurringTemplateRow) {
    setToggling(tpl.id);
    const next = !tpl.enabled;
    const res = await setRecurringTemplateEnabledAction(tpl.id, next);
    setToggling(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setTemplates((prev) =>
      prev.map((t) => (t.id === tpl.id ? { ...t, enabled: next } : t)),
    );
    toast.success(next ? 'Template enabled.' : 'Template disabled.');
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async function deleteTemplate(id: string) {
    if (!confirm('Delete this recurring template? This cannot be undone.')) return;
    setDeleting(id);
    const res = await deleteRecurringTemplateAction(id);
    setDeleting(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setTemplates((prev) => prev.filter((t) => t.id !== id));
    toast.success('Template deleted.');
  }

  // ── save (create or update) ───────────────────────────────────────────────

  async function saveForm() {
    if (!form.name.trim()) {
      toast.error('Template name is required.');
      return;
    }
    if (form.lines.length === 0) {
      toast.error('Add at least one line item.');
      return;
    }
    if (form.lines.some((l) => !l.itemId || l.quantityOrdered <= 0)) {
      toast.error('Every line needs an item and a positive quantity.');
      return;
    }
    if (form.cadence === 'custom' && (!form.customDays || form.customDays < 1)) {
      toast.error('Enter a valid interval (1–365 days).');
      return;
    }
    const capCents =
      form.sendMode === 'send' && form.capDollars.trim() !== ''
        ? Math.round(parseFloat(form.capDollars) * 100)
        : null;
    if (capCents != null && !Number.isFinite(capCents)) {
      toast.error('Enter a valid auto-send cap, or leave it blank.');
      return;
    }

    const input = {
      name: form.name.trim(),
      supplierId: form.supplierId || null,
      destinationLocationId: form.locationId || null,
      cadence: form.cadence,
      customDays: form.cadence === 'custom' ? form.customDays : null,
      sendMode: form.sendMode,
      maxAutoSendCents: capCents,
      lineItems: form.lines,
      notes: form.notes.trim() || null,
    };

    setSubmitting(true);
    const isEdit = formMode !== null && formMode !== 'new';
    const res = isEdit
      ? await updateRecurringTemplateAction(formMode!, input)
      : await createRecurringTemplateAction(input);
    setSubmitting(false);

    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }

    toast.success(isEdit ? 'Template updated.' : 'Recurring template created.');
    setFormMode(null);

    // Optimistic update: refresh list from server on next render via revalidatePath.
    // For immediate UI feedback, add/update in local state.
    if (isEdit) {
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === formMode
            ? {
                ...t,
                name: input.name,
                supplier_id: input.supplierId,
                destination_location_id: input.destinationLocationId,
                cadence: input.cadence,
                custom_days: input.customDays ?? null,
                send_mode: input.sendMode,
                max_auto_send_cents: input.maxAutoSendCents ?? null,
                line_items: input.lineItems,
                notes: input.notes ?? null,
              }
            : t,
        ),
      );
    } else {
      // After create, let server revalidatePath push the updated list.
      // Temporarily show the template in the list with placeholder dates.
      const id = (res as { ok: true; data: { id: string } }).data.id;
      const now = new Date().toISOString();
      setTemplates((prev) => [
        ...prev,
        {
          id,
          name: input.name,
          supplier_id: input.supplierId,
          destination_location_id: input.destinationLocationId,
          enabled: true,
          cadence: input.cadence,
          custom_days: input.customDays ?? null,
          send_mode: input.sendMode,
          max_auto_send_cents: input.maxAutoSendCents ?? null,
          line_items: input.lineItems,
          notes: input.notes ?? null,
          last_run_at: null,
          next_run_at: now,
          created_at: now,
          updated_at: now,
        } as RecurringTemplateRow,
      ]);
    }
  }

  const total = form.lines.reduce((s, l) => s + l.quantityOrdered * l.unitCost, 0);
  const isFormOpen = formMode !== null;

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="h-4 w-4" /> Recurring purchase orders
            </CardTitle>
            <CardDescription className="mt-1">
              Templates that create a PO automatically on a cadence. Draft by default; opt-in
              auto-send requires a $ cap and stays within your PO approval threshold.
            </CardDescription>
          </div>
          {!isFormOpen && (
            <Button size="sm" variant="outline" onClick={openNew}>
              <Plus className="h-4 w-4" /> New template
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Template list ── */}
        {!isFormOpen && (
          <>
            {templates.length === 0 ? (
              <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                No recurring templates yet. Create one to start auto-generating purchase orders
                on a schedule.
              </div>
            ) : (
              <div className="divide-y rounded-md border">
                {templates.map((tpl) => {
                  const supplier = suppliers.find((s) => s.id === tpl.supplier_id);
                  const isBusy = toggling === tpl.id || deleting === tpl.id;
                  const rawLines = Array.isArray(tpl.line_items)
                    ? (tpl.line_items as Array<{ itemId: string; quantityOrdered: number; unitCost: number }>)
                    : [];
                  const tplTotal = rawLines.reduce(
                    (s, l) => s + l.quantityOrdered * l.unitCost,
                    0,
                  );
                  return (
                    <div
                      key={tpl.id}
                      className="flex items-start justify-between gap-3 p-3"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <input
                          type="checkbox"
                          aria-label={tpl.enabled ? 'Disable template' : 'Enable template'}
                          checked={tpl.enabled}
                          disabled={isBusy}
                          onChange={() => toggleEnabled(tpl)}
                          className="mt-1 h-4 w-4 shrink-0 cursor-pointer"
                          data-testid={`toggle-${tpl.id}`}
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-sm">{tpl.name}</p>
                          <p className="text-muted-foreground text-xs">
                            {supplier?.name ?? 'No supplier'} ·{' '}
                            {CADENCE_LABELS[tpl.cadence as Cadence] ?? tpl.cadence}
                            {tpl.cadence === 'custom' && tpl.custom_days
                              ? ` (${tpl.custom_days}d)`
                              : ''}
                            {' · '}
                            {tpl.send_mode === 'send' ? 'Auto-send' : 'Draft'}{' '}
                            {tpl.max_auto_send_cents != null
                              ? `(cap ${formatCurrency(tpl.max_auto_send_cents / 100)})`
                              : ''}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {rawLines.length} line{rawLines.length !== 1 ? 's' : ''} ·{' '}
                            {formatCurrency(tplTotal)} · next{' '}
                            {formatRelative(tpl.next_run_at)}
                            {tpl.last_run_at ? ` · last ran ${formatRelative(tpl.last_run_at)}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(tpl)}
                          disabled={isBusy}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteTemplate(tpl.id)}
                          disabled={isBusy}
                          aria-label="Delete template"
                        >
                          {deleting === tpl.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4 text-destructive" />
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ── Create / edit form ── */}
        {isFormOpen && (
          <div className="space-y-5 rounded-md border p-4">
            <h3 className="font-medium text-sm">
              {formMode === 'new' ? 'New recurring template' : 'Edit template'}
            </h3>

            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="rpt-name">Template name</Label>
              <Input
                id="rpt-name"
                placeholder="e.g. Weekly office supplies"
                value={form.name}
                onChange={(e) => patchForm({ name: e.target.value })}
                disabled={submitting}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Supplier */}
              <div className="space-y-1.5">
                <Label>
                  Supplier
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={form.supplierId || '__none'}
                  onValueChange={(v) => patchForm({ supplierId: v === '__none' ? '' : v })}
                  disabled={submitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No supplier" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No supplier</SelectItem>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Destination */}
              <div className="space-y-1.5">
                <Label>
                  Destination location
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={form.locationId || '__none'}
                  onValueChange={(v) => patchForm({ locationId: v === '__none' ? '' : v })}
                  disabled={submitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">None</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Cadence */}
              <div className="space-y-1.5">
                <Label htmlFor="rpt-cadence">Cadence</Label>
                <Select
                  value={form.cadence}
                  onValueChange={(v) => patchForm({ cadence: v as Cadence })}
                  disabled={submitting}
                >
                  <SelectTrigger id="rpt-cadence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(CADENCE_LABELS) as [Cadence, string][]).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Custom days — shown only when cadence='custom' */}
              {form.cadence === 'custom' && (
                <div className="space-y-1.5">
                  <Label htmlFor="rpt-custom-days">Interval (days, 1–365)</Label>
                  <Input
                    id="rpt-custom-days"
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={form.customDays}
                    onChange={(e) => patchForm({ customDays: parseInt(e.target.value) || 1 })}
                    disabled={submitting}
                  />
                </div>
              )}
            </div>

            {/* Send mode */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rpt-send-mode">When the PO is created</Label>
                <Select
                  value={form.sendMode}
                  onValueChange={(v) => patchForm({ sendMode: v as SendMode })}
                  disabled={submitting}
                >
                  <SelectTrigger id="rpt-send-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Create a draft PO for review</SelectItem>
                    <SelectItem value="send">Auto-send to supplier</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Auto-send respects your PO approval threshold. Without a cap, it falls back to
                  draft.
                </p>
              </div>

              {form.sendMode === 'send' && (
                <div className="space-y-1.5">
                  <Label htmlFor="rpt-cap">Auto-send cap ($, optional)</Label>
                  <Input
                    id="rpt-cap"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="e.g. 2000.00"
                    value={form.capDollars}
                    onChange={(e) => patchForm({ capDollars: e.target.value })}
                    disabled={submitting}
                  />
                  <p className="text-muted-foreground text-xs">
                    POs above this cap are drafted for review instead of auto-sent.
                  </p>
                </div>
              )}
            </div>

            {/* Line items (reuses same pattern as PoForm) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Line items</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addLine}
                  disabled={submitting}
                >
                  <Plus className="h-4 w-4" /> Add line
                </Button>
              </div>
              {form.lines.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No lines yet. Click &quot;Add line&quot; to start.
                </div>
              ) : (
                <div className="space-y-2">
                  {form.lines.map((line, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2 rounded-md border bg-card p-3"
                    >
                      <div className="col-span-5 space-y-1">
                        <Label className="text-[11px] text-muted-foreground">Item</Label>
                        <Select
                          value={line.itemId || '__pick'}
                          onValueChange={(v) => {
                            const picked = items.find((i) => i.id === v);
                            updateLine(idx, {
                              itemId: v,
                              unitCost: picked?.unit_cost ?? line.unitCost,
                            });
                          }}
                          disabled={submitting}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Pick an item" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__pick" disabled>
                              Pick an item
                            </SelectItem>
                            {items.map((i) => (
                              <SelectItem key={i.id} value={i.id}>
                                {i.name} —{' '}
                                <span className="font-mono text-xs">{i.sku}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-[11px] text-muted-foreground">Qty</Label>
                        <BlankZeroNumberInput
                          min={1}
                          step={1}
                          value={line.quantityOrdered}
                          onValueChange={(n) => updateLine(idx, { quantityOrdered: n })}
                          placeholder="Qty"
                          disabled={submitting}
                        />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-[11px] text-muted-foreground">Unit cost</Label>
                        <BlankZeroNumberInput
                          min={0}
                          step={0.01}
                          value={line.unitCost}
                          onValueChange={(n) => updateLine(idx, { unitCost: n })}
                          placeholder="0.00"
                          disabled={submitting}
                        />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-[11px] text-muted-foreground">Subtotal</Label>
                        <p className="px-2 py-2 text-sm tabular-nums">
                          {formatCurrency(line.quantityOrdered * line.unitCost)}
                        </p>
                      </div>
                      <div className="col-span-1 flex items-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeLine(idx)}
                          disabled={submitting}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {form.lines.length > 0 && (
                    <div className="flex justify-end pt-2 text-sm">
                      <span className="text-muted-foreground">Total: </span>
                      <span className="ml-2 font-semibold tabular-nums">
                        {formatCurrency(total)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label>
                Notes
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => patchForm({ notes: e.target.value })}
                disabled={submitting}
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={cancelForm} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="gradient"
                onClick={saveForm}
                disabled={submitting || form.lines.length === 0}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : formMode === 'new' ? (
                  'Create template'
                ) : (
                  'Save changes'
                )}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
