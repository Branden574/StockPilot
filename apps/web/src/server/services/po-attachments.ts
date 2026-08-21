import 'server-only';

import { isValidStoragePath, poAttachmentPathShape } from '@/lib/storage-path';

import { isSniffedFileAllowedInBucket, sniffFile } from '@/lib/file-signature';
import { fetchObjectPrefix } from '@/lib/storage-object-prefix';
import { createAdminClient } from '@/lib/supabase/admin';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

const BUCKET = 'po-attachments';

export interface PoAttachment {
  id: string;
  purchaseOrderId: string;
  storagePath: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedBy: string | null;
  createdAt: string;
  /** Short-lived signed URL for viewing/downloading. Null if signing failed. */
  url: string | null;
}

/**
 * File attachments on purchase orders (supplier packing slips, etc.). Mirrors
 * OrderAttachmentsService. Upload/delete gate on purchase_orders:manage (so a
 * member granted that permission can attach); view rides RLS (any org member —
 * the PO section already gates purchase_orders:read).
 */
export class PoAttachmentsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<PoAttachmentsService> {
    return new PoAttachmentsService(await withContext());
  }

  /** Raw metadata rows for a PO (no signed URLs) — used by the zip route. */
  async listRaw(purchaseOrderId: string): Promise<
    Array<{ storage_path: string; file_name: string | null; content_type: string | null }>
  > {
    const { data, error } = await this.ctx.supabase
      .from('po_attachments')
      .select('storage_path, file_name, content_type')
      .eq('organization_id', this.ctx.organizationId)
      .eq('purchase_order_id', purchaseOrderId)
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as Array<{
      storage_path: string;
      file_name: string | null;
      content_type: string | null;
    }>;
  }

  async list(purchaseOrderId: string): Promise<PoAttachment[]> {
    const { data, error } = await this.ctx.supabase
      .from('po_attachments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('purchase_order_id', purchaseOrderId)
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const paths = rows.map((r) => r.storage_path as string);
    const signed = new Map<string, string>();
    if (paths.length > 0) {
      const { data: urls } = await this.ctx.supabase.storage
        .from(BUCKET)
        .createSignedUrls(paths, 60 * 60);
      for (const u of (urls ?? []) as Array<{ path?: string | null; signedUrl: string }>) {
        if (u.path) signed.set(u.path, u.signedUrl);
      }
    }

    return rows.map((r) => ({
      id: r.id as string,
      purchaseOrderId: r.purchase_order_id as string,
      storagePath: r.storage_path as string,
      fileName: (r.file_name as string | null) ?? null,
      contentType: (r.content_type as string | null) ?? null,
      sizeBytes: (r.size_bytes as number | null) ?? null,
      uploadedBy: (r.uploaded_by as string | null) ?? null,
      createdAt: r.created_at as string,
      url: signed.get(r.storage_path as string) ?? null,
    }));
  }

  /** Download one attachment's bytes (for the zip bundle). */
  async download(storagePath: string): Promise<Uint8Array | null> {
    const { data, error } = await this.ctx.supabase.storage.from(BUCKET).download(storagePath);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }

  async add(input: {
    purchaseOrderId: string;
    storagePath: string;
    fileName: string | null;
    contentType: string | null;
    sizeBytes: number | null;
  }): Promise<{ id: string }> {
    assertPermission(this.ctx, 'purchase_orders:manage');

    // Org-verify the PO before attaching — the attachment row's org must own the
    // PO (defense-in-depth alongside the RLS purchase_order_in_org guard).
    const { data: po, error: poErr } = await this.ctx.supabase
      .from('purchase_orders')
      .select('id')
      .eq('id', input.purchaseOrderId)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (poErr) throw new ServiceError('internal_error', poErr.message);
    if (!po) throw new ServiceError('not_found', 'Purchase order not found.');

    // HI-8: the storage path must match EXACTLY what the uploaders mint —
    // `{org}/{purchaseOrderId}/{file}` (mirrors OrderAttachmentsService.add).
    // The old `startsWith(`${orgId}/`)` prefix check was satisfiable by
    // `${orgId}/../../item-images/<victim-org>/<victim-item>/cover.jpg`: the
    // storage client interpolates the path into a fetch() URL whose `..`
    // segments the WHATWG parser resolves before the request leaves Node, so
    // the prefix held while the path escaped both the org folder and the
    // bucket — and `download()` below hands whatever it names to the zip
    // bundle. Pinning the PO id as well as the org id also stops PO A's
    // attachment row from being filed against PO B's uploaded invoice.
    if (
      !isValidStoragePath(
        input.storagePath,
        poAttachmentPathShape(this.ctx.organizationId, input.purchaseOrderId),
      )
    ) {
      throw new ServiceError('validation_error', 'Invalid storage path — wrong org prefix.');
    }

    // ═══ VERIFY THE BYTES, NOT THE CLIENT'S WORD FOR THEM ═══
    //
    // The bucket's allowed_mime_types only checks the Content-Type header the
    // client sent with its PUT, and po-attachments-panel.tsx passes
    // `contentType: file.type` — the browser's word. A renamed binary, an HTML
    // document or an SVG carrying script all reach this bucket by declaring
    // `application/pdf`. These objects are later signed, opened, and bundled
    // into the attachments zip, so an unverified one is a payload host on our
    // own storage origin.
    //
    // Same verify-or-delete shape as the maintenance-attachments reference:
    // range-read the leading bytes, sniff, and on any disagreement REMOVE the
    // object and write no row — never leave an unverified object with a row
    // pointing at it. The prefix read doubles as the existence check, so a
    // finalize never preceded by a real PUT writes no phantom row.
    const admin = createAdminClient();
    const head = await fetchObjectPrefix(admin.storage.from(BUCKET), input.storagePath);
    if (!head) {
      throw new ServiceError('validation_error', 'This file could not be verified.');
    }
    const sniffed = sniffFile(head.prefix);
    if (!sniffed || !isSniffedFileAllowedInBucket(sniffed, BUCKET)) {
      await admin.storage.from(BUCKET).remove([input.storagePath]);
      throw new ServiceError(
        'validation_error',
        'This file could not be uploaded because it failed our security checks.',
      );
    }

    const { data, error } = await this.ctx.supabase
      .from('po_attachments')
      .insert({
        organization_id: this.ctx.organizationId,
        purchase_order_id: input.purchaseOrderId,
        storage_path: input.storagePath,
        file_name: input.fileName,
        // The SNIFFED mime, not the declared one. Recording the client's claim
        // would let a spoofed header survive verification in the row that every
        // downstream reader trusts.
        content_type: sniffed.mime,
        size_bytes: input.sizeBytes,
        uploaded_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return { id: (data as { id: string }).id };
  }

  async delete(attachmentId: string, purchaseOrderId: string): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { data: row, error: selErr } = await this.ctx.supabase
      .from('po_attachments')
      .select('storage_path')
      .eq('id', attachmentId)
      .eq('organization_id', this.ctx.organizationId)
      .eq('purchase_order_id', purchaseOrderId)
      .maybeSingle();
    if (selErr) throw new ServiceError('internal_error', selErr.message);
    if (!row) throw new ServiceError('not_found', 'Attachment not found.');

    // Remove the storage object first; then the row. A leftover object on a
    // failed row-delete is harmless (orphan), but a leftover row pointing at a
    // deleted object would 404 on signing — so delete the row last.
    await this.ctx.supabase.storage
      .from(BUCKET)
      .remove([(row as { storage_path: string }).storage_path]);

    const { error: delErr } = await this.ctx.supabase
      .from('po_attachments')
      .delete()
      .eq('id', attachmentId)
      .eq('organization_id', this.ctx.organizationId);
    if (delErr) throw new ServiceError('internal_error', delErr.message);
  }
}
