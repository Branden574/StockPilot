'use client';

import { Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { compressImageVariants } from '@/lib/image-variants';
import { createClient } from '@/lib/supabase/client';
import {
  addOrderAttachmentAction,
  deleteOrderAttachmentAction,
} from '@/server/actions/order-attachments';
import type {
  OrderAttachment,
  OrderAttachmentKind,
} from '@/server/services/order-attachments';

const KIND_LABELS: Record<OrderAttachmentKind, string> = {
  signature: 'Wet signature',
  dropoff_photo: 'Items dropped off',
  location: 'Drop-off location',
  other: 'Other',
};

const BUCKET = 'order-attachments';
const ACCEPT = 'image/*,application/pdf';
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export function OrderAttachmentsPanel({
  orderId,
  organizationId,
  attachments,
  canManage,
  canAttach,
}: {
  orderId: string;
  organizationId: string;
  attachments: OrderAttachment[];
  canManage: boolean;
  canAttach: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = React.useState<OrderAttachmentKind>('dropoff_photo');
  const [busy, setBusy] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  // Attachment ids whose <img> failed to decode (HEIC on desktop, expired
  // URL) — those tiles fall back to the file chip instead of a broken glyph.
  const [failedIds, setFailedIds] = React.useState<Set<string>>(new Set());
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    const supabase = createClient();
    let uploaded = 0;
    for (const rawFile of Array.from(files)) {
      if (rawFile.size > MAX_BYTES) {
        toast.error(`${rawFile.name} is too large (max 15 MB).`);
        continue;
      }
      // Compress image proofs before upload (2048px WebP, visually lossless)
      // — same treatment item photos and the mobile app already get. This
      // also transcodes iPhone HEIC to a browser-renderable format at the
      // source. Owner-approved 2026-07-01: raw originals are not kept.
      // Non-images (PDFs) and any compression failure upload the raw file.
      let file = rawFile;
      if (rawFile.type.startsWith('image/')) {
        try {
          const { master } = await compressImageVariants(rawFile);
          file = master;
        } catch {
          /* compression failure — upload the original */
        }
      }
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${organizationId}/${orderId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (upErr) {
        toast.error(`Upload failed: ${upErr.message}`);
        continue;
      }
      const r = await addOrderAttachmentAction({
        orderRequestId: orderId,
        storagePath: path,
        fileName: file.name,
        contentType: file.type || null,
        sizeBytes: file.size,
        kind,
      });
      if (!r.ok) {
        toast.error(r.error.message);
        // Clean up the orphaned object if the metadata insert was rejected.
        await supabase.storage.from(BUCKET).remove([path]);
        continue;
      }
      uploaded += 1;
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
    if (uploaded > 0) {
      toast.success(`Added ${uploaded} attachment${uploaded === 1 ? '' : 's'}.`);
      router.refresh();
    }
  }

  async function onDelete(id: string) {
    setDeletingId(id);
    const r = await deleteOrderAttachmentAction({ attachmentId: id, orderRequestId: orderId });
    setDeletingId(null);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Attachment removed.');
    router.refresh();
  }

  return (
    <section className="bg-card rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Proof of delivery</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Wet signatures, photos of dropped-off items, and where they were left.
          </p>
        </div>
        {canAttach && (
          <div className="flex items-center gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as OrderAttachmentKind)}>
              <SelectTrigger className="h-8 w-[160px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dropoff_photo">Items dropped off</SelectItem>
                <SelectItem value="location">Drop-off location</SelectItem>
                <SelectItem value="signature">Wet signature</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Add
            </Button>
          </div>
        )}
      </div>

      {attachments.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-xs">
          {canAttach
            ? 'No attachments yet. Add photos or a signed slip as proof of delivery.'
            : 'No attachments.'}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {attachments.map((a) => {
            // HEIC/HEIF (iPhone default) is bucket-allowed but most desktop
            // browsers can't decode it — without onError those tiles render
            // as a broken-image glyph that reads like lost delivery proof.
            // Failed images fall back to the file tile below instead.
            const isImage =
              (a.contentType ?? '').startsWith('image/') && !failedIds.has(a.id);
            return (
              <div
                key={a.id}
                className="group bg-background relative overflow-hidden rounded-md border"
              >
                <a
                  href={a.url ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  {isImage && (a.thumbUrl ?? a.url) ? (
                    // ~400px cached grid variant (thumbUrl) — the anchor above
                    // still opens the full original. Signed URL to a private
                    // bucket object — plain img, not next/image.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={(a.thumbUrl ?? a.url)!}
                      alt={a.fileName ?? 'Attachment'}
                      className="h-28 w-full object-cover"
                      loading="lazy"
                      decoding="async"
                      onError={() =>
                        setFailedIds((prev) => new Set(prev).add(a.id))
                      }
                    />
                  ) : (
                    <div className="text-muted-foreground flex h-28 w-full flex-col items-center justify-center gap-1">
                      <Paperclip className="h-5 w-5" />
                      <span className="max-w-[90%] truncate px-2 text-[10.5px]">
                        {a.fileName ?? 'File'}
                      </span>
                    </div>
                  )}
                </a>
                <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                  <span className="text-muted-foreground truncate text-[10.5px]">
                    {KIND_LABELS[a.kind] ?? 'Other'}
                  </span>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => onDelete(a.id)}
                      disabled={deletingId === a.id}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      aria-label="Delete attachment"
                    >
                      {deletingId === a.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
