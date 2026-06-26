import 'server-only';

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

    const { data, error } = await this.ctx.supabase
      .from('po_attachments')
      .insert({
        organization_id: this.ctx.organizationId,
        purchase_order_id: input.purchaseOrderId,
        storage_path: input.storagePath,
        file_name: input.fileName,
        content_type: input.contentType,
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
