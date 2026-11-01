'use client';

import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
import { StatePanel } from '@/components/patterns/state-panel';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
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
import type { RecurringPoSeed } from '@/lib/purchase-orders/recurring-seed';
import {
  unofferedDestinationNote as unofferedDestinationNoteFor,
  unofferedSupplierNote,
  type UnofferedDestination,
  type UnofferedSupplier,
} from '@/lib/purchase-orders/unoffered-choice';
import { useUnsavedWork } from '@/lib/unsaved-work';
import { cn, formatCurrency, formatRelative } from '@/lib/utils';

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

/**
 * The label of an item a saved template line points at that `items` (the
 * picker's list: active, not deleted, not a kit) does not hold: a deleted
 * item, a kit's pre-assembled stock, an archived item. The page resolves
 * them by id, so the line says what it is instead of rendering blank; a
 * template holding a deleted item or a kit is refused on save by that
 * item's name, and this is how the buyer finds the line to remove.
 */
export interface RecurringLineLabel {
  id: string;
  name: string;
  sku: string;
  deleted: boolean;
  kitStock: boolean;
}

function unlistedLineLabel(label: RecurringLineLabel | undefined): string {
  if (!label) return 'Item not available';
  const prefix = label.deleted ? 'Deleted: ' : label.kitStock ? 'Pre-assembled kit: ' : '';
  return `${prefix}${label.name} (${label.sku})`;
}

interface SupplierOption {
  id: string;
  name: string;
}

interface LocationOption {
  id: string;
  name: string;
}

/**
 * Where the purchase order Make recurring came from (?from=) went, as the
 * page read it on the server: that purchase order's destination and the
 * location's name and deleted state, in the caller's organization. Null when
 * the page was not opened from a purchase order, or the read failed.
 */
export interface RecurringSeedDestination {
  /** The purchase order's destination; null when it has none. */
  locationId: string | null;
  /** The location's name; null when it could not be read. */
  name: string | null;
  /** The location was deleted. */
  deleted: boolean;
}

/** Why the create form did not keep the destination Make recurring brought over. */
function unofferedDestinationNote(fromPo: RecurringSeedDestination | null | undefined): string {
  if (fromPo?.deleted) {
    return 'This purchase order went to a location that was deleted, so choose a destination.';
  }
  if (fromPo?.name) {
    return `This purchase order went to "${fromPo.name}", which is not a site you can pick here, so choose a destination.`;
  }
  return "This purchase order went to a location you can't pick here, so choose a destination.";
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
  /** Labels for items saved template lines point at that `items` lacks. */
  lineLabels?: RecurringLineLabel[];
  /**
   * Pre-filled seed from "Make recurring" on the PO detail page: the create
   * form opens filled in with it. Read ONCE, when the panel mounts; a seed
   * that arrives later is applied by remounting the panel with a new `key`
   * (RecurringTemplatesSeedLoader does).
   */
  seed?: RecurringPoSeed | null;
  /**
   * Where the purchase order `seed` came from went, as the server read it.
   * It decides the seeded destination (see seededForm); read with `seed`.
   */
  seedDestination?: RecurringSeedDestination | null;
  /**
   * The destinations, by location id, that templates hold and `locations`
   * does not offer (deleted since, a staging area, ...), as the page read
   * them (small fixes slice 8). The form keeps none of them and names each;
   * the list says when a template creates no purchase order because of one.
   */
  unofferedDestinations?: Record<string, UnofferedDestination>;
  /**
   * The suppliers, by id, that templates or the Make recurring purchase
   * order hold and `suppliers` does not offer (archived), as the page read
   * them. The form keeps none of them and names each; the list names them.
   */
  unofferedSuppliers?: Record<string, UnofferedSupplier>;
}

/** What the form needs to judge a template's or a seed's values. */
interface FormChoices {
  locations: LocationOption[];
  suppliers: SupplierOption[];
  unofferedDestinations: Record<string, UnofferedDestination>;
  unofferedSuppliers: Record<string, UnofferedSupplier>;
}

/**
 * A template's supplier and destination as the form may hold them: kept when
 * the selects offer them; otherwise none, with a note naming what the
 * template holds (small fixes slice 8). Radix shows a value no option has as
 * a blank box while the save sends it, so a destination deleted after the
 * template was saved, or an archived supplier, read blank in Edit and went
 * back unseen (the deleted destination then refused by a name the form
 * never showed).
 */
function templateChoices(
  t: Pick<RecurringTemplateRow, 'supplier_id' | 'destination_location_id'>,
  choices: FormChoices,
): Pick<FormState, 'supplierId' | 'locationId' | 'supplierNote' | 'destinationNote'> {
  const supplierId = t.supplier_id ?? '';
  const locationId = t.destination_location_id ?? '';
  const supplierOffered = !supplierId || choices.suppliers.some((s) => s.id === supplierId);
  const locationOffered = !locationId || choices.locations.some((l) => l.id === locationId);
  return {
    supplierId: supplierOffered ? supplierId : '',
    locationId: locationOffered ? locationId : '',
    supplierNote: supplierOffered
      ? null
      : unofferedSupplierNote('template', choices.unofferedSuppliers[supplierId]),
    destinationNote: locationOffered
      ? null
      : unofferedDestinationNoteFor('template', choices.unofferedDestinations[locationId]),
  };
}

/**
 * The list's word for a template whose destination stops its purchase
 * orders: deleted after the template was saved, or not linked to a
 * warehouse. The daily run skips such a template and says why
 * (RecurringPoTemplatesService.runDueTemplates); this says it before the run
 * does. It follows the run's own rule (`saveRefuses`, read from the row), not
 * which `why` the form's note found first, so a rack linked to no warehouse
 * is flagged too. Null for any other template (a staging area linked to its
 * warehouse is accepted, and an unread destination is not guessed at).
 */
function destinationBlocksRuns(destination: UnofferedDestination | undefined): string | null {
  const refused = destination?.saveRefuses;
  if (!destination || !refused) return null;
  const subject = destination.name ? `Its destination, "${destination.name}",` : 'Its destination';
  return refused === 'deleted'
    ? `${subject} was deleted, so it creates no purchase order. Edit it to choose another destination.`
    : `${subject} isn't linked to a warehouse, so it creates no purchase order. Edit it to choose another destination.`;
}

/** The list's supplier label for a template: archived ones by name. */
function supplierLabel(
  supplierId: string | null,
  choices: Pick<FormChoices, 'suppliers' | 'unofferedSuppliers'>,
): string {
  if (!supplierId) return 'No supplier';
  const offered = choices.suppliers.find((s) => s.id === supplierId);
  if (offered) return offered.name;
  const unoffered = choices.unofferedSuppliers[supplierId];
  if (unoffered?.why === 'archived' && unoffered.name) return `${unoffered.name} (archived)`;
  return unoffered?.why === 'archived' ? 'Archived supplier' : 'Supplier unknown';
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
  /**
   * Why the destination Make recurring brought over, or the template holds,
   * was not kept; shown under Destination until the buyer picks one.
   */
  destinationNote: string | null;
  /** The same for the supplier, shown under Supplier. */
  supplierNote: string | null;
}

function defaultForm(
  templates?: RecurringTemplateRow[],
  editId?: string,
  choices?: FormChoices,
): FormState {
  // If editing an existing template, find it.
  if (editId && templates && choices) {
    const t = templates.find((tpl) => tpl.id === editId);
    if (t) {
      const rawLines = Array.isArray(t.line_items) ? (t.line_items as Line[]) : [];
      return {
        name: t.name,
        ...templateChoices(t, choices),
        cadence: (t.cadence as Cadence) || 'monthly',
        customDays: t.custom_days ?? 30,
        sendMode: (t.send_mode as SendMode) || 'draft',
        capDollars: t.max_auto_send_cents != null ? (t.max_auto_send_cents / 100).toFixed(2) : '',
        lines: rawLines,
        notes: t.notes ?? '',
      };
    }
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
    destinationNote: null,
    supplierNote: null,
  };
}

/**
 * The create form Make recurring opens: the purchase order's supplier and
 * lines, and its destination only when this form offers it (`locations`, the
 * purchase order form's own list: sites linked to a warehouse). A destination
 * it does not offer (a staging area, a deleted location) was kept out of
 * sight until 2026-10-06: the select showed blank, which Radix does for a
 * value no option has, while the save sent it, so every purchase order the
 * template created would have gone there. Now the form opens with no
 * destination and a note saying where the purchase order went, so the buyer
 * picks one.
 *
 * The server's read of the purchase order (`fromPo`) decides which destination
 * that was. The seed sat in the browser's storage, so its destination is used
 * only when the server could not read one, and even then only if offered.
 */
function seededForm(
  seed: RecurringPoSeed,
  choices: FormChoices,
  fromPo: RecurringSeedDestination | null | undefined,
): FormState {
  const destinationId = fromPo ? fromPo.locationId : seed.destinationLocationId;
  const offered = destinationId !== null && choices.locations.some((l) => l.id === destinationId);
  // The supplier the same way (small fixes slice 8): an archived one is not
  // offered, and was kept out of sight like the destination.
  const supplierId = seed.supplierId ?? '';
  const supplierOffered = !supplierId || choices.suppliers.some((s) => s.id === supplierId);
  return {
    ...defaultForm(),
    supplierId: supplierOffered ? supplierId : '',
    locationId: offered ? destinationId : '',
    lines: seed.lineItems,
    destinationNote: destinationId !== null && !offered ? unofferedDestinationNote(fromPo) : null,
    supplierNote: supplierOffered
      ? null
      : unofferedSupplierNote('purchase_order', choices.unofferedSuppliers[supplierId]),
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
  seedDestination,
  lineLabels,
  unofferedDestinations,
  unofferedSuppliers,
}: Props) {
  const choices: FormChoices = {
    locations,
    suppliers,
    unofferedDestinations: unofferedDestinations ?? {},
    unofferedSuppliers: unofferedSuppliers ?? {},
  };
  const [templates, setTemplates] = React.useState<RecurringTemplateRow[]>(initial);
  const listedIds = React.useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const lineLabelById = React.useMemo(
    () => new Map((lineLabels ?? []).map((l) => [l.id, l])),
    [lineLabels],
  );
  // null = list view; 'new' = new form; '<id>' = editing that template
  const [formMode, setFormMode] = React.useState<null | 'new' | string>(seed ? 'new' : null);
  const [form, setForm] = React.useState<FormState>(() =>
    seed ? seededForm(seed, choices, seedDestination) : defaultForm(),
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [toggling, setToggling] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  // The template the delete confirmation is open for (it replaced the
  // browser's own confirm, with the same words).
  const [deleteTarget, setDeleteTarget] = React.useState<RecurringTemplateRow | null>(null);
  // Why the last delete was refused, shown inside the confirmation (a toast
  // alone sits behind an open dialog).
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  // The form as it opened. A form that differs from it holds typed work that
  // "Refresh to update" would discard, so it registers as unsaved work
  // (CONFLICTS D30). A form Make recurring filled in counts as changed from
  // the start: the seed is taken from the browser's storage once, so a
  // reload would lose it.
  const openedAs = React.useRef<string | null>(seed ? JSON.stringify(defaultForm()) : null);
  useUnsavedWork(
    'recurring-template-form',
    formMode === 'new' ? 'New recurring template' : 'Edit template',
    () => formMode !== null && openedAs.current !== JSON.stringify(form),
  );

  // Sync external initial list if the server re-renders the page.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server's list replaces the optimistic one after revalidatePath
    setTemplates(initial);
  }, [initial]);

  // ── upgrade gate ──────────────────────────────────────────────────────────

  if (!entitled) {
    return (
      <DetailSection title="Recurring purchase orders">
        <p className="text-muted-foreground mb-4 text-[13.5px] leading-[20.25px]">
          Auto-create purchase orders on a schedule — weekly, monthly, quarterly, or custom.
        </p>
        <p className="border-border bg-sunk text-muted-foreground rounded-md border p-4 text-[13.5px] leading-[20.25px]">
          Recurring purchase orders is a <span className="text-foreground font-medium">Pro</span>{' '}
          feature. Upgrade to Pro or above to use it.
        </p>
      </DetailSection>
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
    const next = defaultForm();
    openedAs.current = JSON.stringify(next);
    setForm(next);
    setFormMode('new');
  }

  function openEdit(tpl: RecurringTemplateRow) {
    const next = defaultForm(templates, tpl.id, choices);
    openedAs.current = JSON.stringify(next);
    setForm(next);
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
    setTemplates((prev) => prev.map((t) => (t.id === tpl.id ? { ...t, enabled: next } : t)));
    toast.success(next ? 'Template enabled.' : 'Template disabled.');
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async function deleteTemplate(id: string) {
    setDeleting(id);
    const res = await deleteRecurringTemplateAction(id);
    setDeleting(null);
    if (!res.ok) {
      setDeleteError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    setDeleteTarget(null);
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

  /** A field's help line under it. */
  const help = 'text-muted-foreground text-[12px] leading-[18px]';
  /** "(optional)" after a label. */
  const optional = <span className="text-muted-foreground ml-1 font-normal">(optional)</span>;

  return (
    <>
      <DetailSection
        data-slot="recurring-templates"
        title="Recurring purchase orders"
        flush
        aside={
          !isFormOpen ? (
            <Button size="sm" variant="gradient" onClick={openNew}>
              <Plus className="h-4 w-4" /> New template
            </Button>
          ) : null
        }
      >
        <p className="text-muted-foreground px-[18px] pb-3 pt-3.5 text-[13.5px] leading-[20.25px]">
          Templates that create a PO automatically on a cadence. Draft by default; opt-in auto-send
          requires a $ cap and stays within your PO approval threshold.
        </p>

        {/* ── Template list ── */}
        {!isFormOpen &&
          (templates.length === 0 ? (
            <div className="border-border border-t">
              <StatePanel
                kind="empty"
                surface="plain"
                headingLevel={null}
                icon={RefreshCw}
                title="No recurring templates yet. Create one to start auto-generating purchase orders on a schedule."
              />
            </div>
          ) : (
            <ul className="border-border divide-border divide-y border-t">
              {templates.map((tpl) => {
                const isBusy = toggling === tpl.id || deleting === tpl.id;
                const destinationProblem =
                  tpl.destination_location_id &&
                  !locations.some((l) => l.id === tpl.destination_location_id)
                    ? destinationBlocksRuns(
                        choices.unofferedDestinations[tpl.destination_location_id],
                      )
                    : null;
                const rawLines = Array.isArray(tpl.line_items)
                  ? (tpl.line_items as Array<{
                      itemId: string;
                      quantityOrdered: number;
                      unitCost: number;
                    }>)
                  : [];
                const tplTotal = rawLines.reduce((s, l) => s + l.quantityOrdered * l.unitCost, 0);
                return (
                  <li
                    key={tpl.id}
                    data-slot="recurring-template-row"
                    className="flex items-start gap-3 px-[18px] py-3"
                  >
                    {/* Saved at once on the server, as before: the shared
                        checkbox (a role="checkbox" button) keeps the test
                        hook, the words and the disabled-while-busy rule. */}
                    <Checkbox
                      checked={tpl.enabled}
                      label={tpl.enabled ? 'Disable template' : 'Enable template'}
                      disabled={isBusy}
                      onCheckedChange={() => toggleEnabled(tpl)}
                      className="mt-px"
                      data-testid={`toggle-${tpl.id}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          'truncate text-[13.5px] font-medium leading-5',
                          tpl.enabled ? 'text-foreground' : 'text-ink-2',
                        )}
                      >
                        {tpl.name}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18px]">
                        {supplierLabel(tpl.supplier_id, choices)} ·{' '}
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
                      {/* The server renders "next ..." and "last ran ..."
                          before the browser hydrates them; a minute
                          between the two changes the words. Tolerate it
                          instead of React error #418. */}
                      <p
                        className="text-muted-foreground text-[12.5px] tabular-nums leading-[18px]"
                        suppressHydrationWarning
                      >
                        {rawLines.length} line{rawLines.length !== 1 ? 's' : ''} ·{' '}
                        {formatCurrency(tplTotal)} · next {formatRelative(tpl.next_run_at)}
                        {tpl.last_run_at ? ` · last ran ${formatRelative(tpl.last_run_at)}` : ''}
                      </p>
                      {destinationProblem ? (
                        <p className="text-warning mt-0.5 text-[12.5px] font-medium leading-[18px]">
                          {destinationProblem}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
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
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(tpl);
                        }}
                        disabled={isBusy}
                        aria-label="Delete template"
                      >
                        {deleting === tpl.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="text-destructive h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ))}

        {/* ── Create / edit form ── */}
        {isFormOpen && (
          <div
            data-slot="recurring-template-form"
            className="border-border space-y-5 border-t px-[18px] py-[18px]"
          >
            <h3 className="text-foreground text-[13.5px] font-medium leading-5">
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
                <Label htmlFor="rpt-supplier">
                  Supplier
                  {optional}
                </Label>
                <Select
                  value={form.supplierId || '__none'}
                  onValueChange={(v) =>
                    patchForm({ supplierId: v === '__none' ? '' : v, supplierNote: null })
                  }
                  disabled={submitting}
                >
                  <SelectTrigger
                    id="rpt-supplier"
                    aria-describedby={form.supplierNote ? 'rpt-supplier-note' : undefined}
                  >
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
                {form.supplierNote ? (
                  <p
                    id="rpt-supplier-note"
                    className="text-warning text-[12px] font-medium leading-[18px]"
                  >
                    {form.supplierNote}
                  </p>
                ) : null}
              </div>

              {/* Destination */}
              <div className="space-y-1.5">
                <Label htmlFor="rpt-destination">
                  Destination location
                  {optional}
                </Label>
                <Select
                  value={form.locationId || '__none'}
                  onValueChange={(v) =>
                    patchForm({ locationId: v === '__none' ? '' : v, destinationNote: null })
                  }
                  disabled={submitting}
                >
                  <SelectTrigger
                    id="rpt-destination"
                    aria-describedby={form.destinationNote ? 'rpt-destination-note' : undefined}
                  >
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
                {form.destinationNote ? (
                  <p
                    id="rpt-destination-note"
                    className="text-warning text-[12px] font-medium leading-[18px]"
                  >
                    {form.destinationNote}
                  </p>
                ) : null}
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
                <p className={help}>
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
                  <p className={help}>
                    POs above this cap are drafted for review instead of auto-sent.
                  </p>
                </div>
              )}
            </div>

            {/* Line items (reuses same pattern as PoForm) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
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
                <StatePanel
                  kind="empty"
                  surface="plain"
                  headingLevel={null}
                  icon={null}
                  className="border-line-strong rounded-lg border border-dashed p-6"
                  title={<>No lines yet. Click &quot;Add line&quot; to start.</>}
                />
              ) : (
                <div className="space-y-2">
                  {form.lines.map((line, idx) => (
                    <div
                      key={idx}
                      data-slot="recurring-template-line"
                      className="border-border bg-sunk grid grid-cols-2 gap-2 rounded-lg border p-3 sm:grid-cols-12"
                    >
                      <div className="col-span-2 min-w-0 space-y-1 sm:col-span-5">
                        <Label
                          htmlFor={`rpt-line-${idx}-item`}
                          className="text-muted-foreground text-[11px]"
                        >
                          Item
                        </Label>
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
                          <SelectTrigger id={`rpt-line-${idx}-item`}>
                            <SelectValue placeholder="Pick an item" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__pick" disabled>
                              Pick an item
                            </SelectItem>
                            {/* A saved line whose item the picker does not
                                list (deleted, a kit, archived) still shows
                                what it is, so it can be found and removed. */}
                            {line.itemId && !listedIds.has(line.itemId) ? (
                              <SelectItem value={line.itemId} disabled>
                                {unlistedLineLabel(lineLabelById.get(line.itemId))}
                              </SelectItem>
                            ) : null}
                            {items.map((i) => (
                              <SelectItem key={i.id} value={i.id}>
                                {i.name} — <span className="font-mono text-xs">{i.sku}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <Label
                          htmlFor={`rpt-line-${idx}-qty`}
                          className="text-muted-foreground text-[11px]"
                        >
                          Qty
                        </Label>
                        <BlankZeroNumberInput
                          id={`rpt-line-${idx}-qty`}
                          min={1}
                          step={1}
                          value={line.quantityOrdered}
                          onValueChange={(n) => updateLine(idx, { quantityOrdered: n })}
                          placeholder="Qty"
                          disabled={submitting}
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <Label
                          htmlFor={`rpt-line-${idx}-cost`}
                          className="text-muted-foreground text-[11px]"
                        >
                          Unit cost
                        </Label>
                        <BlankZeroNumberInput
                          id={`rpt-line-${idx}-cost`}
                          min={0}
                          step={0.01}
                          value={line.unitCost}
                          onValueChange={(n) => updateLine(idx, { unitCost: n })}
                          placeholder="0.00"
                          disabled={submitting}
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <span className="text-muted-foreground block text-[11px] leading-none">
                          Subtotal
                        </span>
                        <p className="text-foreground py-2 font-mono text-[13px] tabular-nums">
                          {formatCurrency(line.quantityOrdered * line.unitCost)}
                        </p>
                      </div>
                      <div className="flex items-end justify-end sm:col-span-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeLine(idx)}
                          disabled={submitting}
                          aria-label={`Remove line ${idx + 1}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {form.lines.length > 0 && (
                    <div className="flex justify-end pt-2 text-[13.5px]">
                      <span className="text-muted-foreground">Total: </span>
                      <span className="text-foreground ml-2 font-mono font-medium tabular-nums">
                        {formatCurrency(total)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label htmlFor="rpt-notes">
                Notes
                {optional}
              </Label>
              <Textarea
                id="rpt-notes"
                rows={2}
                value={form.notes}
                onChange={(e) => patchForm({ notes: e.target.value })}
                disabled={submitting}
              />
            </div>

            {/* Actions */}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={cancelForm} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant={formMode === 'new' ? 'gradient' : 'default'}
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
      </DetailSection>

      {/* The confirmation the browser's own confirm() gave, with its words. */}
      <DestructiveConfirm
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v && deleting === null) setDeleteTarget(null);
        }}
        title="Delete this recurring template?"
        description="This cannot be undone."
        confirmLabel="Delete"
        pending={deleteTarget !== null && deleting === deleteTarget.id}
        error={deleteError}
        onConfirm={() => {
          if (!deleteTarget) return;
          setDeleteError(null);
          return deleteTemplate(deleteTarget.id);
        }}
      />
    </>
  );
}
