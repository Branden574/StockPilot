import 'server-only';

import { z } from 'zod';

import { nextRunAt, type RecurringCadence } from '@stockpilot/core';

import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from './context';
import { shouldAutoSend } from './auto-reorder';
import { PurchaseOrdersService } from './purchase-orders';
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

  // ── create ────────────────────────────────────────────────────────────────

  async create(input: RecurringTemplateInput) {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const parsed = recurringTemplateSchema.parse(input);
    await this.assertDestinationLocationInOrg(parsed.destinationLocationId);
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
   */
  async seedFromPo(poId: string): Promise<{
    supplierId: string | null;
    destinationLocationId: string | null;
    lineItems: Array<{ itemId: string; quantityOrdered: number; unitCost: number }>;
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
    const rawLines = (lines ?? []) as LineRow[];

    return {
      supplierId: poRow.supplier_id,
      destinationLocationId: poRow.destination_location_id,
      lineItems: rawLines
        .filter((l): l is LineRow & { item_id: string } => Boolean(l.item_id))
        .map((l) => ({
          itemId: l.item_id,
          quantityOrdered: Number(l.quantity_ordered),
          unitCost: Number(l.unit_cost),
        })),
    };
  }

  // ── runDueTemplates ───────────────────────────────────────────────────────

  /**
   * Daily-cron entry point. Creates one PO per due template (next_run_at <= now),
   * optionally auto-sends within the configured cap + org approval threshold,
   * then advances the schedule. Per-template fail-open. Money-safe: auto-send
   * requires send_mode==='send' AND non-null cap AND total <= cap AND total <
   * approval threshold. A failed threshold-read BLOCKS all auto-sends (fail-closed).
   */
  async runDueTemplates(now: Date): Promise<{
    created: number;
    sent: number;
    heldForReview: number;
    failures: number;
  }> {
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

    for (const tpl of templates) {
      let createdOk = false;
      try {
        // Parse line items from jsonb — fail-closed: malformed/empty → skip (and
        // still advance the schedule below so a bad template can't retry forever).
        const rawLines = Array.isArray(tpl.line_items) ? tpl.line_items : [];
        const lines = rawLines
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

        if (lines.length === 0) {
          failures++;
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
          createdOk = true;
        }
      } catch {
        failures++;
      }

      // Advance the schedule for EVERY attempted template (success OR failure) so
      // it fires at most once per due period: no double-fire on a re-run, no
      // catch-up burst for an overdue/dormant template, and no infinite retry of
      // a failing one. Advance until strictly in the future. Rowcount-checked —
      // a template that DID create a PO but failed to advance could re-fire (and
      // re-send) next run, so surface that as a failure for the cron summary.
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
          .select('id')
          .maybeSingle();
        if (advErr || !advanced) {
          throw advErr ?? new Error('recurring template schedule advance matched 0 rows');
        }
      } catch {
        if (createdOk) failures += 1;
      }
    }

    return { created, sent, heldForReview, failures };
  }
}
