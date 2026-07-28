import 'server-only';

import { createHash } from 'node:crypto';

import { ServiceError, type ServiceContext } from './context';

/**
 * Same-file dedupe for the GENERIC items-CSV import (migration 0304).
 *
 * LIVE-VERIFIED FAIL (Demo Co, 2026-07-28, report line 11): a byte-identical
 * re-upload showed "no indication whatsoever that the file had been seen
 * before" and offered Import again. PO imports have fingerprinted uploads by
 * SHA-256 since long before the sports program; this screen never has, so a
 * mis-click on a second upload silently doubles an org's stock.
 *
 * Mirrors the po_imports chassis (0286 lineage + 0287 supersede) at the
 * granularity this much simpler screen needs — no document, no approval state
 * machine, no purchase order. The one rule carried over intact is the important
 * one: a hash is NEVER permanently blocked. The requirements are explicit that
 * the importer must "distinguish same-request retry from an intentional second
 * shipment", so an acknowledged re-upload supersedes its predecessor (which
 * frees the hash for exactly one new live batch) rather than being refused.
 */

export interface ItemImportDuplicate {
  batchId: string;
  fileName: string | null;
  rowCount: number;
  createdCount: number;
  importedAt: string;
}

interface BatchRow {
  id: string;
  file_name: string | null;
  row_count: number;
  created_count: number;
  created_at: string;
}

export class ItemImportBatchesService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * The file's fingerprint — SERVER-COMPUTED, always.
   *
   * Derived from the parsed rows rather than the raw bytes for two reasons.
   * First, a Next server action has a body-size budget and the screen already
   * sends the rows; hashing them costs nothing extra where shipping the file
   * text a second time could push a 5,000-row import over the limit. Second, it
   * is the STRONGER dedupe: re-saving the same spreadsheet changes its bytes
   * (line endings, quoting, a trailing newline) while the data is identical,
   * and it is the data that would be double-imported.
   *
   * Never accepted from the client. A browser-supplied hash could simply be
   * randomised to walk past the warning, which would make the whole guard
   * decorative.
   *
   * Canonicalization: per-row keys sorted, so column ORDER in the file does not
   * change the identity of the data it carries.
   */
  static fingerprint(rows: ReadonlyArray<Readonly<Record<string, string>>>): string {
    const canonical = JSON.stringify(
      rows.map((r) =>
        Object.keys(r)
          .sort()
          .map((k) => [k, r[k] ?? '']),
      ),
    );
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  /**
   * The live batch for this file in this org, if any. Org-scoped by construction
   * — another tenant's identical spreadsheet is irrelevant.
   *
   * `superseded_at is null` is NOT optional: a superseded batch is history. It
   * neither warns nor blocks, exactly as a superseded po_import does not.
   */
  async findLiveBatch(sha256: string): Promise<ItemImportDuplicate | null> {
    const { data, error } = await this.ctx.supabase
      .from('item_import_batches')
      .select('id, file_name, row_count, created_count, created_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('sha256', sha256)
      .is('superseded_at', null)
      .order('created_at', { ascending: false })
      .limit(1);
    // Fail CLOSED on a read error. Returning null here would mean "no duplicate"
    // and let the double-import this class exists to prevent go straight
    // through — the same fail-open shape that made the portal catalog bug.
    if (error) throw new ServiceError('internal_error', error.message);
    const row = (data ?? [])[0] as BatchRow | undefined;
    if (!row) return null;
    return {
      batchId: row.id,
      fileName: row.file_name,
      rowCount: row.row_count,
      createdCount: row.created_count,
      importedAt: row.created_at,
    };
  }

  /**
   * Claim this file's hash for a new batch, and return the batch id.
   *
   * Claimed BEFORE the rows are written, not after: a crash halfway through an
   * import must not leave the file unfingerprinted, because the retry would
   * then double every row that did land. `recordOutcome` fills in the counts
   * once the loop finishes.
   *
   * When `supersedePredecessors` is set (the human acknowledged the warning),
   * every live batch of this file is stamped first — the partial unique index
   * covers live rows, so without that the insert dies with 23505. Lineage is
   * patched afterwards because the self-FK cannot point at a row that does not
   * exist yet.
   */
  async claim(input: {
    sha256: string;
    fileName: string | null;
    rowCount: number;
    supersedePredecessors: boolean;
  }): Promise<string> {
    let predecessors: string[] = [];
    if (input.supersedePredecessors) {
      const { data, error } = await this.ctx.supabase
        .from('item_import_batches')
        .update({ superseded_at: new Date().toISOString() })
        .eq('organization_id', this.ctx.organizationId)
        .eq('sha256', input.sha256)
        .is('superseded_at', null)
        // .select() so a zero-row update cannot fail OPEN into a 23505 on the
        // insert below (recurring pattern #22/.update().eq(): PostgREST reports
        // success even when RLS matched nothing).
        .select('id');
      if (error) throw new ServiceError('internal_error', error.message);
      predecessors = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    }

    const { data: inserted, error: insertError } = await this.ctx.supabase
      .from('item_import_batches')
      .insert({
        organization_id: this.ctx.organizationId,
        sha256: input.sha256,
        file_name: input.fileName,
        row_count: input.rowCount,
        imported_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (insertError) {
      // Two imports of one file raced; the database picked a winner. Surface a
      // clean conflict rather than a 500 — this is exactly the shape that
      // 500'd /api/po-imports/scan before 0287.
      if (insertError.code === '23505') {
        throw new ServiceError(
          'conflict',
          'Someone else just imported this file. Refresh to see their import.',
        );
      }
      throw new ServiceError('internal_error', insertError.message);
    }
    const batchId = (inserted as { id: string }).id;

    if (predecessors.length > 0) {
      // Lineage only — best effort by design: the supersede above is what makes
      // the import legal, and losing the back-pointer must not fail an import
      // whose rows are already claimed.
      await this.ctx.supabase
        .from('item_import_batches')
        .update({ superseded_by_id: batchId })
        .eq('organization_id', this.ctx.organizationId)
        .in('id', predecessors);
    }
    return batchId;
  }

  /** Fill in what the batch actually did, once the row loop has finished. */
  async recordOutcome(
    batchId: string,
    counts: { createdCount: number; failedCount: number },
  ): Promise<void> {
    const { error } = await this.ctx.supabase
      .from('item_import_batches')
      .update({ created_count: counts.createdCount, failed_count: counts.failedCount })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', batchId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  /**
   * Supersede a batch that created NOTHING.
   *
   * A wholly failed import has nothing to double, so it must not stand between
   * the user and the corrected re-upload. This is the difference between "we
   * remember this file" and "we are in your way" — and without it the very
   * failure the live verification hit (0 created / 4 failed) would have left a
   * warning on the fixed file's next attempt.
   */
  async release(batchId: string): Promise<void> {
    const { error } = await this.ctx.supabase
      .from('item_import_batches')
      .update({ superseded_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', batchId);
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
