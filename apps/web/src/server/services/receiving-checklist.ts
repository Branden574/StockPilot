import 'server-only';

import { reportError } from '@/lib/error-reporter';

import { audit } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  isModuleEnabled,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { fetchAllRowsByIds, rawErrorText, reportDegradedRead } from './lib/fetch-by-ids';
import { fetchAllRows } from './lib/paginate';
import { postgrestErrorText } from './lib/postgrest-error';
import { receivingGateFor } from './lib/receiving-gate';

import {
  DELETED_USER_LABEL,
  describeChecklistIncomplete,
  describeChecklistInvalid,
  isDeletedPerson,
  parseChecklistIncompleteDetail,
  parseChecklistInvalidDetail,
  parseStoredResults,
  parseStoredSteps,
  personLabel,
  RECEIVING_CHECKLIST_BINDING,
  RECEIVING_CHECKLIST_COPY,
  resolveOrgTimezone,
  type ChecklistIncompleteDetail,
  type ChecklistResults,
  type ChecklistRunLite,
  type ChecklistStep,
  type ChecklistVersionLite,
  type ReceivingGate,
} from '@stockpilot/core';

/**
 * RECEIVING CHECKLIST (F4-1): the web and the phone reach the database through
 * this service only (the server actions and the /api/v1 routes are thin
 * wrappers over it).
 *
 * Gates run in this order before any write: the receiving module, the
 * permission (stock:adjust to record, purchase_orders:manage to publish; the
 * usual MFA step-up fires there), core receivingGate (the role floor the
 * database applies), then the RPC, which checks all of it again in its body.
 * Refusals are mapped by SQLSTATE and hint, never by message text
 * (mapChecklistError). One audit row after each successful write that changed
 * something: receiving_checklist.published, receiving_checklist.retired,
 * receiving_check.started (only when the run was created) and
 * receiving_check.completed.
 *
 * Reads go through the caller's own client, so RLS decides what is visible: a
 * run exactly when its purchase order is, versions to members.
 */

/** A replayed write answers a row made earlier; this margin tells them apart. */
const REPLAY_MARGIN_MS = 2_000;

const VERSION_SELECT =
  'id, organization_id, version_number, title, steps, procedure_id, published_at, published_by, retired_at, retired_by, deleted_users';
const RUN_SELECT =
  'id, organization_id, version_id, receipt_id, purchase_order_id, warehouse_id, status, results, note, revision, started_at, started_by, updated_at, completed_at, completed_by, deleted_users';

type VersionRow = {
  id: string;
  organization_id: string;
  version_number: number;
  title: string;
  steps: unknown;
  procedure_id: string | null;
  published_at: string;
  published_by: string | null;
  retired_at: string | null;
  retired_by: string | null;
  deleted_users?: unknown;
};

type RunRow = {
  id: string;
  organization_id: string;
  version_id: string;
  receipt_id: string | null;
  purchase_order_id: string;
  warehouse_id: string;
  status: 'in_progress' | 'completed';
  results: unknown;
  note: string | null;
  revision: number;
  started_at: string;
  started_by: string | null;
  updated_at: string;
  completed_at: string | null;
  completed_by: string | null;
  deleted_users?: unknown;
};

type ProfileRow = { id: string; full_name: string | null; email: string | null };

export interface ChecklistVersionView {
  id: string;
  versionNumber: number;
  title: string;
  steps: ChecklistStep[];
  procedureId: string | null;
  /** The linked procedure's title, when it could be read; null otherwise. */
  procedureTitle: string | null;
  publishedAt: string;
  publishedByName: string;
  retiredAt: string | null;
  retiredByName: string | null;
  /** Runs recorded on this version, for a publisher (managers see every PO); null otherwise. */
  runCount: number | null;
}

export interface ChecklistEditorView {
  live: ChecklistVersionView | null;
  /** Retired versions, newest first. */
  history: ChecklistVersionView[];
  nextVersionNumber: number;
  gate: ReceivingGate;
  /** Live procedures to link, for a publisher where Procedures is on; null when hidden or unreadable. */
  procedures: Array<{ id: string; title: string }> | null;
  proceduresUnavailable: boolean;
  timeZone: string;
}

/** Everything the PO page and the phone need to label each receipt. Never thrown. */
export type PoChecklists =
  { ok: true; versions: ChecklistVersionLite[]; runs: ChecklistRunLite[] } | { ok: false };

export type AboutClaim<T> = { kind: 'ok'; value: T } | { kind: 'unavailable' };

export interface ReceivingRunView {
  run: {
    id: string;
    status: 'in_progress' | 'completed';
    results: ChecklistResults;
    note: string | null;
    revision: number;
    startedAt: string;
    startedByName: string;
    completedAt: string | null;
    completedByName: string | null;
  };
  version: {
    id: string;
    versionNumber: number;
    title: string;
    steps: ChecklistStep[];
    procedure: { id: string; title: string } | null;
  };
  /** The newest version's number when it is newer than the run's; null otherwise. */
  newerVersionNumber: number | null;
  receipt: {
    id: string;
    receiptNumber: string;
    status: string;
    receivedAt: string;
    /** When the receipt was reversed (its reversal row's time); null when it was not. */
    reversedAt: string | null;
  };
  po: { id: string; poNumber: string; supplierName: string | null };
  about: {
    unitsReceived: number;
    lineCount: number;
    warehouseName: string | null;
    /** Charter names on the received items now; [] = none set. */
    stockOwner: AboutClaim<string[]>;
    /** The PO's bill-to charter; null = none set. */
    billTo: AboutClaim<string | null>;
    /** Lines of the PO with less received than ordered, now. */
    stillToCome: AboutClaim<number>;
  };
  lines: Array<{ itemName: string; sku: string; qtyReceived: number; qtyAccepted: number }>;
  canRecord: boolean;
  timeZone: string;
}

export interface SaveRunInput {
  runId: string;
  results: Record<string, unknown>;
  note?: string | null;
  expectedRevision: number;
  saveId: string;
  complete: boolean;
}

export interface SavedRun {
  id: string;
  status: 'in_progress' | 'completed';
  revision: number;
  results: ChecklistResults;
  note: string | null;
  completedAt: string | null;
}

export interface PublishInput {
  title: string;
  steps: unknown[];
  procedureId?: string | null;
  expectedCurrentId: string | null;
  clientPublishId: string;
}

export interface StartResult {
  runId: string;
  created: boolean;
  versionNumber: number | null;
}

/** The P0001 hints the functions raise, each answered as a 409 with that reason. */
const CONFLICT_COPY: Record<string, string> = {
  checklist_changed: RECEIVING_CHECKLIST_COPY.publishChanged,
  no_checklist: RECEIVING_CHECKLIST_COPY.noChecklist,
  receipt_not_checkable: RECEIVING_CHECKLIST_COPY.receiptNotCheckable,
  checklist_run_changed: RECEIVING_CHECKLIST_COPY.runChanged,
  checklist_run_completed: RECEIVING_CHECKLIST_COPY.runCompleted,
};

type PgError = {
  code?: string | null;
  message: string;
  hint?: string | null;
  details?: string | null;
};

/**
 * The functions' refusals, by SQLSTATE and hint (pattern #28):
 *   42501 not_authenticated: unauthenticated; not_recorder / not_publisher:
 *         forbidden with that reason; not_member or no hint: forbidden.
 *   P0002: not_found.
 *   P0001 module_disabled: module_disabled (403); a known hint: conflict with
 *         details.reason; any other P0001: conflict 'unknown'.
 *   22023 checklist_invalid: validation_error naming the step or field
 *         (details from our own allow-list, never database text);
 *         checklist_incomplete: validation_error with the step keys.
 *   55P03 (a lock past lock_timeout) and 57014: conflict 'busy', retryable.
 *   Anything else: internal_error (its text stays in the server log).
 */
export function mapChecklistError(
  error: PgError,
  steps: readonly ChecklistStep[] = [],
): ServiceError {
  const hint = error.hint ?? null;
  switch (error.code) {
    case '42501':
      if (hint === 'not_authenticated')
        return new ServiceError('unauthenticated', 'Sign in again to continue.');
      if (hint === 'not_recorder') {
        return new ServiceError('forbidden', RECEIVING_CHECKLIST_COPY.notRecorder, {
          reason: 'not_recorder',
        });
      }
      if (hint === 'not_publisher') {
        return new ServiceError('forbidden', RECEIVING_CHECKLIST_COPY.notPublisher, {
          reason: 'not_publisher',
        });
      }
      return new ServiceError('forbidden', 'You do not have access to this receiving checklist.', {
        reason: 'not_member',
      });
    case 'P0002':
      return hint === 'receipt_not_found'
        ? new ServiceError('not_found', RECEIVING_CHECKLIST_COPY.receiptNotFound)
        : new ServiceError('not_found', RECEIVING_CHECKLIST_COPY.runNotFound);
    case 'P0001': {
      if (hint === 'module_disabled') {
        return new ServiceError('module_disabled', RECEIVING_CHECKLIST_COPY.moduleDisabled, {
          reason: 'module_disabled',
        });
      }
      const reason = hint !== null && hint in CONFLICT_COPY ? hint : 'unknown';
      return new ServiceError(
        'conflict',
        CONFLICT_COPY[reason] ?? 'The checklist could not be saved as it was.',
        {
          reason,
        },
      );
    }
    case '22023': {
      if (hint === 'checklist_incomplete') {
        const detail = parseChecklistIncompleteDetail(error.details ?? null, steps);
        return new ServiceError(
          'validation_error',
          describeChecklistIncomplete(detail, steps) || RECEIVING_CHECKLIST_COPY.loadFailed,
          {
            reason: 'checklist_incomplete',
            ...detail,
          },
        );
      }
      const detail = parseChecklistInvalidDetail(error.details ?? null);
      if (detail) {
        return new ServiceError('validation_error', describeChecklistInvalid(detail, steps), {
          reason: 'checklist_invalid',
          invalid: detail.reason,
          field: detail.field,
          ...(detail.step !== undefined ? { step: detail.step } : {}),
          ...(detail.key !== undefined ? { key: detail.key } : {}),
        });
      }
      return new ServiceError('validation_error', 'That checklist is not valid.', {
        reason: 'checklist_invalid',
      });
    }
    case '55P03':
    case '57014':
      return new ServiceError('conflict', RECEIVING_CHECKLIST_COPY.busy, {
        reason: 'busy',
        retryable: true,
      });
  }
  return new ServiceError('internal_error', postgrestErrorText(error));
}

/** The gate for this caller (core receivingGate, from the effective permissions). */
export const gateFor = receivingGateFor;

export class ReceivingChecklistService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<ReceivingChecklistService> {
    return new ReceivingChecklistService(await withContext());
  }

  /** core receivingGate for this caller (no read): the PO page's Receive and Record rules. */
  gate(): ReceivingGate {
    return gateFor(this.ctx);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The editor: the live version, the earlier ones, and what the caller may do. */
  async getEditor(): Promise<ChecklistEditorView> {
    assertModuleEnabled(this.ctx, 'receiving');
    assertPermission(this.ctx, 'purchase_orders:read');
    const gate = gateFor(this.ctx);
    const org = this.ctx.organizationId;
    const ctx = this.ctx;

    // Paged (pattern #3): every version, newest first. version_number is
    // unique per organization and binding, so the order is stable.
    const [versions, timeZone] = await Promise.all([
      fetchAllRows<VersionRow>((from, to) =>
        ctx.supabase
          .from('checklist_versions')
          .select(VERSION_SELECT)
          .eq('organization_id', org)
          .eq('binding', RECEIVING_CHECKLIST_BINDING)
          .order('version_number', { ascending: false })
          .range(from, to),
      ),
      this.readOrgTimeZone(),
    ]);

    const showProcedures = gate.canPublishChecklist && isModuleEnabled(ctx, 'procedures');
    const [names, runCounts, procedures, procedureTitles] = await Promise.all([
      this.readNames(versions.flatMap((v) => [v.published_by, v.retired_by])),
      gate.canPublishChecklist ? this.readRunCounts() : Promise.resolve(null),
      showProcedures ? this.readLiveProcedures() : Promise.resolve(null),
      this.readProcedureTitles(versions.map((v) => v.procedure_id)),
    ]);

    const view = (v: VersionRow): ChecklistVersionView => ({
      id: v.id,
      versionNumber: v.version_number,
      title: v.title,
      steps: parseStoredSteps(v.steps),
      procedureId: v.procedure_id,
      procedureTitle: v.procedure_id ? (procedureTitles?.get(v.procedure_id) ?? null) : null,
      publishedAt: v.published_at,
      publishedByName: this.label(names, v.published_by, v.deleted_users, 'published_by'),
      retiredAt: v.retired_at,
      retiredByName: v.retired_at
        ? this.label(names, v.retired_by, v.deleted_users, 'retired_by')
        : null,
      runCount: runCounts ? (runCounts.get(v.id) ?? 0) : null,
    });
    const live = versions.find((v) => v.retired_at === null) ?? null;
    return {
      live: live ? view(live) : null,
      history: versions.filter((v) => v.retired_at !== null).map(view),
      nextVersionNumber: (versions[0]?.version_number ?? 0) + 1,
      gate,
      procedures: procedures === 'unavailable' ? null : procedures,
      proceduresUnavailable: procedures === 'unavailable',
      timeZone,
    };
  }

  /**
   * The org's versions and the PO's runs, for the PO page and the phone: two
   * indexed reads in parallel, summaries in core. Never throws (pattern #1):
   * any failure answers { ok: false }, which every surface shows as "Checklist
   * status didn't load", never as "not recorded".
   */
  async forPurchaseOrder(poId: string): Promise<PoChecklists> {
    try {
      const ctx = this.ctx;
      const org = ctx.organizationId;
      // Both reads paged (pattern #3): a short list would label a receipt
      // "not recorded" when its run was only past the 1000-row cap.
      const [versions, runs] = await Promise.all([
        fetchAllRows<
          Pick<
            VersionRow,
            'id' | 'version_number' | 'title' | 'steps' | 'published_at' | 'retired_at'
          >
        >((from, to) =>
          ctx.supabase
            .from('checklist_versions')
            .select('id, version_number, title, steps, published_at, retired_at')
            .eq('organization_id', org)
            .eq('binding', RECEIVING_CHECKLIST_BINDING)
            .order('version_number', { ascending: false })
            .range(from, to),
        ),
        fetchAllRows<RunRow>((from, to) =>
          ctx.supabase
            .from('checklist_runs')
            .select(RUN_SELECT)
            .eq('organization_id', org)
            .eq('purchase_order_id', poId)
            .order('started_at', { ascending: false })
            .order('id')
            .range(from, to),
        ),
      ]);
      const names = await this.readNames(runs.flatMap((r) => [r.started_by, r.completed_by]));
      return {
        ok: true,
        versions: versions.map((v) => ({
          id: v.id,
          versionNumber: v.version_number,
          title: v.title,
          steps: parseStoredSteps(v.steps),
          publishedAt: v.published_at,
          retiredAt: v.retired_at,
        })),
        runs: runs.map((r) => this.runLite(r, names)),
      };
    } catch (err) {
      void reportError(new Error(rawErrorText(err)), {
        tag: 'receiving_checklist.for_po',
        level: 'warning',
        organizationId: this.ctx.organizationId,
      });
      return { ok: false };
    }
  }

  /**
   * forPurchaseOrder for the API (the phone's PO screen): purchase_orders:read
   * first, and a PO the caller cannot see is not found (never an empty list).
   * The checklist reads themselves still never throw.
   */
  async checksForPo(poId: string): Promise<PoChecklists> {
    assertPermission(this.ctx, 'purchase_orders:read');
    const { data, error } = await this.ctx.supabase
      .from('purchase_orders')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', poId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', postgrestErrorText(error));
    if (!data) throw new ServiceError('not_found', 'Purchase order not found.');
    return this.forPurchaseOrder(poId);
  }

  /**
   * One run for its page: the run, its version, the receipt and its lines, the
   * PO, and "About this delivery". A read that the page states a fact from
   * throws or answers 'unavailable'; it never reads as "none" (pattern #28).
   */
  async getRun(runId: string): Promise<ReceivingRunView> {
    assertPermission(this.ctx, 'purchase_orders:read');
    const ctx = this.ctx;
    const org = ctx.organizationId;

    const runRes = await ctx.supabase
      .from('checklist_runs')
      .select(RUN_SELECT)
      .eq('organization_id', org)
      .eq('id', runId)
      .maybeSingle();
    if (runRes.error)
      throw new ServiceError('internal_error', postgrestErrorText(runRes.error, runRes));
    const run = runRes.data as RunRow | null;
    if (!run || !run.receipt_id)
      throw new ServiceError('not_found', RECEIVING_CHECKLIST_COPY.runNotFound);

    const [
      versionRes,
      newestRes,
      receiptRes,
      reversalRes,
      poRes,
      warehouseRes,
      receiptLines,
      timeZone,
    ] = await Promise.all([
      ctx.supabase
        .from('checklist_versions')
        .select(VERSION_SELECT)
        .eq('id', run.version_id)
        .maybeSingle(),
      ctx.supabase
        .from('checklist_versions')
        .select('version_number')
        .eq('organization_id', org)
        .eq('binding', RECEIVING_CHECKLIST_BINDING)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle(),
      ctx.supabase
        .from('receipts')
        .select('id, receipt_number, status, received_at')
        .eq('organization_id', org)
        .eq('id', run.receipt_id)
        .maybeSingle(),
      ctx.supabase
        .from('receipts')
        .select('received_at')
        .eq('organization_id', org)
        .eq('reversed_receipt_id', run.receipt_id)
        .eq('status', 'reversal')
        .order('received_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      ctx.supabase
        .from('purchase_orders')
        .select('id, po_number, supplier_id, charter_id')
        .eq('organization_id', org)
        .eq('id', run.purchase_order_id)
        .maybeSingle(),
      ctx.supabase.from('warehouses').select('name').eq('id', run.warehouse_id).maybeSingle(),
      fetchAllRows<{
        id: string;
        item_id: string;
        qty_received_base: number;
        qty_accepted_base: number;
      }>((from, to) =>
        ctx.supabase
          .from('receipt_lines')
          .select('id, item_id, qty_received_base, qty_accepted_base')
          .eq('receipt_id', run.receipt_id as string)
          .order('id')
          .range(from, to),
      ),
      this.readOrgTimeZone(),
    ]);
    for (const r of [versionRes, newestRes, receiptRes, reversalRes, poRes]) {
      if (r.error) throw new ServiceError('internal_error', postgrestErrorText(r.error, r));
    }
    const version = versionRes.data as VersionRow | null;
    const receipt = receiptRes.data as {
      id: string;
      receipt_number: string;
      status: string;
      received_at: string;
    } | null;
    const po = poRes.data as {
      id: string;
      po_number: string;
      supplier_id: string | null;
      charter_id: string | null;
    } | null;
    // The run is visible only when its PO is, and both rows are its own: a
    // missing one is a run the caller cannot fully see. Say not found.
    if (!version || !receipt || !po)
      throw new ServiceError('not_found', RECEIVING_CHECKLIST_COPY.runNotFound);

    const itemIds = Array.from(new Set(receiptLines.map((l) => l.item_id)));
    const [names, supplierName, items, billTo, stillToCome, procedure] = await Promise.all([
      this.readNames([run.started_by, run.completed_by]),
      this.readSupplierName(po.supplier_id),
      this.readItems(itemIds),
      this.readBillTo(po.charter_id),
      this.readStillToCome(po.id),
      this.readProcedure(version.procedure_id),
    ]);

    const stockOwner = await this.stockOwnerClaim(itemIds, items);
    const newest = (newestRes.data as { version_number: number } | null)?.version_number ?? null;
    const lite = this.runLite(run, names);
    const warehouseName = (warehouseRes.data as { name?: string } | null)?.name ?? null;

    return {
      run: {
        id: run.id,
        status: run.status,
        results: lite.results,
        note: run.note,
        revision: run.revision,
        startedAt: run.started_at,
        startedByName: lite.startedByName,
        completedAt: run.completed_at,
        completedByName: lite.completedByName,
      },
      version: {
        id: version.id,
        versionNumber: version.version_number,
        title: version.title,
        steps: parseStoredSteps(version.steps),
        procedure,
      },
      newerVersionNumber: newest !== null && newest > version.version_number ? newest : null,
      receipt: {
        id: receipt.id,
        receiptNumber: receipt.receipt_number,
        status: receipt.status,
        receivedAt: receipt.received_at,
        reversedAt: (reversalRes.data as { received_at?: string } | null)?.received_at ?? null,
      },
      po: { id: po.id, poNumber: po.po_number, supplierName },
      about: {
        unitsReceived: receiptLines.reduce((s, l) => s + Number(l.qty_received_base || 0), 0),
        lineCount: receiptLines.length,
        warehouseName,
        stockOwner,
        billTo,
        stillToCome,
      },
      lines: receiptLines.map((l) => {
        const item = items === 'unavailable' ? undefined : items.get(l.item_id);
        return {
          itemName: item?.name ?? 'Item',
          sku: item?.sku ?? '',
          qtyReceived: Number(l.qty_received_base) || 0,
          qtyAccepted: Number(l.qty_accepted_base) || 0,
        };
      }),
      canRecord: gateFor(ctx).canRecordChecklist,
      timeZone,
    };
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async publish(input: PublishInput): Promise<ChecklistVersionView> {
    assertModuleEnabled(this.ctx, 'receiving');
    assertPermission(this.ctx, 'purchase_orders:manage');
    if (!gateFor(this.ctx).canPublishChecklist) {
      throw new ServiceError('forbidden', RECEIVING_CHECKLIST_COPY.notPublisher, {
        reason: 'not_publisher',
      });
    }
    const startedAt = Date.now();
    const { data, error } = await this.ctx.supabase.rpc('checklist_publish', {
      p_org: this.ctx.organizationId,
      p_binding: RECEIVING_CHECKLIST_BINDING,
      p_title: input.title,
      p_steps: input.steps,
      p_procedure_id: input.procedureId ?? null,
      p_expected_current: input.expectedCurrentId,
      p_client_publish_id: input.clientPublishId,
    });
    if (error) throw mapChecklistError(error);
    const row = data as unknown as VersionRow;
    if (!isReplay(row.published_at, startedAt)) {
      await audit(
        {
          event: 'receiving_checklist.published',
          entityType: 'checklist_version',
          entityId: row.id,
          after: {
            versionNumber: row.version_number,
            title: row.title,
            stepCount: parseStoredSteps(row.steps).length,
            procedureId: row.procedure_id,
          },
          extra: { replacedVersionId: input.expectedCurrentId },
        },
        this.ctx,
      );
    }
    const names = await this.readNames([row.published_by]);
    return {
      id: row.id,
      versionNumber: row.version_number,
      title: row.title,
      steps: parseStoredSteps(row.steps),
      procedureId: row.procedure_id,
      procedureTitle: null,
      publishedAt: row.published_at,
      publishedByName: this.label(names, row.published_by, row.deleted_users, 'published_by'),
      retiredAt: row.retired_at,
      retiredByName: null,
      runCount: 0,
    };
  }

  async retire(input: { versionId: string }): Promise<{ id: string; versionNumber: number }> {
    assertModuleEnabled(this.ctx, 'receiving');
    assertPermission(this.ctx, 'purchase_orders:manage');
    if (!gateFor(this.ctx).canPublishChecklist) {
      throw new ServiceError('forbidden', RECEIVING_CHECKLIST_COPY.notPublisher, {
        reason: 'not_publisher',
      });
    }
    const { data, error } = await this.ctx.supabase.rpc('checklist_retire', {
      p_org: this.ctx.organizationId,
      p_binding: RECEIVING_CHECKLIST_BINDING,
      p_version_id: input.versionId,
    });
    if (error) throw mapChecklistError(error);
    const row = data as unknown as VersionRow;
    await audit(
      {
        event: 'receiving_checklist.retired',
        entityType: 'checklist_version',
        entityId: row.id,
        after: { versionNumber: row.version_number, retiredAt: row.retired_at },
      },
      this.ctx,
    );
    return { id: row.id, versionNumber: row.version_number };
  }

  async start(receiptId: string): Promise<StartResult> {
    assertModuleEnabled(this.ctx, 'receiving');
    assertPermission(this.ctx, 'stock:adjust');
    if (!gateFor(this.ctx).canRecordChecklist) {
      throw new ServiceError('forbidden', RECEIVING_CHECKLIST_COPY.notRecorder, {
        reason: 'not_recorder',
      });
    }
    const { data, error } = await this.ctx.supabase.rpc('receiving_check_start', {
      p_receipt_id: receiptId,
    });
    if (error) throw mapChecklistError(error);
    const res = (data ?? {}) as { runId?: unknown; created?: unknown; versionNumber?: unknown };
    if (typeof res.runId !== 'string') {
      throw new ServiceError('internal_error', 'receiving_check_start answered without a run id');
    }
    const result: StartResult = {
      runId: res.runId,
      created: res.created === true,
      versionNumber: typeof res.versionNumber === 'number' ? res.versionNumber : null,
    };
    if (result.created) {
      await audit(
        {
          event: 'receiving_check.started',
          entityType: 'checklist_run',
          entityId: result.runId,
          after: { receiptId, versionNumber: result.versionNumber },
        },
        this.ctx,
      );
    }
    return result;
  }

  async saveRun(input: SaveRunInput): Promise<SavedRun> {
    assertModuleEnabled(this.ctx, 'receiving');
    assertPermission(this.ctx, 'stock:adjust');
    if (!gateFor(this.ctx).canRecordChecklist) {
      throw new ServiceError('forbidden', RECEIVING_CHECKLIST_COPY.notRecorder, {
        reason: 'not_recorder',
      });
    }
    const startedAt = Date.now();
    const { data, error } = await this.ctx.supabase.rpc('checklist_run_save', {
      p_run_id: input.runId,
      p_results: input.results,
      p_note: input.note ?? null,
      p_expected_revision: input.expectedRevision,
      p_save_id: input.saveId,
      p_complete: input.complete,
    });
    if (error) {
      // A refusal that names steps is worded with the run's own labels.
      const steps =
        error.hint === 'checklist_incomplete' || error.hint === 'checklist_invalid'
          ? await this.readRunSteps(input.runId)
          : [];
      const mapped = mapChecklistError(error, steps);
      if (error.hint === 'checklist_run_completed') {
        const by = await this.readCompletedByName(input.runId);
        if (by) {
          throw new ServiceError('conflict', RECEIVING_CHECKLIST_COPY.runCompletedBy(by), {
            reason: 'checklist_run_completed',
          });
        }
      }
      throw mapped;
    }
    const row = data as unknown as RunRow;
    if (input.complete && row.status === 'completed' && !isReplay(row.completed_at, startedAt)) {
      const steps = await this.readRunSteps(row.id);
      const results = parseStoredResults(row.results);
      const failed = steps.filter(
        (s) => s.kind === 'check' && results[s.key]?.value === 'fail',
      ).length;
      await audit(
        {
          event: 'receiving_check.completed',
          entityType: 'checklist_run',
          entityId: row.id,
          after: { receiptId: row.receipt_id, revision: row.revision, failedChecks: failed },
        },
        this.ctx,
      );
    }
    return {
      id: row.id,
      status: row.status,
      revision: row.revision,
      results: parseStoredResults(row.results),
      note: row.note,
      completedAt: row.completed_at,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private runLite(r: RunRow, names: Map<string, string> | null): ChecklistRunLite {
    return {
      id: r.id,
      receiptId: r.receipt_id,
      versionId: r.version_id,
      status: r.status,
      results: parseStoredResults(r.results),
      startedAt: r.started_at,
      startedByName: this.label(names, r.started_by, r.deleted_users, 'started_by'),
      completedAt: r.completed_at,
      completedByName: r.completed_at
        ? this.label(names, r.completed_by, r.deleted_users, 'completed_by')
        : null,
    };
  }

  /** A person's label: "Deleted user" for a stamped null (0393), the name, or
   *  "Former member" for someone the reader cannot see; "—" when the name
   *  lookup failed. */
  private label(
    names: Map<string, string> | null,
    id: string | null,
    marks: unknown,
    column: string,
  ): string {
    if (isDeletedPerson(id, marks, column)) return DELETED_USER_LABEL;
    if (names === null && id) return '—';
    return personLabel({
      id,
      name: id ? (names?.get(id) ?? null) : null,
      marks,
      column,
      nullLabel: '—',
    });
  }

  /** Names for display (cosmetic): null when the lookup failed, never thrown. */
  private async readNames(ids: ReadonlyArray<string | null>): Promise<Map<string, string> | null> {
    const unique = Array.from(
      new Set(ids.filter((v): v is string => typeof v === 'string' && v.length > 0)),
    );
    const out = new Map<string, string>();
    if (unique.length === 0) return out;
    const ctx = this.ctx;
    try {
      const profiles = await fetchAllRowsByIds<ProfileRow>(
        unique,
        (batch) => (from, to) =>
          ctx.supabase
            .from('user_profiles')
            .select('id, full_name, email')
            .in('id', batch)
            .order('id')
            .range(from, to),
      );
      for (const p of profiles) out.set(p.id, (p.full_name || p.email || '').trim());
      return out;
    } catch (err) {
      reportDegradedRead('receiving_checklist.names', err, { users: unique.length });
      return null;
    }
  }

  private async readOrgTimeZone(): Promise<string> {
    try {
      const { data, error } = await this.ctx.supabase
        .from('organizations')
        .select('timezone')
        .eq('id', this.ctx.organizationId)
        .maybeSingle();
      if (error) return resolveOrgTimezone(null);
      return resolveOrgTimezone((data as { timezone?: string | null } | null)?.timezone ?? null);
    } catch {
      return resolveOrgTimezone(null);
    }
  }

  /** Runs per version for a publisher (managers see every PO, so the count is whole). */
  private async readRunCounts(): Promise<Map<string, number> | null> {
    const ctx = this.ctx;
    try {
      const rows = await fetchAllRows<{ id: string; version_id: string }>((from, to) =>
        ctx.supabase
          .from('checklist_runs')
          .select('id, version_id')
          .eq('organization_id', ctx.organizationId)
          .order('id')
          .range(from, to),
      );
      const out = new Map<string, number>();
      for (const r of rows) out.set(r.version_id, (out.get(r.version_id) ?? 0) + 1);
      return out;
    } catch (err) {
      reportDegradedRead('receiving_checklist.run_counts', err);
      return null;
    }
  }

  private async readLiveProcedures(): Promise<
    Array<{ id: string; title: string }> | 'unavailable'
  > {
    const ctx = this.ctx;
    try {
      const rows = await fetchAllRows<{ id: string; title: string }>((from, to) =>
        ctx.supabase
          .from('procedures')
          .select('id, title')
          .eq('organization_id', ctx.organizationId)
          .is('archived_at', null)
          .order('title')
          .order('id')
          .range(from, to),
      );
      return rows.map((r) => ({ id: r.id, title: r.title }));
    } catch (err) {
      reportDegradedRead('receiving_checklist.procedures', err);
      return 'unavailable';
    }
  }

  private async readProcedureTitles(
    ids: ReadonlyArray<string | null>,
  ): Promise<Map<string, string> | null> {
    const unique = Array.from(new Set(ids.filter((v): v is string => typeof v === 'string')));
    const out = new Map<string, string>();
    if (unique.length === 0 || !isModuleEnabled(this.ctx, 'procedures')) return out;
    const ctx = this.ctx;
    try {
      const rows = await fetchAllRowsByIds<{ id: string; title: string }>(
        unique,
        (batch) => (from, to) =>
          ctx.supabase
            .from('procedures')
            .select('id, title')
            .in('id', batch)
            .order('id')
            .range(from, to),
      );
      for (const r of rows) out.set(r.id, r.title);
      return out;
    } catch (err) {
      reportDegradedRead('receiving_checklist.procedure_titles', err);
      return null;
    }
  }

  private async readProcedure(id: string | null): Promise<{ id: string; title: string } | null> {
    if (!id || !isModuleEnabled(this.ctx, 'procedures')) return null;
    const titles = await this.readProcedureTitles([id]);
    const title = titles?.get(id);
    return title ? { id, title } : null;
  }

  private async readSupplierName(id: string | null): Promise<string | null> {
    if (!id) return null;
    try {
      const { data, error } = await this.ctx.supabase
        .from('suppliers')
        .select('name')
        .eq('id', id)
        .maybeSingle();
      if (error) {
        reportDegradedRead('receiving_checklist.supplier', error);
        return null;
      }
      return (data as { name?: string } | null)?.name ?? null;
    } catch (err) {
      reportDegradedRead('receiving_checklist.supplier', err);
      return null;
    }
  }

  private async readItems(
    itemIds: readonly string[],
  ): Promise<Map<string, { name: string; sku: string; charterId: string | null }> | 'unavailable'> {
    const out = new Map<string, { name: string; sku: string; charterId: string | null }>();
    if (itemIds.length === 0) return out;
    const ctx = this.ctx;
    try {
      const rows = await fetchAllRowsByIds<{
        id: string;
        name: string;
        sku: string | null;
        charter_id: string | null;
      }>(
        itemIds,
        (batch) => (from, to) =>
          ctx.supabase
            .from('inventory_items')
            .select('id, name, sku, charter_id')
            .in('id', batch)
            .order('id')
            .range(from, to),
      );
      for (const r of rows)
        out.set(r.id, { name: r.name, sku: r.sku ?? '', charterId: r.charter_id });
      return out;
    } catch (err) {
      reportDegradedRead('receiving_checklist.items', err, { items: itemIds.length });
      return 'unavailable';
    }
  }

  /**
   * "Stock owner on these items now": the charters of the received items, read
   * under the caller's RLS. A short item read returns no error, so "none set"
   * is claimed only when EVERY line's item came back and none has a charter;
   * fewer rows than items, or a failed charter read, is "didn't load"
   * (refresh c11, pattern #28).
   */
  private async stockOwnerClaim(
    itemIds: readonly string[],
    items: Map<string, { name: string; sku: string; charterId: string | null }> | 'unavailable',
  ): Promise<AboutClaim<string[]>> {
    if (items === 'unavailable' || items.size < itemIds.length) return { kind: 'unavailable' };
    const charterIds = Array.from(
      new Set(
        [...items.values()]
          .map((i) => i.charterId)
          .filter((v): v is string => typeof v === 'string'),
      ),
    );
    if (charterIds.length === 0) return { kind: 'ok', value: [] };
    const names = await this.readCharterNames(charterIds);
    if (names === null || names.size < charterIds.length) return { kind: 'unavailable' };
    return {
      kind: 'ok',
      value: charterIds.map((id) => names.get(id) as string).sort((a, b) => a.localeCompare(b)),
    };
  }

  private async readBillTo(charterId: string | null): Promise<AboutClaim<string | null>> {
    if (!charterId) return { kind: 'ok', value: null };
    const names = await this.readCharterNames([charterId]);
    const name = names?.get(charterId);
    return name ? { kind: 'ok', value: name } : { kind: 'unavailable' };
  }

  private async readCharterNames(ids: readonly string[]): Promise<Map<string, string> | null> {
    const ctx = this.ctx;
    try {
      const rows = await fetchAllRowsByIds<{ id: string; name: string }>(
        ids,
        (batch) => (from, to) =>
          ctx.supabase
            .from('charters')
            .select('id, name')
            .in('id', batch)
            .order('id')
            .range(from, to),
      );
      return new Map(rows.map((r) => [r.id, r.name]));
    } catch (err) {
      reportDegradedRead('receiving_checklist.charters', err, { charters: ids.length });
      return null;
    }
  }

  /** Lines of the PO with less received than ordered, now. */
  private async readStillToCome(poId: string): Promise<AboutClaim<number>> {
    const ctx = this.ctx;
    try {
      const rows = await fetchAllRows<{
        id: string;
        quantity_ordered: number;
        quantity_received: number;
      }>((from, to) =>
        ctx.supabase
          .from('purchase_order_items')
          .select('id, quantity_ordered, quantity_received')
          .eq('purchase_order_id', poId)
          .order('id')
          .range(from, to),
      );
      return {
        kind: 'ok',
        value: rows.filter((r) => Number(r.quantity_received) < Number(r.quantity_ordered)).length,
      };
    } catch (err) {
      reportDegradedRead('receiving_checklist.still_to_come', err);
      return { kind: 'unavailable' };
    }
  }

  /** The steps of a run's version, to word a refusal; [] when unreadable. */
  private async readRunSteps(runId: string): Promise<ChecklistStep[]> {
    try {
      const { data, error } = await this.ctx.supabase
        .from('checklist_runs')
        .select('version_id')
        .eq('id', runId)
        .maybeSingle();
      if (error || !data) return [];
      const v = await this.ctx.supabase
        .from('checklist_versions')
        .select('steps')
        .eq('id', (data as { version_id: string }).version_id)
        .maybeSingle();
      if (v.error || !v.data) return [];
      return parseStoredSteps((v.data as { steps: unknown }).steps);
    } catch {
      return [];
    }
  }

  private async readCompletedByName(runId: string): Promise<string | null> {
    try {
      const { data, error } = await this.ctx.supabase
        .from('checklist_runs')
        .select('completed_by, deleted_users')
        .eq('id', runId)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as { completed_by: string | null; deleted_users?: unknown };
      const names = await this.readNames([row.completed_by]);
      const label = this.label(names, row.completed_by, row.deleted_users, 'completed_by');
      return label === '—' ? null : label;
    } catch {
      return null;
    }
  }
}

/** A row the call answered but did not make (a replay of an earlier write). */
function isReplay(madeAt: string | null | undefined, callStartedAt: number): boolean {
  if (!madeAt) return false;
  const t = Date.parse(madeAt);
  return Number.isFinite(t) && t < callStartedAt - REPLAY_MARGIN_MS;
}

/** For tests: the incomplete detail the service attaches, re-read from a ServiceError. */
export function incompleteDetailOf(e: ServiceError): ChecklistIncompleteDetail | null {
  const d = e.details as (Partial<ChecklistIncompleteDetail> & { reason?: string }) | undefined;
  if (!d || d.reason !== 'checklist_incomplete') return null;
  return {
    missing: d.missing ?? [],
    failedWithoutNote: d.failedWithoutNote ?? [],
    photoStepsWithoutPhoto: d.photoStepsWithoutPhoto ?? [],
  };
}
