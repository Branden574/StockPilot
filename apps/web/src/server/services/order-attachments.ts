import 'server-only';

import { unstable_cache } from 'next/cache';

import { isManagerOrAbove } from '@stockpilot/core';

import { isSniffedFileAllowedInBucket, sniffFile } from '@/lib/file-signature';
import { fetchObjectPrefix } from '@/lib/storage-object-prefix';
import { isValidStoragePath, orderAttachmentPathShape } from '@/lib/storage-path';
import { createAdminClient } from '@/lib/supabase/admin';

import { ServiceError, withContext, type ServiceContext } from './context';

const BUCKET = 'order-attachments';

/**
 * Long-lived, CACHED signed URLs — same design as item-images.ts (sign 30d,
 * cache 25d). The old code minted fresh 1-hour URLs on every RSC render, so
 * the browser cache never hit: every order visit re-downloaded every proof
 * photo at full size (up to 15MB each). A stable URL per storage path makes
 * revisits free.
 *
 * Why service-role: signing a path is org-agnostic — authorization already
 * happened in list()'s RLS-scoped row select. THROWS on failure so
 * unstable_cache never persists a null for 25 days (recurring-bug pattern
 * #6); the wrappers below catch → null.
 */
const SIGNED_URL_TTL_SEC = 30 * 24 * 60 * 60;
const SIGNED_URL_CACHE_SEC = 25 * 24 * 60 * 60;

const signAttachmentFull = unstable_cache(
  async (storagePath: string): Promise<string> => {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
    if (error || !data?.signedUrl) {
      throw new Error(`sign attachment failed: ${error?.message ?? 'no signedUrl'}`);
    }
    return data.signedUrl;
  },
  ['order-attachment-signed-url-v1'],
  { revalidate: SIGNED_URL_CACHE_SEC, tags: ['order-attachment-signed-url'] },
);

/** ~400px grid variant via Supabase's server-side transform. resize:'contain'
 *  is EXPLICIT — the image fits within 400x400 with its aspect ratio intact.
 *  (A width-only transform was found to crop, which blew tiles up into
 *  unrecognizable close-ups on the order picker — never rely on the
 *  default.) Cached separately — transform params are part of the URL
 *  signature. */
const signAttachmentThumb = unstable_cache(
  async (storagePath: string, width: number): Promise<string> => {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC, {
        transform: { width, height: width, resize: 'contain' },
      });
    if (error || !data?.signedUrl) {
      throw new Error(`sign attachment thumb failed: ${error?.message ?? 'no signedUrl'}`);
    }
    return data.signedUrl;
  },
  // v2: v1 briefly cached width-only (implicit-crop) variants.
  ['order-attachment-signed-url-thumb-v2'],
  { revalidate: SIGNED_URL_CACHE_SEC, tags: ['order-attachment-signed-url'] },
);

async function cachedFullUrl(storagePath: string): Promise<string | null> {
  try {
    return await signAttachmentFull(storagePath);
  } catch (err) {
    console.warn(
      `[order-attachments] sign failed (${storagePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function cachedThumbUrl(storagePath: string, width: number): Promise<string | null> {
  try {
    return await signAttachmentThumb(storagePath, width);
  } catch (err) {
    console.warn(
      `[order-attachments] thumb sign failed (${storagePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Only raster images the transform pipeline can decode get a thumb request;
 *  HEIC/HEIF (iPhone) and non-images fall through to the full URL. */
export function attachmentWantsThumb(contentType: string | null): boolean {
  if (!contentType?.startsWith('image/')) return false;
  return !/heic|heif/i.test(contentType);
}

const GRID_THUMB_WIDTH = 400;

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
  /** Long-lived signed URL to the ORIGINAL (open/download). Null if signing failed. */
  url: string | null;
  /** ~400px grid variant for image attachments; falls back to `url` when the
   *  transform isn't applicable (HEIC, PDFs) or signing failed. */
  thumbUrl: string | null;
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

    // Sign per path through the 25-day cache: same URL every render, so the
    // browser (and any CDN) can actually cache the bytes. Thumb + full sign
    // in parallel per row; a failed thumb falls back to the full URL.
    return Promise.all(
      rows.map(async (r) => {
        const storagePath = r.storage_path as string;
        const contentType = (r.content_type as string | null) ?? null;
        const [url, thumb] = await Promise.all([
          cachedFullUrl(storagePath),
          attachmentWantsThumb(contentType)
            ? cachedThumbUrl(storagePath, GRID_THUMB_WIDTH)
            : Promise.resolve(null),
        ]);
        return {
          id: r.id as string,
          orderRequestId: r.order_request_id as string,
          storagePath,
          fileName: (r.file_name as string | null) ?? null,
          contentType,
          sizeBytes: (r.size_bytes as number | null) ?? null,
          kind: ((r.kind as string | null) ?? 'other') as OrderAttachmentKind,
          uploadedBy: (r.uploaded_by as string | null) ?? null,
          createdAt: r.created_at as string,
          url,
          thumbUrl: thumb ?? url,
        };
      }),
    );
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
    // HI-8: the uploaded object must match EXACTLY the path the uploader
    // mints — `{org}/{orderRequestId}/{file}`. This was a
    // `startsWith(`${orgId}/`)` prefix check, which is satisfied by
    // `${orgId}/../../item-images/<victim-org>/<victim-item>/cover.jpg`:
    // @supabase/storage-js interpolates the path into a fetch() URL and the
    // WHATWG parser resolves `..` before the request leaves Node, so the
    // prefix held while the path escaped the org folder AND the bucket, and
    // came back as a signed URL RLS never saw. Pinning the ORDER id as well
    // as the org id is new — the prefix check let a manager file order A's
    // attachment row against order B's uploaded delivery proof.
    if (
      !isValidStoragePath(
        input.storagePath,
        orderAttachmentPathShape(this.ctx.organizationId, input.orderRequestId),
      )
    ) {
      throw new ServiceError('validation_error', 'Invalid storage path.');
    }

    // ═══ VERIFY THE BYTES, NOT THE CLIENT'S WORD FOR THEM ═══
    //
    // order-attachments-panel.tsx uploads client-direct with
    // `contentType: file.type`, and the bucket's allowed_mime_types only
    // validates that client-sent header. Delivery proof and signed paperwork
    // are later signed and rendered, so an unverified object here is a payload
    // host on our own storage origin. Verify-or-delete, mirroring the
    // maintenance-attachments reference: on any disagreement the object is
    // REMOVED and no row is written.
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
      .from('order_request_attachments')
      .insert({
        organization_id: this.ctx.organizationId,
        order_request_id: input.orderRequestId,
        storage_path: input.storagePath,
        file_name: input.fileName,
        // The SNIFFED mime, never the declared one.
        content_type: sniffed.mime,
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
