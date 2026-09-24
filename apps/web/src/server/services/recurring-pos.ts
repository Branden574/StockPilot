import 'server-only';

import { z } from 'zod';

import { nextRunAt, type RecurringCadence } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from './context';
import { shouldAutoSend } from './auto-reorder';
import { PurchaseOrdersService } from './purchase-orders';
import { fetchAllRowsByIds } from './lib/fetch-by-ids';
import { whereOrderableItem } from './lib/orderable-items';
import { fetchAllRows } from './lib/paginate';
import { audit } from './audit';

// ── Zod schema ──────────────────────────────────────────────────────────────

const lineItemSchema = z.object({
  itemId: z.string().uuid(),
  quantityOrdered: z.coerce.number().positive(),
  unitCost: z.coerce.number().nonnegative(),
});

export const recurringTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  supplierId: z.string().uuid().nullable().optional(),
  destinationLocationId: z.string().uuid().nullable().optional(),
  cadence: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'custom']),
  customDays: z.number().int().min(1).max(365).nullable().optional(),
  sendMode: z.enum(['draft', 'send']).default('draft'),
  maxAutoSendCents: z.number().nonnegative().nullable().optional(),
  lineItems: z.array(lineItemSchema).min(1, 'Add at least one line item'),
  notes: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
});

export type RecurringTemplateInput = z.infer<typeof recurringTemplateSchema>;

/** Why an item can never go on a purchase order (0366
 *  po_line_items_not_orderable, the rule save_purchase_order_draft applies). */
type NotOrderableReason = 'po_line_deleted' | 'po_line_bundle';

/** What one cron run did for one organization. */
export interface RecurringRunSummary {
  created: number;
  sent: number;
  heldForReview: number;
  failures: number;
  /** Template lines left off because their item was deleted or is a kit's
   *  pre-assembled stock (neither can go on a PO). */
  linesLeftOff: number;
  /** Names of the templates that left off at least one line, in run order. */
  templatesWithLinesLeftOff: string[];
  /** Names of the templates that created nothing because not one of their
   *  lines could be ordered (also counted in `failures`). */
  templatesWithNothingOrderable: string[];
}

/** At most this many template names are spelled out in a notification. */
const NOTICE_MAX_NAMES = 3;

function namesForNotice(names: string[]): string {
  const quoted = names.slice(0, NOTICE_MAX_NAMES).map((n) => `"${n}"`);
  const more = names.length - quoted.length;
  if (more > 0) quoted.push(`${more} more`);
  if (quoted.length === 1) return quoted[0] as string;
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * The admins' notification for one organization's cron run, or null when
 * there is nothing to tell. Before, admins heard only when a PO was created,
 * so a template whose lines were left off (deleted items, kit stock) ordered
 * less than it says every period with no word to anyone, and one with
 * nothing orderable left created nothing and notified nobody.
 */
export function recurringRunNotice(summary: RecurringRunSummary): { title: string; body: string } | null {
  const leftOff = summary.linesLeftOff > 0;
  if (summary.created === 0 && !leftOff) return null;

  const parts: string[] = [];
  if (summary.created > 0) {
    const sentPart = summary.sent > 0 ? `, ${summary.sent} sent` : '';
    const heldPart = summary.heldForReview > 0 ? `, ${summary.heldForReview} held for review` : '';
    parts.push(
      `Recurring purchase orders created ${summary.created} purchase order${
        summary.created === 1 ? '' : 's'
      }${sentPart}${heldPart}.`,
    );
  }
  if (leftOff) {
    const n = summary.linesLeftOff;
    const names = summary.templatesWithLinesLeftOff;
    parts.push(
      `${n} template line${n === 1 ? ' was' : 's were'} left off (${namesForNotice(names)}) because the item was deleted or is a pre-assembled kit, which is never ordered. Edit the template${
        names.length === 1 ? '' : 's'
      } to remove ${n === 1 ? 'it' : 'them'}.`,
    );
  }
  const idle = summary.templatesWithNothingOrderable;
  if (idle.length > 0) {
    parts.push(
      `${namesForNotice(idle)} created no purchase order: none of ${
        idle.length === 1 ? 'its' : 'their'
      } items can be ordered any more. Edit or disable ${idle.length === 1 ? 'it' : 'them'}.`,
    );
  }
  return {
    title: summary.created > 0 ? 'Recurring purchase orders ran' : 'Recurring purchase orders need attention',
    body: parts.join(' '),
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

export class RecurringPoTemplatesService {
  constructor(private readonly ctx: ServiceContext) {}

  // ── list ──────────────────────────────────────────────────────────────────

  async list() {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    type Row = {
      id: string;
      organization_id: string;
      supplier_id: string | null;
      destination_location_id: string | null;
      name: string;
      enabled: boolean;
      cadence: string;
      custom_days: number | null;
      send_mode: string;
      max_auto_send_cents: number | null;
      line_items: unknown;
      notes: string | null;
      last_run_at: string | null;
      next_run_at: string;
      created_at: string;
      updated_at: string;
    };

    return fetchAllRows<Row>((from, to) =>
      this.ctx.supabase
        .from('recurring_po_templates')
        .select(
          'id, organization_id, supplier_id, destination_location_id, name, enabled, cadence, custom_days, send_mode, max_auto_send_cents, line_items, notes, last_run_at, next_run_at, created_at, updated_at',
        )
        .eq('organization_id', this.ctx.organizationId)
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
  }

  // ── assertDestinationLocationInOrg ───────────────────────────────────────

  private async assertDestinationLocationInOrg(locationId: string | null | undefined) {
    if (!locationId) return;
    const { data, error } = await this.ctx.supabase
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('validation_error', 'Destination location not found in your organization.');
  }

  // ── assertSupplierInOrg ───────────────────────────────────────────────────

  private async assertSupplierInOrg(supplierId: string | null | undefined) {
    if (!supplierId) return;
    const { data, error } = await this.ctx.supabase
      .from('suppliers')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', supplierId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('validation_error', 'Supplier not found in your organization.');
  }

  // ── orderability of template lines ───────────────────────────────────────

  /**
   * Which of `itemIds` can never go on a purchase order, and why: deleted, or
   * a kit's pre-assembled stock (is_bundle). Asks the database's own rule,
   * po_line_items_not_orderable (0366): the check save_purchase_order_draft
   * runs on every PO the cron creates. It reads past RLS, so an item the
   * caller cannot see (no warehouse, or a warehouse a staff buyer is not
   * assigned to) is judged the same way the cron's save will judge it. A
   * failed read throws: "could not check" is never "nothing to refuse".
   */
  private async notOrderable(itemIds: string[]): Promise<Map<string, NotOrderableReason>> {
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) return new Map();
    const { data, error } = await this.ctx.supabase.rpc('po_line_items_not_orderable', {
      p_org_id: this.ctx.organizationId,
      p_item_ids: ids,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (Array.isArray(data) ? data : []) as Array<{ item_id: string; refusal: string }>;
    const out = new Map<string, NotOrderableReason>();
    for (const r of rows) {
      if (r.refusal === 'po_line_deleted' || r.refusal === 'po_line_bundle') out.set(r.item_id, r.refusal);
    }
    return out;
  }

  /**
   * Refuses a template whose lines include an item that can never be
   * ordered, naming the first such line's item (line order), the way the PO
   * save does. Without this the template saved, and every period the cron
   * had to leave that line off (or, with nothing else on it, create nothing).
   */
  private async assertLinesOrderable(lineItems: Array<{ itemId: string }>): Promise<void> {
    const refused = await this.notOrderable(lineItems.map((l) => l.itemId));
    if (refused.size === 0) return;
    const first = lineItems.find((l) => refused.has(l.itemId));
    if (!first) return;
    // The name only as the caller may read it; a failed or hidden read just
    // leaves the item unnamed (the refusal stands either way).
    const { data } = await this.ctx.supabase
      .from('inventory_items')
      .select('name')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', first.itemId)
      .maybeSingle();
    const name = ((data as { name?: string | null } | null)?.name ?? '').trim();
    const label = name ? `"${name}"` : 'An item on this template';
    throw new ServiceError(
      'validation_error',
      refused.get(first.itemId) === 'po_line_deleted'
        ? `${label} was deleted, so it can't be ordered. Remove it from the template and save again.`
        : `${label} is a pre-assembled kit, and kits can't be ordered on a purchase order: they are built from their components. Order the components instead.`,
    );
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(input: RecurringTemplateInput) {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const parsed = recurringTemplateSchema.parse(input);
    await this.assertDestinationLocationInOrg(parsed.destinationLocationId);
    await this.assertSupplierInOrg(parsed.supplierId);
    await this.assertLinesOrderable(parsed.lineItems);
    const now = new Date();
    const nextRun = nextRunAt(parsed.cadence as RecurringCadence, now, parsed.customDays ?? undefined);

    const { data, error } = await this.ctx.supabase
      .from('recurring_po_templates')
      .insert({
        organization_id: this.ctx.organizationId,
        supplier_id: parsed.supplierId ?? null,
        destination_location_id: parsed.destinationLocationId ?? null,
        name: parsed.name,
        enabled: parsed.enabled ?? true,
        cadence: parsed.cadence,
        custom_days: parsed.customDays ?? null,
        send_mode: parsed.sendMode,
        max_auto_send_cents: parsed.maxAutoSendCents ?? null,
        line_items: parsed.lineItems,
        notes: parsed.notes ?? null,
        next_run_at: nextRun.toISOString(),
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('id')
      .single();

    if (error) throw new ServiceError('internal_error', error.message);

    void audit(
      {
        event: 'recurring_po_template.created',
        entityType: 'recurring_po_template',
        entityId: (data as { id: string }).id,
        extra: { name: parsed.name, cadence: parsed.cadence },
      },
      this.ctx,
    );

    return { id: (data as { id: string }).id };
  }

  // ── update ────────────────────────────────────────────────────────────────

  async update(id: string, input: RecurringTemplateInput) {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const parsed = recurringTemplateSchema.parse(input);
    await this.assertDestinationLocationInOrg(parsed.destinationLocationId);
    await this.assertSupplierInOrg(parsed.supplierId);
    await this.assertLinesOrderable(parsed.lineItems);

    const { data, error } = await this.ctx.supabase
      .from('recurring_po_templates')
      .update({
        supplier_id: parsed.supplierId ?? null,
        destination_location_id: parsed.destinationLocationId ?? null,
        name: parsed.name,
        cadence: parsed.cadence,
        custom_days: parsed.customDays ?? null,
        send_mode: parsed.sendMode,
        max_auto_send_cents: parsed.maxAutoSendCents ?? null,
        line_items: parsed.lineItems,
        notes: parsed.notes ?? null,
        updated_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Recurring PO template not found');

    void audit(
      {
        event: 'recurring_po_template.updated',
        entityType: 'recurring_po_template',
        entityId: id,
        extra: { name: parsed.name },
      },
      this.ctx,
    );

    return { id };
  }

  // ── setEnabled ────────────────────────────────────────────────────────────

  async setEnabled(id: string, enabled: boolean) {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { data, error } = await this.ctx.supabase
      .from('recurring_po_templates')
      .update({ enabled, updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Recurring PO template not found');

    void audit(
      {
        event: 'recurring_po_template.toggled',
        entityType: 'recurring_po_template',
        entityId: id,
        extra: { enabled },
      },
      this.ctx,
    );

    return { id };
  }

  // ── remove ────────────────────────────────────────────────────────────────

  async remove(id: string) {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { data, error } = await this.ctx.supabase
      .from('recurring_po_templates')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Recurring PO template not found');

    void audit(
      {
        event: 'recurring_po_template.deleted',
        entityType: 'recurring_po_template',
        entityId: id,
        extra: {},
      },
      this.ctx,
    );
  }

  // ── seedFromPo ────────────────────────────────────────────────────────────

  /**
   * Returns a non-persisted template payload pre-filled from an existing PO's
   * supplier and line items. The UI uses this to open the create form prefilled
   * ("Make recurring"). Does NOT write to the DB.
   *
   * A line whose item can never be ordered again (deleted, or a kit's
   * pre-assembled stock, which the reorder paths drafted before 0366) is left
   * out: the template save would refuse it. `linesLeftOff` says how many, so
   * the caller can tell the buyer instead of dropping them silently.
   */
  async seedFromPo(poId: string): Promise<{
    supplierId: string | null;
    destinationLocationId: string | null;
    lineItems: Array<{ itemId: string; quantityOrdered: number; unitCost: number }>;
    linesLeftOff: number;
  }> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { data: po, error: poError } = await this.ctx.supabase
      .from('purchase_orders')
      .select('id, organization_id, supplier_id, destination_location_id, destination')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', poId)
      .maybeSingle();

    if (poError) throw new ServiceError('internal_error', poError.message);
    if (!po) throw new ServiceError('not_found', 'Purchase order not found');

    type PoRow = {
      supplier_id: string | null;
      destination_location_id: string | null;
    };
    const poRow = po as PoRow;

    const { data: lines, error: linesError } = await this.ctx.supabase
      .from('purchase_order_items')
      .select('item_id, quantity_ordered, unit_cost')
      .eq('purchase_order_id', poId);

    if (linesError) throw new ServiceError('internal_error', linesError.message);

    type LineRow = { item_id: string | null; quantity_ordered: number; unit_cost: number };
    const withItem = ((lines ?? []) as LineRow[]).filter(
      (l): l is LineRow & { item_id: string } => Boolean(l.item_id),
    );
    const refused = await this.notOrderable(withItem.map((l) => l.item_id));
    const orderable = withItem.filter((l) => !refused.has(l.item_id));

    return {
      supplierId: poRow.supplier_id,
      destinationLocationId: poRow.destination_location_id,
      lineItems: orderable.map((l) => ({
        itemId: l.item_id,
        quantityOrdered: Number(l.quantity_ordered),
        unitCost: Number(l.unit_cost),
      })),
      linesLeftOff: withItem.length - orderable.length,
    };
  }

  // ── runDueTemplates ───────────────────────────────────────────────────────

  /**
   * Daily-cron entry point. CLAIMS each due template (next_run_at <= now) by
   * advancing its schedule conditionally, then — only if the claim won — creates
   * one PO and optionally auto-sends it within the configured cap + org approval
   * threshold. Per-template fail-open. Money-safe: auto-send requires
   * send_mode==='send' AND non-null cap AND total <= cap AND total < approval
   * threshold. A failed threshold-read BLOCKS all auto-sends (fail-closed).
   *
   * Claim-BEFORE-create is what makes the run at-most-once per due period even
   * when two invocations overlap (a manual "Run" or an operator curl with
   * CRON_SECRET while the daily cron is still in the loop): nothing downstream
   * dedupes — PurchaseOrdersService.create has no idempotency key, and the
   * `purchase_order.ordered` outbox dedupe key is per-PO-id, so two POs mean two
   * connector pushes and real duplicate spend.
   */
  async runDueTemplates(now: Date): Promise<RecurringRunSummary> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    type TemplateRow = {
      id: string;
      supplier_id: string | null;
      destination_location_id: string | null;
      name: string;
      cadence: string;
      custom_days: number | null;
      send_mode: string;
      max_auto_send_cents: number | null;
      line_items: unknown;
      notes: string | null;
      next_run_at: string;
    };

    // Paginate enabled templates that are due.
    const templates = await fetchAllRows<TemplateRow>((from, to) =>
      this.ctx.supabase
        .from('recurring_po_templates')
        .select(
          'id, supplier_id, destination_location_id, name, cadence, custom_days, send_mode, max_auto_send_cents, line_items, notes, next_run_at',
        )
        .eq('organization_id', this.ctx.organizationId)
        .eq('enabled', true)
        .lte('next_run_at', now.toISOString())
        .order('next_run_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );

    let created = 0;
    let sent = 0;
    let heldForReview = 0;
    let failures = 0;
    let linesLeftOff = 0;
    const templatesWithLinesLeftOff: string[] = [];
    const templatesWithNothingOrderable: string[] = [];

    for (const tpl of templates) {
      // ── CLAIM ────────────────────────────────────────────────────────────
      // Advance the schedule for EVERY due template BEFORE doing any work, so
      // it fires at most once per due period: no double-fire on a re-run, no
      // catch-up burst for an overdue/dormant template, and no infinite retry of
      // a failing one. Advance until strictly in the future.
      //
      // The `.eq('next_run_at', tpl.next_run_at)` predicate is the claim itself
      // (compare-and-swap on the value we read). Without it a SECOND overlapping
      // invocation — the cron route has no lock, any caller with CRON_SECRET can
      // start one mid-run — would select the same template, create a second PO
      // and, in send mode under the cap, auto-order it too. 0 rows matched means
      // the other invocation owns this period: skip SILENTLY, it is not a
      // failure. `enabled` is re-checked here too so a template disabled between
      // the select and the claim never spends money.
      let claimed = false;
      try {
        let nextRun = new Date(tpl.next_run_at);
        for (let guard = 0; nextRun.getTime() <= now.getTime() && guard < 1000; guard += 1) {
          nextRun = nextRunAt(
            tpl.cadence as RecurringCadence,
            nextRun,
            tpl.custom_days ?? undefined,
          );
        }
        const { data: advanced, error: advErr } = await this.ctx.supabase
          .from('recurring_po_templates')
          .update({
            next_run_at: nextRun.toISOString(),
            last_run_at: now.toISOString(),
            updated_by: this.ctx.userId,
          })
          .eq('organization_id', this.ctx.organizationId)
          .eq('id', tpl.id)
          .eq('enabled', true)
          .eq('next_run_at', tpl.next_run_at)
          .select('id')
          .maybeSingle();
        // An ERROR is a failure worth surfacing in the cron summary; a clean
        // 0-row match is a lost race and stays silent.
        if (advErr) throw advErr;
        claimed = Boolean(advanced);
      } catch {
        failures += 1;
      }
      if (!claimed) continue;

      try {
        // Parse line items from jsonb — fail-closed: malformed/empty → skip. The
        // schedule was already advanced by the claim above, so a bad template
        // can't retry forever.
        const rawLines = Array.isArray(tpl.line_items) ? tpl.line_items : [];
        let lines = rawLines
          .map((l: unknown) => {
            const o = l as Record<string, unknown>;
            return {
              itemId: String(o.itemId ?? ''),
              quantityOrdered: Number(o.quantityOrdered ?? 0),
              unitCost: Number(o.unitCost ?? 0),
            };
          })
          // Defense-in-depth: a row mutated out-of-band can't sneak a negative
          // unitCost (which would lower the total under the auto-send cap).
          .filter((l) => l.itemId && l.quantityOrdered > 0 && l.unitCost >= 0);

        // A template keeps its item ids after the items change. A deleted
        // item, or a kit's pre-assembled stock, can no longer go on a PO:
        // the save refuses such a line (0366, po_line_deleted /
        // po_line_bundle), and one such line would fail the whole template's
        // PO every period, silently (a failure is only counted). Leave those
        // lines off, order the rest, and report what was left off: to the
        // admins through the run summary (recurringRunNotice), and to error
        // reporting. Template saves refuse such lines now, so this catches
        // an item deleted after its template was saved. Read as the cron's
        // service client, which sees every item; a failed read throws into
        // the catch below (counted as a failure, no PO).
        const orderableIds = await this.orderableItemIds(lines.map((l) => l.itemId));
        const unorderable = lines.filter((l) => !orderableIds.has(l.itemId));
        if (unorderable.length > 0) {
          linesLeftOff += unorderable.length;
          templatesWithLinesLeftOff.push(tpl.name);
          void reportError(
            new Error(
              `recurring PO template left off ${unorderable.length} line(s) whose item is deleted or a pre-assembled kit`,
            ),
            {
              tag: 'recurring_pos.unorderable_lines',
              level: 'warning',
              organizationId: this.ctx.organizationId,
              extra: { templateId: tpl.id, linesLeftOff: unorderable.length, linesKept: lines.length - unorderable.length },
            },
          );
          lines = lines.filter((l) => orderableIds.has(l.itemId));
        }

        if (lines.length === 0) {
          failures++;
          if (unorderable.length > 0) templatesWithNothingOrderable.push(tpl.name);
        } else {
          const total = lines.reduce((sum, l) => sum + l.quantityOrdered * l.unitCost, 0);

          // Create the PO (always starts as draft).
          const po = await new PurchaseOrdersService(this.ctx).create({
            supplierId: tpl.supplier_id ?? null,
            destinationLocationId: tpl.destination_location_id ?? null,
            notes: tpl.notes ?? undefined,
            lines,
          });
          created++;

          // Auto-send decision — only relevant when send_mode==='send'.
          if (tpl.send_mode === 'send') {
            // Approval threshold — FAIL CLOSED: read error → sendBlocked=true.
            let threshold: number | null = null;
            let sendBlocked = false;
            const { data: modRow, error: modErr } = await this.ctx.supabase
              .from('organization_modules')
              .select('settings')
              .eq('organization_id', this.ctx.organizationId)
              .eq('module_id', 'purchase_orders')
              .maybeSingle();
            if (modErr) {
              sendBlocked = true;
            } else {
              const modSettings = (
                (modRow as { settings?: unknown } | null)?.settings ?? {}
              ) as Record<string, unknown>;
              const rawThreshold = Number(modSettings.approvalThresholdAmount);
              threshold =
                Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : null;
            }

            const capDollars =
              tpl.max_auto_send_cents != null ? tpl.max_auto_send_cents / 100 : null;

            if (!sendBlocked && shouldAutoSend(total, capDollars, threshold)) {
              await new PurchaseOrdersService(this.ctx).updateStatus(po.id, 'ordered');
              sent++;
            } else {
              heldForReview++;
            }
          }
        }
      } catch {
        // The claim already stamped last_run_at / next_run_at, so this template
        // will NOT retry inside the same period — same as the previous
        // "advance for every attempted template" contract. The failures counter
        // is what the cron summary reports it by.
        failures++;
      }
    }

    return {
      created,
      sent,
      heldForReview,
      failures,
      linesLeftOff,
      templatesWithLinesLeftOff,
      templatesWithNothingOrderable,
    };
  }

  /**
   * The ids, among `itemIds`, that may still go on a purchase order in this
   * organization (whereOrderableItem: not deleted, not a kit's pre-assembled
   * stock). Batched past the URL limit; throws on a failed read, so the
   * caller never mistakes "could not read" for "nothing is orderable".
   */
  private async orderableItemIds(itemIds: string[]): Promise<Set<string>> {
    const ctx = this.ctx;
    const rows = await fetchAllRowsByIds<{ id: string }>(
      itemIds,
      (batch) => (from, to) =>
        whereOrderableItem(ctx.supabase.from('inventory_items').select('id'), ctx.organizationId)
          .in('id', batch)
          .order('id')
          .range(from, to),
    );
    return new Set(rows.map((r) => r.id));
  }
}
