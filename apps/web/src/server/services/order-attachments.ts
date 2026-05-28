import 'server-only';

import { isManagerOrAbove } from '@stockpilot/core';

import { ServiceError, withContext, type ServiceContext } from './context';

const BUCKET = 'order-attachments';

/** Statuses where proof-of-delivery attachments are allowed: from the
 *  moment an order is staged / out for delivery through completed. */
export const ATTACHABLE_ORDER_STATUSES = [
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'signature_requested',
  'completed',
] as const;

export type OrderAttachmentKind = 'signature' | 'dropoff_photo' | 'location' | 'other';

export interface OrderAttachment {
  id: string;
  orderRequestId: string;
  storagePath: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  kind: OrderAttachmentKind;
  uploadedBy: string | null;
  createdAt: string;
  /** Short-lived signed URL for viewing/downloading. Null if signing failed. */
  url: string | null;
}

export class OrderAttachmentsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<OrderAttachmentsService> {
    return new OrderAttachmentsService(await withContext());
  }

  async list(orderRequestId: string): Promise<OrderAttachment[]> {
    const { data, error } = await this.ctx.supabase
      .from('order_request_attachments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderRequestId)
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
      orderRequestId: r.order_request_id as string,
      storagePath: r.storage_path as string,
      fileName: (r.file_name as string | null) ?? null,
      contentType: (r.content_type as string | null) ?? null,
      sizeBytes: (r.size_bytes as number | null) ?? null,
      kind: ((r.kind as string | null) ?? 'other') as OrderAttachmentKind,
      uploadedBy: (r.uploaded_by as string | null) ?? null,
      createdAt: r.created_at as string,
      url: signed.get(r.storage_path as string) ?? null,
    }));
  }

  async add(input: {
    orderRequestId: string;
    storagePath: string;
    fileName: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    kind: OrderAttachmentKind;
  }): Promise<{ id: string }> {
    if (!isManagerOrAbove(this.ctx.role)) {
      throw new ServiceError('forbidden', 'Only managers and up can add order attachments.');
    }
    // The order must belong to this org and be in an attachable status.
    const { data: order, error: oErr } = await this.ctx.supabase
      .from('order_requests')
      .select('id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', input.orderRequestId)
      .maybeSingle();
    if (oErr) throw new ServiceError('internal_error', oErr.message);
    if (!order) throw new ServiceError('not_found', 'Order not found.');
    const status = (order as { status: string }).status;
    if (!ATTACHABLE_ORDER_STATUSES.includes(status as (typeof ATTACHABLE_ORDER_STATUSES)[number])) {
      throw new ServiceError(
        'validation_error',
        'Attachments can only be added once the order is out for delivery or completed.',
      );
    }
    // Defense-in-depth: the uploaded object must live under this org's prefix
    // (the bucket RLS enforces the same, but fail fast with a clean error).
    if (!input.storagePath.startsWith(`${this.ctx.organizationId}/`)) {
      throw new ServiceError('validation_error', 'Invalid storage path.');
    }

    const { data, error } = await this.ctx.supabase
      .from('order_request_attachments')
      .insert({
        organization_id: this.ctx.organizationId,
        order_request_id: input.orderRequestId,
        storage_path: input.storagePath,
        file_name: input.fileName,
        content_type: input.contentType,
        size_bytes: input.sizeBytes,
        kind: input.kind,
        uploaded_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return { id: (data as { id: string }).id };
  }

  async remove(attachmentId: string): Promise<void> {
    if (!isManagerOrAbove(this.ctx.role)) {
      throw new ServiceError('forbidden', 'Only managers and up can delete order attachments.');
    }
    const { data: row, error } = await this.ctx.supabase
      .from('order_request_attachments')
      .select('id, storage_path')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', attachmentId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Attachment not found.');

    // Remove the stored object (best-effort) then the metadata row.
    const storagePath = (row as { storage_path: string }).storage_path;
    await this.ctx.supabase.storage.from(BUCKET).remove([storagePath]);
    const { error: dErr } = await this.ctx.supabase
      .from('order_request_attachments')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', attachmentId);
    if (dErr) throw new ServiceError('internal_error', dErr.message);
  }
}
