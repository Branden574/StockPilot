'use client';

import { Download, FileArchive, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import {
  addPoAttachmentAction,
  deletePoAttachmentAction,
} from '@/server/actions/po-attachments';
import type { PoAttachment } from '@/server/services/po-attachments';

const BUCKET = 'po-attachments';
const ACCEPT = 'image/*,application/pdf';
const MAX_BYTES = 15 * 1024 * 1024; // must match the bucket's file_size_limit (mig 0211)

/**
 * Header actions for PO files — sits next to "Download PDF":
 *   • "Attach file" → upload one or more files onto this PO (managers / granted),
 *   • "Download all" → zip of the PO PDF + every attachment (shown only when
 *     there's something to bundle).
 * The list + delete lives in <PoAttachmentsList/> below; after an upload we
 * router.refresh() so that server-rendered list re-fetches.
 */
export function PoFileActions({
  purchaseOrderId,
  organizationId,
  canManage,
  hasAttachments,
}: {
  purchaseOrderId: string;
  organizationId: string;
  canManage: boolean;
  hasAttachments: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    const supabase = createClient();
    let uploaded = 0;
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is too large (max 15 MB).`);
        continue;
      }
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${organizationId}/${purchaseOrderId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (upErr) {
        toast.error(`Upload failed: ${upErr.message}`);
        continue;
      }
      const r = await addPoAttachmentAction({
        purchaseOrderId,
        storagePath: path,
        fileName: file.name,
        contentType: file.type || null,
        sizeBytes: file.size,
      });
      if (!r.ok) {
        toast.error(r.error.message);
        await supabase.storage.from(BUCKET).remove([path]); // roll back the orphan
        continue;
      }
      uploaded += 1;
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
    if (uploaded > 0) {
      toast.success(`Added ${uploaded} file${uploaded === 1 ? '' : 's'}.`);
      router.refresh();
    }
  }

  return (
    <>
      {hasAttachments && (
        <Button asChild variant="outline">
          <a
            href={`/api/purchase-orders/${purchaseOrderId}/attachments.zip`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileArchive className="h-4 w-4" /> Download all
          </a>
        </Button>
      )}
      {canManage && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
          <Button variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Attach file
          </Button>
        </>
      )}
    </>
  );
}

/** The attachments list + per-file delete (managers / granted). Body section. */
export function PoAttachmentsList({
  purchaseOrderId,
  attachments,
  canManage,
}: {
  purchaseOrderId: string;
  attachments: PoAttachment[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  async function onDelete(id: string) {
    setDeletingId(id);
    const r = await deletePoAttachmentAction({ attachmentId: id, purchaseOrderId });
    setDeletingId(null);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('File removed.');
    router.refresh();
  }

  if (attachments.length === 0) return null;

  return (
    <section className="bg-card mt-6 rounded-xl border p-4">
      <h2 className="text-sm font-medium">Attachments</h2>
      <p className="text-muted-foreground mt-0.5 text-xs">
        Packing slips, receipts, and other files for this purchase order.
      </p>
      <ul className="divide-border mt-3 divide-y rounded-md border">
        {attachments.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
            <Paperclip className="text-muted-foreground h-4 w-4 shrink-0" />
            <a
              href={a.url ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-[13px] hover:underline"
              title={a.fileName ?? 'File'}
            >
              {a.fileName ?? 'File'}
            </a>
            {a.url && (
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground shrink-0"
                aria-label={`Download ${a.fileName ?? 'file'}`}
                download
              >
                <Download className="h-4 w-4" />
              </a>
            )}
            {canManage && (
              <button
                type="button"
                onClick={() => onDelete(a.id)}
                disabled={deletingId === a.id}
                className="text-muted-foreground hover:text-destructive shrink-0"
                aria-label={`Delete ${a.fileName ?? 'file'}`}
              >
                {deletingId === a.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
