import 'server-only';

import { createHash } from 'node:crypto';

import { audit } from './audit';
import { InventoryService } from './inventory';
import {
  VendorItemMappingsService,
} from './vendor-item-mappings';
import {
  matchByVendorNumber,
  type MappingRow,
} from './vendor-item-mappings-match';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import {
  createItemsFromPoLines,
  findDuplicatesForPoLines,
  type CreateItemsFromPoLinesInput,
  type DuplicateCandidate,
} from './po-imports-lines';
import { buildPoCharges } from '@/lib/po-imports/charges';
import { parsePoFile, type ParseSourceType } from '@/lib/po-parser';
import { extractPoFromMedia, SCAN_MODEL_NAME } from '@/lib/po-scan/extract';
import { createAdminClient } from '@/lib/supabase/admin';

import type {
  ApprovePoImportInput,
  CanonicalPo,
  PoImportLineType,
  PoImportMatchStatus,
  PoImportStatus,
} from '@stockpilot/core';

export interface PoImportRow {
  id: string;
  organization_id: string;
  uploaded_by: string;
  source_type: ParseSourceType | 'xlsx' | 'manual' | 'scan';
  extraction_confidence: number | null;
  extraction_model: string | null;
  vendor_id: string | null;
  warehouse_id: string | null;
  file_name: string;
  file_mime_type: string;
  file_size: number;
  storage_path: string;
  sha256: string;
  status: PoImportStatus;
  parse_error: string | null;
  approved_po_id: string | null;
  /** Re-import lineage (mig 0286): the earlier import of this same file whose
   *  purchase order was cancelled. Null for a first import. */
  reimported_from_id: string | null;
  /** Set when a LATER import re-used this file (mig 0287). Means ONLY "no
   *  longer the live import for this hash" — status, approved_po_id, lines and
   *  the stored document are all deliberately left intact. */
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One end of a re-import chain, resolved for display. */
export interface PoImportLineageRef {
  id: string;
  fileName: string;
  createdAt: string;
  status: PoImportStatus;
  /** The purchase order this import produced (imports only gain one at approve). */
  poId: string | null;
  poNumber: string | null;
  /** purchase_orders.status. 'cancelled' is the case the notice exists to explain. */
  poStatus: string | null;
}

/**
 * Re-import lineage for ONE import, both directions (migs 0286/0287).
 * `predecessor` mirrors reimported_from_id: the earlier import of this same
 * file whose purchase order was cancelled. `successors` mirrors the reverse
 * edge — later imports that re-used this file. An import in the middle of a
 * chain has both, and both notices are correct: it is simultaneously a redo
 * and itself stale.
 */
export interface PoImportLineage {
  predecessor: PoImportLineageRef | null;
  /** Oldest first. In practice at most one — the FK is not unique, so this stays a list. */
  successors: PoImportLineageRef[];
}

export interface PoImportLineRow {
  id: string;
  po_import_id: string;
  line_number: number;
  line_type: PoImportLineType;
  qty_ordered_original: number | null;
  uom_original: string | null;
  description: string | null;
  unit_cost: number | null;
  line_total: number | null;
  vendor_item_number: string | null;
  vendor_product_number: string | null;
  auxiliary_number: string | null;
  coa_code: string | null;
  item_id: string | null;
  /** Advisory "possible existing match" (barcode/ISBN/vendor mapping).
      Informational only — never auto-linked; the user must explicitly
      accept it (decision use_existing) to set item_id. */
  suggested_item_id: string | null;
  match_status: PoImportMatchStatus;
  match_confidence: number | null;
  /** OCR/extraction confidence (0-1). Populated for source_type='scan';
      null for deterministic-parsed CSV/PDF imports (those are 100%). */
  extraction_confidence: number | null;
  exception_reason: string | null;
}

export class PoImportsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new PoImportsService(await withContext());
  }

  /**
   * Lists imports for the imports index page: optional tab-status filter,
   * free-text search, and pagination. Mirrors MovementsService's list()/
   * count() split (same filters, two separate queries) rather than a
   * purpose-built RPC like the purchase-orders page's — po_imports is a
   * desktop-upload workflow (nowhere near PO-ledger scale), so a plain
   * filtered Supabase query is enough and needs no migration.
   *
   * The lineage columns (reimported_from_id, superseded_at) are in the lean
   * column list on purpose: they are a uuid and a timestamptz already ON the
   * row being read, and they let the list mark a stale row without a second
   * query. Leaving them out would force an N+1 (or an aggregate) to answer
   * "was this superseded?" — exactly what the lean list exists to avoid.
   */
  async list(
    params: {
      /** Tab statuses (e.g. the Active/Approved/Cancelled partition). Omitted/empty = no status filter. */
      statuses?: PoImportStatus[] | null;
      /** Free-text search — see searchOrFilter() for exactly what it matches. */
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PoImportRow[]> {
    assertModuleEnabled(this.ctx, 'po_imports');
    let query = this.ctx.supabase
      .from('po_imports')
      .select(
        `id, organization_id, uploaded_by, source_type, vendor_id, warehouse_id,
         file_name, file_mime_type, file_size, storage_path, sha256, status,
         parse_error, approved_po_id, created_at, updated_at,
         extraction_confidence, extraction_model,
         reimported_from_id, superseded_at`,
      )
      .eq('organization_id', this.ctx.organizationId);
    if (params.statuses && params.statuses.length > 0) {
      query = query.in('status', params.statuses);
    }
    const orFilter = await this.searchOrFilter(params.q ?? '');
    if (orFilter) query = query.or(orFilter);
    query = query.order('created_at', { ascending: false });
    if (params.limit != null) {
      const offset = Math.max(0, params.offset ?? 0);
      query = query.range(offset, offset + Math.max(1, params.limit) - 1);
    }
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as PoImportRow[];
  }

  /**
   * Total count for the SAME statuses/q filters `list()` uses — powers the
   * imports page's numbered pagination and per-tab pill counts. Head-only
   * (no rows).
   */
  async count(params: { statuses?: PoImportStatus[] | null; q?: string } = {}): Promise<number> {
    assertModuleEnabled(this.ctx, 'po_imports');
    let query = this.ctx.supabase
      .from('po_imports')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId);
    if (params.statuses && params.statuses.length > 0) {
      query = query.in('status', params.statuses);
    }
    const orFilter = await this.searchOrFilter(params.q ?? '');
    if (orFilter) query = query.or(orFilter);
    const { count, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  /**
   * Builds the `.or()` filter string for a search term: always the file name
   * (ilike, escaped). Plus two CHEAP supplementary lookups for the "supplier/
   * PO-number metadata" the owner asked for — both are plain FK columns
   * already on po_imports (vendor_id, approved_po_id), each resolved via one
   * small id lookup on a normally-sized, indexed table. Deliberately does
   * NOT search parsed_json (jsonb) — that would need a GIN index (a
   * migration) to stay cheap at any scale, which the ask explicitly said not
   * to do speculatively.
   */
  /**
   * Memoized per (instance, q): the imports page calls list() and count()
   * concurrently with the SAME q, and each needs the resolved filter —
   * caching the PROMISE (not the value) means the second caller reuses the
   * in-flight resolution instead of re-running both lookups (2026-07-16
   * perf sweep: a searched render paid 4 lookup queries instead of 2).
   * Instances are per-request (forCurrentUser), so no staleness.
   */
  private searchOrFilterCache = new Map<string, Promise<string | null>>();

  private searchOrFilter(q: string): Promise<string | null> {
    const key = q.trim();
    let p = this.searchOrFilterCache.get(key);
    if (!p) {
      p = this.resolveSearchOrFilter(key);
      this.searchOrFilterCache.set(key, p);
    }
    return p;
  }

  private async resolveSearchOrFilter(trimmed: string): Promise<string | null> {
    if (!trimmed) return null;
    // Strip PostgREST .or()-structural metacharacters (,()%*) BEFORE the
    // wildcard escape — a comma/paren in the term ("Smith, Inc") otherwise
    // malforms the .or() logic tree → PostgREST 400 → the whole list page
    // shows the retry banner. Mirrors BundlesService.list / InventoryService
    // .list (audit 2026-06-09). escapeIlike alone only covers LIKE wildcards.
    const esc = escapeIlike(trimmed.slice(0, 120).replace(/[,()%*]/g, ' ').trim());
    if (!esc) return null;
    const orParts = [`file_name.ilike.%${esc}%`];

    // Both id-lookups are independent — resolve them in parallel.
    const [{ data: suppliers }, { data: pos }] = await Promise.all([
      this.ctx.supabase
        .from('suppliers')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .ilike('name', `%${esc}%`),
      this.ctx.supabase
        .from('purchase_orders')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .ilike('po_number', `%${esc}%`),
    ]);
    const supplierIds = ((suppliers ?? []) as Array<{ id: string }>).map((s) => s.id);
    if (supplierIds.length > 0) {
      orParts.push(`vendor_id.in.(${supplierIds.join(',')})`);
    }
    const poIds = ((pos ?? []) as Array<{ id: string }>).map((p) => p.id);
    if (poIds.length > 0) {
      orParts.push(`approved_po_id.in.(${poIds.join(',')})`);
    }

    return orParts.join(',');
  }

  async get(id: string): Promise<{
    header: PoImportRow;
    lines: PoImportLineRow[];
    lineage: PoImportLineage;
  }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('po_imports')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'PO import not found');
    const { data: lines, error: lErr } = await this.ctx.supabase
      .from('po_import_lines')
      .select('*')
      .eq('po_import_id', id)
      .order('line_number', { ascending: true });
    if (lErr) throw new ServiceError('internal_error', lErr.message);
    const row = header as unknown as PoImportRow;
    return {
      header: row,
      lines: (lines ?? []) as unknown as PoImportLineRow[],
      // Always present so callers never branch on undefined — the COST is
      // gated inside resolveLineage, not here.
      lineage: await this.resolveLineage(row),
    };
  }

  /** PostgREST .or() takes a raw filter string, so only a value proven to be a
   *  bare uuid is ever interpolated into one — mirrors the metacharacter
   *  stripping in resolveSearchOrFilter, which exists because a malformed
   *  .or() tree is a hard 400. */
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Resolves the re-import chain around one import for display (migs 0286/0287).
   *
   * Costs NOTHING for a normal import: both columns null means no queries at
   * all, which is the overwhelming majority of rows. When there IS lineage it
   * is capped at two queries — one po_imports read covering BOTH directions
   * (predecessor by id, successors by the reverse FK), then one purchase_orders
   * read resolving every referenced PO number/status in a single .in(). Both
   * are org-scoped, so another org's identical file stays invisible.
   *
   * Only ONE hop each way is resolved. A longer chain (the production
   * 4db2d72c → 90f9fc56 → 568a0712) is walked by clicking through, which keeps
   * this to a fixed query budget.
   */
  private async resolveLineage(header: PoImportRow): Promise<PoImportLineage> {
    const predId = header.reimported_from_id;
    const isSuperseded = header.superseded_at != null;
    if (!predId && !isSuperseded) return { predecessor: null, successors: [] };

    let query = this.ctx.supabase
      .from('po_imports')
      .select('id, file_name, created_at, status, approved_po_id, reimported_from_id')
      .eq('organization_id', this.ctx.organizationId);

    // Three shapes, one query. .or() is only reached when BOTH directions are
    // live, so the far more common single-direction case never exercises
    // PostgREST's or-tree parsing at all.
    const predUsable = predId != null && PoImportsService.UUID_RE.test(predId);
    if (predUsable && isSuperseded) {
      query = query.or(`id.eq.${predId},reimported_from_id.eq.${header.id}`);
    } else if (predUsable) {
      query = query.eq('id', predId);
    } else {
      query = query.eq('reimported_from_id', header.id);
    }

    const { data, error } = await query.order('created_at', { ascending: true });
    // Lineage is CONTEXT, not the record. A failure here must never 500 the
    // detail page — degrade to "no lineage shown" and log (recurring pattern #1).
    if (error) {
      console.error('[po-imports] lineage lookup failed', {
        importId: header.id,
        message: error.message,
      });
      return { predecessor: null, successors: [] };
    }

    const rows = (data ?? []) as Array<{
      id: string;
      file_name: string;
      created_at: string;
      status: PoImportStatus;
      approved_po_id: string | null;
      reimported_from_id: string | null;
    }>;
    if (rows.length === 0) return { predecessor: null, successors: [] };

    const poIds = [...new Set(rows.map((r) => r.approved_po_id).filter((v): v is string => !!v))];
    const poById = new Map<string, { id: string; po_number: string | null; status: string }>();
    if (poIds.length > 0) {
      const { data: pos, error: poErr } = await this.ctx.supabase
        .from('purchase_orders')
        .select('id, po_number, status')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', poIds);
      // Same reasoning: a missing PO number degrades the copy, it does not
      // break the page.
      if (poErr) {
        console.error('[po-imports] lineage purchase-order lookup failed', {
          importId: header.id,
          message: poErr.message,
        });
      } else {
        for (const p of (pos ?? []) as Array<{
          id: string;
          po_number: string | null;
          status: string;
        }>) {
          poById.set(p.id, p);
        }
      }
    }

    const toRef = (r: (typeof rows)[number]): PoImportLineageRef => {
      const po = r.approved_po_id ? poById.get(r.approved_po_id) : undefined;
      return {
        id: r.id,
        fileName: r.file_name,
        createdAt: r.created_at,
        status: r.status,
        poId: r.approved_po_id,
        poNumber: po?.po_number ?? null,
        poStatus: po?.status ?? null,
      };
    };

    // The predecessor is matched by id; successors by the reverse FK. The
    // `r.id !== predId` guard keeps a (nonsensical) self-reference from being
    // counted on both sides.
    const predRow = predId ? rows.find((r) => r.id === predId) : undefined;
    return {
      predecessor: predRow ? toRef(predRow) : null,
      successors: rows
        .filter((r) => r.id !== predId && r.reimported_from_id === header.id)
        .map(toRef),
    };
  }

  /**
   * Caller has already PUT the file to Storage (presigned URL).
   * This persists the metadata row at status='uploaded' and trusts the
   * caller-computed sha256.
   */
  async createFromUpload(input: {
    sourceType: ParseSourceType | 'xlsx' | 'manual';
    storagePath: string;
    fileName: string;
    fileMimeType: string;
    fileSize: number;
    sha256: string;
  }): Promise<{
    id: string;
    duplicateOf: string | null;
    /** Set when this upload re-uses a file whose previous import produced a
     *  CANCELLED purchase order — the UI shows the reimport notice instead of
     *  bouncing the user to the dead predecessor. */
    reimportOfCancelled: {
      predecessorImportId: string;
      cancelledPoId: string | null;
      cancelledPoNumber: string | null;
    } | null;
  }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');

    // Defense-in-depth: the action schema validates storagePath as a
    // bare string. The presign step builds a per-org path, but the
    // client could call recordPoUploadAction with someone else's path.
    // Storage RLS still refuses cross-org downloads, but a pointer row
    // pointing at another org's file has no business existing.
    const requiredPrefix = `${this.ctx.organizationId}/`;
    if (!input.storagePath.startsWith(requiredPrefix)) {
      throw new ServiceError(
        'validation_error',
        'Invalid storage path — wrong org prefix.',
      );
    }

    // Duplicate decision — see resolveDuplicateBySha256 for the full rule.
    const decision = await this.resolveDuplicateBySha256(input.sha256);
    if (decision.kind === 'blocked') {
      return {
        id: decision.importId,
        duplicateOf: decision.importId,
        reimportOfCancelled: null,
      };
    }

    // Free the hash for exactly one new live import (mig 0287) — without this
    // the insert below hits po_imports_org_sha_uniq (23505).
    if (decision.kind === 'reimport_after_cancelled') {
      await this.supersedePriorImports(input.sha256);
    }

    const { data, error } = await this.ctx.supabase
      .from('po_imports')
      .insert({
        organization_id: this.ctx.organizationId,
        uploaded_by: this.ctx.userId,
        source_type: input.sourceType,
        file_name: input.fileName,
        file_mime_type: input.fileMimeType,
        file_size: input.fileSize,
        storage_path: input.storagePath,
        sha256: input.sha256,
        status: 'uploaded',
        // Lineage (mig 0286): preserve the cancelled predecessor, don't mutate it.
        reimported_from_id: decision.kind === 'reimport_after_cancelled'
          ? decision.predecessorImportId
          : null,
      })
      .select('id')
      .single();
    if (error) {
      if (PoImportsService.isLiveImportCollision(error)) {
        throw new ServiceError(
          'conflict',
          'Someone just imported this same file. Refresh to see their import.',
        );
      }
      throw new ServiceError('internal_error', error.message);
    }
    await audit(
      {
        event: 'po_import.uploaded',
        entityType: 'po_import',
        entityId: data.id as string,
        after: {
          fileName: input.fileName,
          sha256: input.sha256,
          ...(decision.kind === 'reimport_after_cancelled'
            ? {
                reimportOfCancelled: true,
                predecessorImportId: decision.predecessorImportId,
                cancelledPoId: decision.cancelledPoId,
                cancelledPoNumber: decision.cancelledPoNumber,
              }
            : {}),
        },
      },
      this.ctx,
    );
    return {
      id: data.id as string,
      duplicateOf: null,
      reimportOfCancelled:
        decision.kind === 'reimport_after_cancelled'
          ? {
              predecessorImportId: decision.predecessorImportId,
              cancelledPoId: decision.cancelledPoId,
              cancelledPoNumber: decision.cancelledPoNumber,
            }
          : null,
    };
  }

  /**
   * THE authoritative same-file duplicate decision, shared by every import
   * path (CSV/PDF upload AND the AI scan) so they can never drift.
   *
   * A file is fingerprinted by sha256 per org. A prior import blocks a re-upload
   * UNLESS every prior import of that file is dead — i.e. it produced a purchase
   * order that has since been CANCELLED. That is the real-world case this
   * exists for: a PO approved against the wrong charter gets cancelled, and the
   * same document must be importable again to redo it. Cancelling a PO does NOT
   * touch the po_imports row (it stays 'approved'), which is exactly why the
   * naive `status not in (failed,canceled,duplicate)` check blocked forever.
   *
   * Deliberately NOT relaxed for: an in-flight import that never produced a PO
   * (re-uploading should resume that one, not spawn a twin), or an import whose
   * PO is active / partially received / completed — those keep blocking, so
   * duplicate protection for live purchasing is untouched.
   *
   * Returns the NEWEST cancelled predecessor for lineage. Org-scoped throughout,
   * so another organization's identical file is irrelevant.
   */
  private async resolveDuplicateBySha256(sha256: string): Promise<
    | { kind: 'no_duplicate' }
    | { kind: 'blocked'; importId: string }
    | {
        kind: 'reimport_after_cancelled';
        predecessorImportId: string;
        cancelledPoId: string | null;
        cancelledPoNumber: string | null;
      }
  > {
    // NOT maybeSingle(): once a reimport is allowed, several imports legitimately
    // share a hash, and maybeSingle() throws on >1 row (PGRST116) — that would
    // break the SECOND reimport of the same file.
    // Consider only the LIVE import of this file — exactly the row set the
    // po_imports_org_sha_uniq index covers (live status AND not superseded).
    //
    // `superseded_at IS NULL` is NOT optional. A superseded import keeps its
    // status ('approved'), so without this filter it still looked like a
    // blocking prior, while supersedePriorImports (which correctly skips
    // already-superseded rows) matched nothing — the zero-row guard then threw
    // "Could not re-open this file for import" on a file that had no live
    // import at all. A superseded row is history: it neither blocks nor needs
    // re-stamping.
    const { data: priors, error } = await this.ctx.supabase
      .from('po_imports')
      .select('id, status, approved_po_id, created_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('sha256', sha256)
      .not('status', 'in', '(failed,canceled,duplicate)')
      .is('superseded_at', null)
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);

    const rows = (priors ?? []) as Array<{
      id: string;
      status: string;
      approved_po_id: string | null;
      created_at: string;
    }>;
    if (rows.length === 0) return { kind: 'no_duplicate' };

    // An import that never produced a PO still blocks — re-uploading should land
    // the user back on that in-flight import rather than create a twin.
    const inFlight = rows.find((r) => !r.approved_po_id);
    if (inFlight) return { kind: 'blocked', importId: inFlight.id };

    const poIds = [...new Set(rows.map((r) => r.approved_po_id).filter((v): v is string => !!v))];
    const { data: pos, error: poErr } = await this.ctx.supabase
      .from('purchase_orders')
      .select('id, status, po_number')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', poIds);
    if (poErr) throw new ServiceError('internal_error', poErr.message);
    const poById = new Map(
      ((pos ?? []) as Array<{ id: string; status: string; po_number: string | null }>).map((p) => [
        p.id,
        p,
      ]),
    );

    // Any prior whose PO is still alive (active / ordered / partially or fully
    // received / completed) keeps blocking. Only 'cancelled' frees the file.
    for (const r of rows) {
      const po = r.approved_po_id ? poById.get(r.approved_po_id) : undefined;
      // A missing/foreign PO row is treated as still-blocking (fail closed).
      if (!po || po.status !== 'cancelled') {
        return { kind: 'blocked', importId: r.id };
      }
    }

    const newest = rows[0]!;
    const po = newest.approved_po_id ? poById.get(newest.approved_po_id) : undefined;
    return {
      kind: 'reimport_after_cancelled',
      predecessorImportId: newest.id,
      cancelledPoId: po?.id ?? null,
      cancelledPoNumber: po?.po_number ?? null,
    };
  }

  /**
   * Frees a file's hash for exactly one new live import by stamping every prior
   * import of it `superseded_at` (mig 0287). REQUIRED before inserting a
   * reimport: the partial unique index po_imports_org_sha_uniq covers live,
   * non-superseded rows, so without this the insert dies with 23505 (that was
   * the 500 on the scan route).
   *
   * Only ever called after resolveDuplicateBySha256 has confirmed EVERY prior
   * import's purchase order is cancelled. Deliberately does NOT touch status,
   * approved_po_id, lines, documents or the cancelled PO — the predecessor stays
   * fully intact for audit; this flag only means "no longer the live import".
   */
  private async supersedePriorImports(sha256: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('po_imports')
      .update({ superseded_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('sha256', sha256)
      .is('superseded_at', null)
      // Same status set the index (and resolveDuplicateBySha256) uses. Already
      // failed/canceled/duplicate rows are outside the index, so stamping them
      // would change nothing except muddy what superseded_at means.
      .not('status', 'in', '(failed,canceled,duplicate)')
      // .select() so a silent no-op can't fail OPEN into a 23505 on the
      // insert (recurring pattern: .update().eq() reports success even when
      // RLS matched zero rows).
      .select('id');
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data || data.length === 0) {
      // resolveDuplicateBySha256 only returns reimport_after_cancelled when a
      // LIVE, non-superseded prior exists — the exact rows this update targets.
      // Zero rows therefore means someone else superseded it between the two
      // statements, i.e. a genuine race, not the "no live import" case that
      // used to land here.
      throw new ServiceError(
        'conflict',
        'Someone else just re-imported this file. Refresh to see their import.',
      );
    }
  }

  /**
   * Maps the live-import uniqueness collision (23505 on
   * po_imports_org_sha_uniq) to a clean conflict. Two people reimporting the
   * same cancelled PO at once: one wins, the other gets this instead of a 500.
   */
  private static isLiveImportCollision(err: { code?: string; message?: string } | null): boolean {
    if (!err) return false;
    return (
      err.code === '23505' ||
      (err.message ?? '').includes('po_imports_org_sha_uniq')
    );
  }

  /**
   * Phone-scanned PO end-to-end. Accepts raw image/PDF buffers (one or
   * more — multi-page POs supported), uploads them to the po-imports
   * bucket, runs Gemini Flash extraction, persists the header + lines
   * with extraction_confidence per line, applies vendor-mapping
   * resolution, and returns the import id ready for review.
   *
   * Single transaction-ish flow that mirrors createFromUpload +
   * parseImport, except we never call the deterministic parsers.
   */
  async createFromScan(input: {
    files: Array<{ bytes: Uint8Array; mimeType: string; fileName: string }>;
    vendorId?: string | null;
    warehouseId?: string | null;
  }): Promise<{ id: string; duplicateOf: string | null; lowConfidenceLines: number }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');
    if (input.files.length === 0) {
      throw new ServiceError('validation_error', 'No files provided.');
    }
    if (input.files.length > 5) {
      throw new ServiceError(
        'validation_error',
        'Limit is 5 frames per scan — split larger POs into separate scans.',
      );
    }

    // Hash the concatenated bytes for dedup.
    const hash = createHash('sha256');
    let totalSize = 0;
    for (const f of input.files) {
      hash.update(f.bytes);
      totalSize += f.bytes.byteLength;
    }
    const sha256 = hash.digest('hex');

    // Duplicate check on the same scan (re-uploading the same bytes). Uses the
    // SAME authoritative decision as the CSV/PDF upload path, so a cancelled
    // PO's source document can be re-scanned to redo it while a live PO's
    // document still blocks. See resolveDuplicateBySha256.
    const scanDecision = await this.resolveDuplicateBySha256(sha256);
    if (scanDecision.kind === 'blocked') {
      return {
        id: scanDecision.importId,
        duplicateOf: scanDecision.importId,
        lowConfidenceLines: 0,
      };
    }
    const reimportedFromId =
      scanDecision.kind === 'reimport_after_cancelled'
        ? scanDecision.predecessorImportId
        : null;

    // Upload each file to storage. Use the admin client because the
    // standard po-imports bucket policy expects user-uploaded paths;
    // service-role bypasses RLS for the bulk-upload case.
    const admin = createAdminClient();
    const baseFileName = input.files[0]!.fileName;
    const baseFile = input.files[0]!;
    const ext = baseFile.mimeType === 'application/pdf' ? 'pdf' : 'jpg';
    const storagePath = `${this.ctx.organizationId}/po-imports/${sha256}.${ext}`;

    // Upload only the FIRST file as the canonical record (used for re-display
    // / re-extraction). Multi-frame uploads send all to Gemini but we keep
    // one file tracked. Gemini's extraction merges them.
    const { error: upErr } = await admin.storage
      .from('po-imports')
      .upload(storagePath, baseFile.bytes, {
        contentType: baseFile.mimeType,
        upsert: true,
      });
    if (upErr) {
      throw new ServiceError('internal_error', `Storage upload failed: ${upErr.message}`);
    }

    // Run extraction over every frame.
    const extracted = await extractPoFromMedia(
      input.files.map((f) => ({
        base64: Buffer.from(f.bytes).toString('base64'),
        mimeType: f.mimeType,
      })),
    );

    // Insert the po_imports row at status='needs_review' if any line is
    // low-confidence, else 'parsed'. The review UI surfaces both.
    const lowConfidenceCount = extracted.lines.filter((l) => l.confidence < 0.85).length;
    const status: PoImportStatus =
      lowConfidenceCount > 0 ? 'needs_review' : 'parsed';

    // Free the hash for exactly one new live import (mig 0287) — mirrors the
    // upload path; without it this insert hits po_imports_org_sha_uniq (23505),
    // which is what 500'd the scan route.
    if (scanDecision.kind === 'reimport_after_cancelled') {
      await this.supersedePriorImports(sha256);
    }

    const { data: imp, error: impErr } = await this.ctx.supabase
      .from('po_imports')
      .insert({
        organization_id: this.ctx.organizationId,
        uploaded_by: this.ctx.userId,
        source_type: 'scan',
        vendor_id: input.vendorId ?? null,
        warehouse_id: input.warehouseId ?? null,
        file_name: baseFileName,
        file_mime_type: baseFile.mimeType,
        file_size: totalSize,
        storage_path: storagePath,
        sha256,
        status,
        reimported_from_id: reimportedFromId,
        parsed_json: extracted,
        extraction_confidence: extracted.overallConfidence,
        extraction_model: SCAN_MODEL_NAME,
      })
      .select('id')
      .single();
    if (impErr || !imp) {
      // The DB row insert failed AFTER we already uploaded the scan
      // bytes to the po-imports bucket. Remove the orphaned file
      // best-effort so we don't accumulate storage cost over time.
      // EXCEPT on a reimport: storage_path is keyed by sha256, so the
      // cancelled predecessor's row points at this exact same object —
      // deleting it would break that import's document link.
      if (scanDecision.kind !== 'reimport_after_cancelled') {
        try {
          await admin.storage.from('po-imports').remove([storagePath]);
        } catch {
          // swallow — original DB error is the one the user needs to see.
        }
      }
      if (PoImportsService.isLiveImportCollision(impErr)) {
        throw new ServiceError(
          'conflict',
          'Someone just imported this same document. Refresh to see their import.',
        );
      }
      throw new ServiceError(
        'internal_error',
        `Could not record the scan: ${impErr?.message ?? 'unknown'}`,
      );
    }
    const importId = imp.id as string;

    // Apply vendor-mapping resolution if a vendor was specified.
    const mappings: MappingRow[] = input.vendorId
      ? await new VendorItemMappingsService(this.ctx).listForVendor(input.vendorId)
      : [];

    const linesPayload = extracted.lines.map((l) => {
      const isInventory = l.lineType === 'inventory';
      let suggested_item_id: string | null = null;
      let match_status: PoImportMatchStatus = isInventory ? 'needs_review' : 'non_inventory';
      let exception_reason: string | null = isInventory
        ? 'No mapping for vendor item number'
        : null;

      if (isInventory && l.vendorSku) {
        const m = matchByVendorNumber(mappings, {
          vendorItemNumber: l.vendorSku,
          vendorProductNumber: null,
          auxiliaryNumber: null,
        });
        if (m) {
          // Advisory only — a vendor-number match is a SUGGESTION, never an
          // auto-link. item_id stays null until the user explicitly accepts
          // it (decision use_existing) in the review UI.
          suggested_item_id = m.itemId;
          match_status = 'suggested';
          exception_reason = null;
        }
      }

      return {
        po_import_id: importId,
        line_number: l.lineNumber,
        line_type: l.lineType,
        qty_ordered_original: l.quantity,
        uom_original: l.uom,
        description: l.description,
        unit_cost: l.unitPrice,
        line_total: l.lineTotal,
        vendor_item_number: l.vendorSku || null,
        item_id: null,
        suggested_item_id,
        match_status,
        match_confidence: null,
        extraction_confidence: l.confidence,
        exception_reason,
        parsed_json: l,
      };
    });

    if (linesPayload.length > 0) {
      const { error: linesErr } = await this.ctx.supabase
        .from('po_import_lines')
        .insert(linesPayload);
      if (linesErr) throw new ServiceError('internal_error', linesErr.message);
    }

    await audit(
      {
        event: 'po_import.uploaded',
        entityType: 'po_import',
        entityId: importId,
        after: {
          sourceType: 'scan',
          fileName: baseFileName,
          sha256,
          overallConfidence: extracted.overallConfidence,
          lineCount: extracted.lines.length,
          lowConfidenceLines: lowConfidenceCount,
        },
      },
      this.ctx,
    );

    return { id: importId, duplicateOf: null, lowConfidenceLines: lowConfidenceCount };
  }

  /**
   * Parses an uploaded import: downloads the file from Storage, runs the
   * parser, persists header fields + lines + initial line classifications +
   * SKU match attempts, transitions status to 'parsed' or 'needs_review'
   * (or 'failed').
   */
  async parseImport(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { data: header, error: hErr } = await this.ctx.supabase
      .from('po_imports')
      .select('id, source_type, storage_path, vendor_id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'PO import not found');

    // Terminal-status guard: re-parsing wipes and rebuilds the line set. On an
    // already-approved import that would orphan its created PO (approved_po_id
    // still points at it) and re-open the import so it could be approved AGAIN,
    // minting a duplicate inbound PO. A canceled import must stay closed too.
    if (header.status === 'approved' || header.status === 'canceled') {
      throw new ServiceError(
        'conflict',
        `This import is ${header.status} and can no longer be re-parsed.`,
      );
    }

    await this.ctx.supabase
      .from('po_imports')
      .update({ status: 'parsing' })
      .eq('id', id);

    let canonical: CanonicalPo;
    let rawText: string | null = null;
    try {
      const { data: blob, error: dlErr } = await this.ctx.supabase.storage
        .from('po-imports')
        .download(header.storage_path as string);
      if (dlErr || !blob) {
        throw new Error(dlErr?.message ?? 'storage download failed');
      }
      const ab = await blob.arrayBuffer();
      const buffer = Buffer.from(ab);
      const sourceType: ParseSourceType =
        (header.source_type as string) === 'pdf' ? 'pdf' : 'csv';
      const parsed = await parsePoFile(buffer, sourceType);
      canonical = parsed;
      // Persist the raw extracted text so the UI can surface it for
      // debugging when the parser yields zero lines on a real-world PO.
      rawText = parsed.rawText ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'parse error';
      await this.ctx.supabase
        .from('po_imports')
        .update({ status: 'failed', parse_error: msg })
        .eq('id', id);
      await audit(
        {
          event: 'po_import.failed',
          entityType: 'po_import',
          entityId: id,
          after: { reason: msg },
        },
        this.ctx,
      );
      return;
    }

    // Pull mappings to attempt SKU resolution for each inventory line.
    const vendorId = (header.vendor_id as string | null) ?? null;
    const mappings: MappingRow[] = vendorId
      ? await new VendorItemMappingsService(this.ctx).listForVendor(vendorId)
      : [];

    const linesPayload = canonical.lines.map((l) => {
      const isInventory = l.lineType === 'inventory';
      let suggested_item_id: string | null = null;
      let match_status: PoImportMatchStatus = isInventory ? 'needs_review' : 'non_inventory';
      let exception_reason: string | null = isInventory
        ? 'No mapping for vendor item number'
        : null;

      if (isInventory) {
        const m = matchByVendorNumber(mappings, {
          vendorItemNumber: l.vendorItemNumber,
          vendorProductNumber: l.vendorProductNumber,
          auxiliaryNumber: l.auxiliaryNumber,
        });
        if (m) {
          // Advisory only — a vendor-number match is a SUGGESTION, never an
          // auto-link. item_id stays null until the user explicitly accepts
          // it (decision use_existing) in the review UI.
          suggested_item_id = m.itemId;
          match_status = 'suggested';
          exception_reason = null;
        }
      }

      return {
        po_import_id: id,
        line_number: l.lineNumber,
        line_type: l.lineType,
        qty_ordered_original: l.qtyOrderedOriginal,
        uom_original: l.uomOriginal,
        description: l.description,
        unit_cost: l.unitCost,
        line_total: l.lineTotal,
        vendor_item_number: l.vendorItemNumber,
        vendor_product_number: l.vendorProductNumber,
        auxiliary_number: l.auxiliaryNumber,
        coa_code: l.coaCode,
        item_id: null,
        suggested_item_id,
        match_status,
        exception_reason,
        parsed_json: l,
      };
    });

    // Re-parse: wipe any prior lines first so we don't accumulate dupes
    // when the user hits Re-parse after a parser fix.
    const { error: delErr } = await this.ctx.supabase
      .from('po_import_lines')
      .delete()
      .eq('po_import_id', id);
    if (delErr) throw new ServiceError('internal_error', delErr.message);

    if (linesPayload.length > 0) {
      const { error: insErr } = await this.ctx.supabase
        .from('po_import_lines')
        .insert(linesPayload);
      if (insErr) throw new ServiceError('internal_error', insErr.message);
    }

    const hasOpenException = linesPayload.some((l) => l.match_status === 'needs_review');
    const newStatus: PoImportStatus = hasOpenException ? 'needs_review' : 'parsed';

    await this.ctx.supabase
      .from('po_imports')
      .update({
        status: newStatus,
        raw_text: rawText,
        parsed_json: canonical,
      })
      .eq('id', id);

    await audit(
      {
        event: 'po_import.parsed',
        entityType: 'po_import',
        entityId: id,
        after: { lineCount: linesPayload.length, status: newStatus },
      },
      this.ctx,
    );
  }

  /**
   * Approves a parsed import: creates a real purchase_orders row in
   * status='expected_inbound' and copies inventory lines into
   * purchase_order_items. Tax / freight / service / fee / discount lines are
   * persisted as FINANCIAL-ONLY purchase_order_charges (they appear on the PO
   * PDF and roll into total, but never become items and never touch stock).
   * Inventory stock is NOT touched.
   */
  async approve(input: ApprovePoImportInput): Promise<{ poId: string }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { header, lines } = await this.get(input.poImportId);
    if (header.status !== 'parsed' && header.status !== 'needs_review') {
      throw new ServiceError(
        'conflict',
        `Cannot approve import in status '${header.status}'`,
      );
    }

    const overrideMap = new Map(input.lineOverrides.map((o) => [o.lineId, o]));
    const finalLines = lines
      .map((l) => {
        const o = overrideMap.get(l.id);
        return o
          ? {
              ...l,
              item_id: o.itemId !== undefined ? o.itemId : l.item_id,
              line_type: o.lineType ?? l.line_type,
              skip: o.skip === true,
            }
          : { ...l, skip: false };
      })
      .filter((l) => !l.skip);

    const inventoryLines = finalLines.filter(
      (l) => l.line_type === 'inventory' && l.item_id !== null,
    );
    const stillUnresolved = finalLines.find(
      (l) => l.line_type === 'inventory' && l.item_id === null,
    );
    if (stillUnresolved) {
      throw new ServiceError(
        'validation_error',
        `Line ${stillUnresolved.line_number} has no mapped item. Resolve in the exception queue or skip the line.`,
      );
    }

    // Verify the chosen charter belongs to this org FIRST — it drives both the
    // PO's bill-to tag and the item-instance re-resolution below.
    let selectedCharterId: string | null = null;
    if (input.charterId) {
      const { data: charter } = await this.ctx.supabase
        .from('charters')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', input.charterId)
        .maybeSingle();
      selectedCharterId = (charter?.id as string | undefined) ?? null;
    }

    // SELECTED CHARTER WINS (owner decision 2026-07-09): the charter picked at
    // approve governs which ITEM INSTANCE each line receives against. A line
    // can arrive pointing at an item under a DIFFERENT charter via the review
    // combobox override (its dropdown dedupes options by SKU — oldest wins) or
    // a stale prior resolution. resolveLines re-resolves its own use_existing
    // decisions, but approve() is the LAST gate every path funnels through, so
    // enforce it here too: swap in (or create, qty 0) the same-SKU sibling
    // under the selected charter. The mismatched item is left untouched.
    {
      const linkedIds = [...new Set(inventoryLines.map((l) => l.item_id as string))];
      if (linkedIds.length > 0) {
        const { data: linkedItems, error: liErr } = await this.ctx.supabase
          .from('inventory_items')
          .select(
            'id, sku, name, barcode, charter_id, unit_cost, retail_price, category_id, supplier_id, warehouse_id, unit_of_measure, item_type, tracking_type',
          )
          .eq('organization_id', this.ctx.organizationId)
          .in('id', linkedIds)
          .is('deleted_at', null);
        if (liErr) throw new ServiceError('internal_error', liErr.message);
        type LinkedItem = {
          id: string;
          sku: string;
          name: string;
          barcode: string | null;
          charter_id: string | null;
          unit_cost: number | null;
          retail_price: number | null;
          category_id: string | null;
          supplier_id: string | null;
          warehouse_id: string | null;
          unit_of_measure: string | null;
          item_type: string | null;
          tracking_type: string | null;
        };
        const byId = new Map(
          ((linkedItems ?? []) as LinkedItem[]).map((i) => [i.id, i]),
        );
        // Items THIS import just created (0 qty, no history). For these we
        // RE-CHARTER in place rather than spawn a sibling — otherwise the
        // create-items-then-approve flow leaves a Generic orphan next to the
        // charter instance (the duplicate the owner caught 2026-07-10). Only a
        // PRE-EXISTING item under a different charter gets a sibling (the KVA
        // "use existing" case — never re-charter stock we didn't just create).
        const importCreatedItemIds = new Set(
          inventoryLines
            .filter((l) => (l as { item_created?: boolean }).item_created === true)
            .map((l) => l.item_id as string),
        );
        const remap = new Map<string, string>();
        const orphanIds: string[] = [];
        const inventorySvc = new InventoryService(this.ctx);
        for (const [id, it] of byId) {
          const itemCharter = it.charter_id ?? null;
          if (itemCharter === selectedCharterId) continue;
          const createdHere = importCreatedItemIds.has(id);

          // Is there already a sibling under the selected charter?
          let sibQuery = this.ctx.supabase
            .from('inventory_items')
            .select('id')
            .eq('organization_id', this.ctx.organizationId)
            .eq('sku', it.sku)
            .is('bin_location', null)
            .is('deleted_at', null);
          sibQuery =
            selectedCharterId === null
              ? sibQuery.is('charter_id', null)
              : sibQuery.eq('charter_id', selectedCharterId);
          const { data: sibling, error: sibErr } = await sibQuery.maybeSingle();
          if (sibErr) throw new ServiceError('internal_error', sibErr.message);

          if (sibling) {
            // Link to the existing sibling. If the mismatched item was a fresh
            // import creation, it's now a superseded orphan → archive it.
            remap.set(id, sibling.id as string);
            if (createdHere) orphanIds.push(id);
          } else if (createdHere) {
            // Re-charter the just-created item in place — no duplicate, no
            // remap (the line keeps pointing at it). Safe: 0 qty, no movements,
            // and no sibling exists to collide with the (org,sku,charter,bin)
            // uniqueness (0234).
            const { error: rcErr } = await this.ctx.supabase
              .from('inventory_items')
              .update({ charter_id: selectedCharterId })
              .eq('organization_id', this.ctx.organizationId)
              .eq('id', id)
              .select('id')
              .maybeSingle();
            if (rcErr) throw new ServiceError('internal_error', rcErr.message);
          } else {
            // Pre-existing item under a different charter → create a qty-0
            // sibling under the selected charter (receiving posts the stock).
            const created = await inventorySvc.create({
              name: it.name,
              sku: it.sku,
              barcode: it.barcode ?? undefined,
              unitCost: Number(it.unit_cost ?? 0) || 0,
              retailPrice: Number(it.retail_price ?? 0) || 0,
              quantityOnHand: 0,
              reorderPoint: 0,
              reorderQuantity: 0,
              unitOfMeasure: it.unit_of_measure ?? 'unit',
              supplierId: it.supplier_id ?? input.vendorId,
              warehouseId: it.warehouse_id ?? input.warehouseId,
              charterId: selectedCharterId,
              categoryId: it.category_id ?? null,
              primaryLocationId: null,
              trackingType: (it.tracking_type as 'none' | 'lot' | 'serial' | null) ?? 'none',
              itemType:
                (it.item_type as 'product' | 'book' | 'asset' | 'consumable' | null) ?? 'product',
              customFields: {},
              status: 'active',
              // Born FROM this PO at qty 0 — mark it Expected (awaiting first
              // receipt) like every other PO-driven creation path
              // (createItemsFromPoLines, purchase-orders.create). Without this
              // the charter sibling — the common case for a book that already
              // exists under a different charter — showed up as a real
              // "Out of stock" row instead of hiding under the Expected chip.
            }, { awaitingFirstReceipt: true });
            remap.set(id, created.id as string);
          }
        }
        // Archive fresh orphans superseded by a sibling link (0 qty, unused).
        for (const oid of orphanIds) {
          await this.ctx.supabase
            .from('inventory_items')
            .update({ status: 'archived', deleted_at: new Date().toISOString() })
            .eq('organization_id', this.ctx.organizationId)
            .eq('id', oid);
        }
        if (remap.size > 0) {
          for (const l of inventoryLines) {
            const target = remap.get(l.item_id as string);
            if (!target) continue;
            l.item_id = target;
            // Keep the import line's record pointing at what was ACTUALLY
            // received against, and mark created siblings for cancel-cleanup.
            const { error: updErr } = await this.ctx.supabase
              .from('po_import_lines')
              .update({ item_id: target })
              .eq('id', l.id)
              .select('id')
              .maybeSingle();
            if (updErr) throw new ServiceError('internal_error', updErr.message);
          }
        }
      }
    }

    const { data: nextNum } = await this.ctx.supabase.rpc('next_po_number', {
      p_org_id: this.ctx.organizationId,
    });
    const poNumber = (nextNum as string | null) ?? `PO-${Date.now()}`;

    const subtotal = inventoryLines.reduce(
      (sum, l) => sum + (l.line_total ?? 0),
      0,
    );

    // Non-inventory lines (tax / freight / White Glove service / e-waste fee /
    // discount / unmatched-but-priced) are FINANCIAL-ONLY: they belong on the PO
    // document and roll into its total, but they NEVER become items and NEVER
    // touch stock (owner requirement). Persisted as purchase_order_charges (a
    // table with no item_id and no FK to inventory_items → no path to a stock
    // movement). Everything in finalLines that is not inventory is a charge, so
    // nothing priced is dropped.
    const { chargeRows, chargeTotal } = buildPoCharges(finalLines, this.ctx.organizationId);

    // Receiving posts against a destination location. The user MUST have
    // chosen one at import review — there is deliberately no fallback (the
    // old auto-pick/auto-create path silently spawned junk locations).
    const destinationLocationId = await this.resolveDestinationLocation(
      input.warehouseId,
      input.locationId ?? null,
    );

    // Bill-to = the same org-verified charter computed above (spoofed /
    // cross-tenant ids were already silently dropped there).
    const billToCharterId: string | null = selectedCharterId;

    const { data: po, error: poErr } = await this.ctx.supabase
      .from('purchase_orders')
      .insert({
        organization_id: this.ctx.organizationId,
        po_number: poNumber,
        supplier_id: input.vendorId,
        destination_location_id: destinationLocationId,
        charter_id: billToCharterId,
        expected_at: input.expectedAt ?? null,
        notes: `Imported from PO file (po_import ${input.poImportId})`,
        subtotal,
        // Total is the TRUE invoice value: goods + every charge. subtotal stays
        // goods-only so the PDF can print Subtotal → charges → Total.
        total: subtotal + chargeTotal,
        status: 'expected_inbound',
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (poErr) throw new ServiceError('internal_error', poErr.message);

    if (inventoryLines.length > 0) {
      const { error: lineErr } = await this.ctx.supabase
        .from('purchase_order_items')
        .insert(
          inventoryLines.map((l) => ({
            organization_id: this.ctx.organizationId,
            purchase_order_id: po.id as string,
            item_id: l.item_id!,
            quantity_ordered: l.qty_ordered_original ?? 1,
            quantity_received: 0,
            unit_cost: l.unit_cost ?? 0,
          })),
        );
      if (lineErr) throw new ServiceError('internal_error', lineErr.message);
    }

    // Persist the financial-only charges (tax/freight/service/fee/discount/other)
    // so they render on the PO PDF and reconcile with total. No stock, no items.
    if (chargeRows.length > 0) {
      const { error: chargeErr } = await this.ctx.supabase
        .from('purchase_order_charges')
        .insert(
          chargeRows.map((c) => ({ ...c, purchase_order_id: po.id as string })),
        );
      if (chargeErr) throw new ServiceError('internal_error', chargeErr.message);
    }

    // Stamp the items THIS import created (not pre-existing items the user
    // linked) with their origin PO, so cancelling the PO archives the unused
    // ones via the normal cleanup (archiveOrphanedCustomItems) — otherwise an
    // imported-then-cancelled PO would strand its auto-created items in stock.
    const { data: createdLines } = await this.ctx.supabase
      .from('po_import_lines')
      .select('item_id')
      .eq('po_import_id', input.poImportId)
      .eq('item_created', true)
      .not('item_id', 'is', null);
    const createdItemIds = ((createdLines ?? []) as Array<{ item_id: string | null }>)
      .map((r) => r.item_id)
      .filter((v): v is string => Boolean(v));
    if (createdItemIds.length > 0) {
      await this.ctx.supabase
        .from('inventory_items')
        .update({ created_from_purchase_order_id: po.id as string })
        .eq('organization_id', this.ctx.organizationId)
        .in('id', createdItemIds);
    }

    await this.ctx.supabase
      .from('po_imports')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: this.ctx.userId,
        approved_po_id: po.id as string,
      })
      .eq('id', input.poImportId);

    await audit(
      {
        event: 'po_import.approved',
        entityType: 'po_import',
        entityId: input.poImportId,
        after: {
          poId: po.id,
          lineCount: inventoryLines.length,
          chargeCount: chargeRows.length,
          chargeTotal,
          total: subtotal + chargeTotal,
          warehouseId: input.warehouseId,
        },
      },
      this.ctx,
    );

    return { poId: po.id as string };
  }

  /**
   * Validates the caller's chosen destination location and returns its id.
   * The location must exist, belong to this org AND the given warehouse, and
   * not be deleted. There is deliberately NO fallback: a missing or foreign
   * id throws instead of silently receiving into an auto-picked — or, worse,
   * auto-created — location. Approval requires an explicit location choice.
   */
  private async resolveDestinationLocation(
    warehouseId: string,
    preferredLocationId: string | null = null,
  ): Promise<string> {
    if (preferredLocationId) {
      const { data: chosen, error } = await this.ctx.supabase
        .from('locations')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', preferredLocationId)
        .eq('warehouse_id', warehouseId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw new ServiceError('internal_error', error.message);
      if (chosen?.id) return chosen.id as string;
    }
    throw new ServiceError(
      'validation_error',
      'Pick a destination location for this warehouse.',
    );
  }

  /**
   * Duplicate-candidate lookup for the given import's lines (all lines when
   * `lineIds` is omitted). Bearer-route entry point for the SAME
   * implementation `findDuplicatesForPoLinesAction` uses on web — the shared
   * function org-scopes the import id (foreign/unknown → not_found). The web
   * action reaches the shared implementation directly (cookie context); this
   * wrapper adds the service's module + permission asserts for the /api/v1
   * surface, matching every other import mutation gate.
   */
  async findDuplicatesForLines(input: {
    poImportId: string;
    lineIds?: string[];
  }): Promise<{ matches: Record<string, DuplicateCandidate[]> }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');
    return findDuplicatesForPoLines(
      { supabase: this.ctx.supabase, organizationId: this.ctx.organizationId },
      input,
    );
  }

  /**
   * Create-or-link items for the given import lines. Bearer-route entry
   * point for the SAME implementation `createItemsFromPoLinesAction` uses on
   * web (selected-charter-wins, advisory-only barcode/ISBN matching,
   * item_created bookkeeping, vendor-mapping upserts). The shared function
   * org-scopes the import id (foreign/unknown → not_found); this wrapper adds
   * the service's module + permission asserts for the /api/v1 surface.
   * InventoryService.create re-asserts its own item-create gate internally —
   * same defense-in-depth the web action relies on.
   */
  async createItemsFromLines(
    input: CreateItemsFromPoLinesInput,
  ): Promise<{ created: number; mapped: number; linked: number; skipped: number }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');
    return createItemsFromPoLines(
      {
        supabase: this.ctx.supabase,
        organizationId: this.ctx.organizationId,
        inventorySvc: new InventoryService(this.ctx),
        mappingsSvc: new VendorItemMappingsService(this.ctx),
      },
      input,
    );
  }

  async cancel(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { data: row, error } = await this.ctx.supabase
      .from('po_imports')
      .update({ status: 'canceled' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .not('status', 'in', '(approved,canceled)')
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the import is gone or already
    // approved/canceled — don't audit a cancellation that didn't happen.
    if (!row) throw new ServiceError('conflict', 'Import not found or already finalized.');

    // Cancelling a not-yet-approved import: archive the items it auto-created
    // (during review) that were never used, so they don't linger in inventory.
    await this.archiveImportCreatedItems(id);

    await audit(
      {
        event: 'po_import.canceled',
        entityType: 'po_import',
        entityId: id,
      },
      this.ctx,
    );
  }

  /**
   * Archive catalog items THIS import auto-created (item_created lines) that are
   * still unused — active, zero on-hand, not referenced by any non-cancelled PO.
   * Used when an import is cancelled before approval (no PO exists to hang the
   * created_from marker on). Only touches items the import created, never
   * pre-existing items the user linked. Reversible (archive, not delete) and
   * best-effort — never fails the cancel.
   */
  private async archiveImportCreatedItems(importId: string): Promise<void> {
    try {
      const { data: lines } = await this.ctx.supabase
        .from('po_import_lines')
        .select('item_id')
        .eq('po_import_id', importId)
        .eq('item_created', true)
        .not('item_id', 'is', null);
      const ids = Array.from(
        new Set(
          ((lines ?? []) as Array<{ item_id: string | null }>)
            .map((l) => l.item_id)
            .filter((v): v is string => Boolean(v)),
        ),
      );
      if (ids.length === 0) return;

      const { data: candidates } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, name')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', ids)
        .eq('status', 'active')
        .eq('quantity_on_hand', 0)
        .is('deleted_at', null);
      const cand = (candidates ?? []) as Array<{ id: string; name: string }>;
      if (cand.length === 0) return;

      // Keep any item still referenced by a non-cancelled PO (it may yet receive
      // stock there). The just-cancelled import has no PO, so nothing to exclude
      // on that account.
      const { data: poLines } = await this.ctx.supabase
        .from('purchase_order_items')
        .select('item_id, po:purchase_orders!inner(status)')
        .eq('organization_id', this.ctx.organizationId) // defense-in-depth: keep the keep-check single-org
        .in('item_id', cand.map((c) => c.id));
      const keep = new Set<string>();
      for (const row of (poLines ?? []) as Array<Record<string, unknown>>) {
        const poField = row.po as { status?: string } | { status?: string }[] | null;
        const poStatus = Array.isArray(poField) ? poField[0]?.status : poField?.status;
        if (poStatus && poStatus !== 'cancelled') keep.add(row.item_id as string);
      }
      const toArchive = cand.filter((c) => !keep.has(c.id));
      if (toArchive.length === 0) return;

      const { data: flipped } = await this.ctx.supabase
        .from('inventory_items')
        .update({ status: 'archived' })
        .eq('organization_id', this.ctx.organizationId)
        .in('id', toArchive.map((c) => c.id))
        .eq('status', 'active') // race guard
        .select('id, name');
      for (const item of (flipped ?? []) as Array<{ id: string; name: string }>) {
        await audit(
          {
            event: 'inventory.item.archived',
            entityType: 'inventory_item',
            entityId: item.id,
            before: { status: 'active' },
            after: { status: 'archived' },
            extra: { reason: 'po_import_canceled', poImportId: importId, itemName: item.name },
          },
          this.ctx,
        );
      }
    } catch (e) {
      console.warn(
        '[po-import cancel] archive created items failed',
        e instanceof Error ? e.message : e,
      );
    }
  }
}

/** Escape ILIKE wildcards so a user's %/_/\ in search is literal (pattern #16). */
function escapeIlike(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}
