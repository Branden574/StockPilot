'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { MAINTENANCE_MAX_PHOTOS, type MaintenanceAttachmentKind } from '@stockpilot/core';
import { compressImageVariants } from '@/lib/image-variants';
import { Button } from '@/components/ui/button';

export interface PanelPhoto {
  id: string;
  originalFilename: string;
  url: string;
  thumbUrl: string | null;
}

interface Props {
  requestId: string;
  photos: PanelPhoto[];
  onChange: () => void; // parent refetches
  /** Migration 0317/spec §2.2 — which attachment kind THIS panel instance
   *  uploads. Defaults to `'requester'` (today's only behavior, unchanged).
   *  The resolve dialog (a later task) reuses this same panel with
   *  `kind="resolution"` for proof photos; the server is the one place
   *  'resolution' gets manage-gated (see maintenance-attachments.ts's
   *  validateKind) — this prop only decides what gets threaded into the
   *  mint/finalize request bodies below, never an authorization decision
   *  made client-side. */
  kind?: MaintenanceAttachmentKind;
}

/** Mint-response shape from POST .../attachments (maintenance-attachments.ts
 *  createUploadUrl). Declared locally — this is a client fetch boundary, not
 *  a shared type, matching the rest of this panel's fetch calls. */
interface MintResponse {
  path: string;
  signedUrl: string;
  token: string;
  thumbPath: string;
  thumbSignedUrl: string;
  thumbToken: string;
}

interface QueuedUpload {
  key: string;
  file: File;
  name: string;
  status: 'uploading' | 'error';
  message?: string;
}

function extFromMime(mime: string): string {
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/png') return 'png';
  return 'jpg';
}

/**
 * Reads a fetch Response's JSON `message` field, falling back to an
 * accurate, human phrase rather than a generic "not allowed" string.
 * Binding constraint: the mint/finalize routes return 409 (never 429) on
 * rate-limit or the live photo-cap re-check (maintenance-attachments.ts —
 * both `createUploadUrl` and `finalize` throw ServiceError('conflict', ...)
 * for those cases), and the UI must say so plainly instead of a generic
 * failure message.
 */
async function humanizeUploadError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (body?.message) return body.message;
  if (res.status === 409) return 'Too many uploads. Please wait a moment and try again.';
  return fallback;
}

async function uploadOne(requestId: string, file: File, kind: MaintenanceAttachmentKind): Promise<void> {
  // 1) Client-side resize + HEIC->JPEG transcode + thumb generation. The
  // real return shape is { master: File, thumbBlob: Blob | null, lqip }
  // (image-variants.ts:36-40) — thumbBlob can be null when transcoding
  // fails, so the thumb PUT below is skipped rather than sending "null".
  const variants = await compressImageVariants(file);
  const ext = extFromMime(variants.master.type);

  // 2) Server mint (rate-limited, entity-checked). `kind` is always sent
  // explicitly — never omitted just because it happens to equal the
  // server's own default — so the mint and finalize bodies agree with each
  // other and with what actually gets threaded through to the insert row.
  const mintRes = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileExt: ext, originalFilename: file.name, kind }),
  });
  if (!mintRes.ok) {
    throw new Error(await humanizeUploadError(mintRes, 'Upload not allowed right now.'));
  }
  const mint = (await mintRes.json()) as MintResponse;

  // 3) PUT master (and thumb, when one was generated) to the signed URLs.
  const putMaster = await fetch(mint.signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': variants.master.type },
    body: variants.master,
  });
  if (!putMaster.ok) throw new Error('The photo upload failed. Try again.');
  if (variants.thumbBlob) {
    await fetch(mint.thumbSignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: variants.thumbBlob,
    }).catch(() => null);
  }

  // 4) Finalize: server downloads + magic-byte-verifies before recording.
  // thumbPath is deliberately NOT sent — the finalize route derives it
  // server-side from `path` (Task 9 CRITICAL 1c); the client-supplied field
  // would be dead weight at best and a rejected shape at worst.
  const finRes = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: mint.path, originalFilename: file.name, declaredMime: variants.master.type, kind }),
  });
  if (!finRes.ok) {
    throw new Error(await humanizeUploadError(finRes, 'That file is not a supported photo.'));
  }
}

export function MaintenancePhotosPanel({ requestId, photos, onChange, kind = 'requester' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<QueuedUpload[]>([]);
  const busy = uploads.some((u) => u.status === 'uploading');

  function queueKey(file: File): string {
    return `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async function runUpload(item: QueuedUpload) {
    setUploads((prev) => prev.map((u) => (u.key === item.key ? { ...u, status: 'uploading', message: undefined } : u)));
    try {
      await uploadOne(requestId, item.file, kind);
      setUploads((prev) => prev.filter((u) => u.key !== item.key));
      onChange();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Photo upload failed.';
      setUploads((prev) => prev.map((u) => (u.key === item.key ? { ...u, status: 'error', message } : u)));
      toast.error(message);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    // Client-side cap enforcement is UX only — the server re-enforces both
    // at mint (live count) and again at finalize (live re-check,
    // maintenance-attachments.ts IMPORTANT 3). Queued-but-not-yet-failed
    // uploads count against the cap too, so a second rapid-fire selection
    // can't blow past it before the first batch finishes.
    const pendingCount = uploads.filter((u) => u.status !== 'error').length;
    if (photos.length + pendingCount + files.length > MAINTENANCE_MAX_PHOTOS) {
      toast.error(`A request can carry at most ${MAINTENANCE_MAX_PHOTOS} photos.`);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    const items: QueuedUpload[] = Array.from(files).map((file) => ({
      key: queueKey(file),
      file,
      name: file.name,
      status: 'uploading',
    }));
    setUploads((prev) => [...prev, ...items]);
    if (inputRef.current) inputRef.current.value = '';
    for (const item of items) {
      await runUpload(item);
    }
  }

  async function retryUpload(key: string) {
    const item = uploads.find((u) => u.key === key);
    if (!item) return;
    await runUpload(item);
  }

  async function removePhoto(id: string) {
    const res = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not remove the photo.');
      return;
    }
    onChange();
  }

  return (
    <section
      aria-label="Request photos"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void handleFiles(e.dataTransfer.files);
      }}
      className="space-y-3 rounded-xl border border-dashed p-4"
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          Photos ({photos.length}/{MAINTENANCE_MAX_PHOTOS})
        </p>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading...' : 'Add photos'}
        </Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        capture="environment"
        multiple
        hidden
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {photos.length > 0 ? (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.thumbUrl ?? p.url}
                alt={p.originalFilename}
                className="h-24 w-full rounded-lg border object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${p.originalFilename}`}
                className="absolute right-1 top-1 rounded bg-background/80 px-1.5 text-xs"
                onClick={() => void removePhoto(p.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : uploads.length === 0 ? (
        <p className="text-sm text-muted-foreground">Drag photos here, or use your camera. HEIC photos are converted automatically.</p>
      ) : null}
      {uploads.length > 0 ? (
        <ul className="space-y-1">
          {uploads.map((u) => (
            <li key={u.key} className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs">
              <span className="truncate">{u.name}</span>
              {u.status === 'uploading' ? (
                <span className="text-muted-foreground">Uploading...</span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="text-destructive">{u.message ?? 'Upload failed.'}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Retry ${u.name}`}
                    onClick={() => void retryUpload(u.key)}
                  >
                    Retry
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
