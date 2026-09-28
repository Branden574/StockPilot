'use client';

import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import { MAINTENANCE_MAX_PHOTOS, type MaintenanceAttachmentKind } from '@stockpilot/core';
import { compressImageVariants } from '@/lib/image-variants';
import { VARIANT_MIME } from '@/lib/image-variants.config';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ImageLightbox } from '@/components/inventory/image-lightbox';

export interface PanelPhoto {
  id: string;
  /** The photo's name in this panel: its alt text and the View / Remove
   *  button labels. Maintenance passes the uploaded file's name. */
  originalFilename: string;
  url: string;
  thumbUrl: string | null;
  /** Whether Remove is offered on this photo. Omitted = offered (maintenance:
   *  its DELETE route decides). A display hint only; the server re-checks. */
  canRemove?: boolean;
  /** Shown under the photo in the `card` variant: its note, then short lines
   *  (who added it, when). */
  caption?: { note?: string | null; lines?: readonly string[] };
}

/** Where one photo is uploaded. */
export interface PhotoUploadTicket {
  /** Sent back to finalize unchanged. */
  path: string;
  signedUrl: string;
  /** Where the browser-made thumbnail goes. Absent when the server makes the
   *  thumbnail itself (exception evidence), and then none is sent. */
  thumbSignedUrl?: string | null;
}

export interface PhotoFinalizeInput {
  path: string;
  originalFilename: string;
  declaredMime: string;
  /** The note typed with the photo (the panel's note field), or null. */
  note: string | null;
}

/**
 * What the panel needs from a photo backend. Each method throws an Error whose
 * message the panel shows. The default is the maintenance attachment routes
 * (maintenancePhotoEndpoints); the exception occurrence detail passes its own
 * (F1-4). Authorization is never decided here: every call is re-checked by the
 * server.
 */
export interface PhotoPanelEndpoints {
  mint(input: {
    fileExt: string;
    originalFilename: string;
    declaredMime: string;
    byteSize: number;
  }): Promise<PhotoUploadTicket>;
  finalize(input: PhotoFinalizeInput): Promise<void>;
  remove(photoId: string, reason: string | null): Promise<void>;
}

/**
 * Thrown by an endpoint's `finalize` when the photo is on the server and has
 * NOT been settled: the panel keeps that upload's finalize and Retry resends
 * it for the SAME path, instead of uploading the photo a second time. A
 * backend throws it for a refusal that did not look at the upload (a rate
 * limit), and throws PhotoAnswerLostError when the answer was lost.
 * Maintenance never throws either (its Retry starts again from the mint).
 */
export class PhotoFinalizePendingError extends Error {}

/**
 * A finalize whose answer was lost: the photo may or may not be recorded.
 * Retry resends that finalize, which the backend recognises when it is
 * already recorded; dismissing the row re-reads (it may be saved).
 */
export class PhotoAnswerLostError extends PhotoFinalizePendingError {}

/**
 * Thrown by an endpoint when the server refused for good: trying again would
 * get the same answer (the exception resolved, the cap, the file refused).
 * The row offers Dismiss only, and the panel re-reads (`onChange`), since
 * what it shows has changed. Review finding 2026-09-27: a Retry that could
 * never succeed was the only thing such a row offered.
 */
export class PhotoRefusedError extends Error {}

/** A finalize that is not settled, carried to Retry. */
class FinalizeUnconfirmed extends Error {
  constructor(
    message: string,
    readonly input: PhotoFinalizeInput,
    readonly lost: boolean,
  ) {
    super(message);
  }
}

function unsettled(e: unknown, input: PhotoFinalizeInput): unknown {
  return e instanceof PhotoFinalizePendingError
    ? new FinalizeUnconfirmed(e.message, input, e instanceof PhotoAnswerLostError)
    : e;
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
  /** The note typed when the photo was chosen: it belongs to this upload,
   *  so a Retry sends the same note even if the field has changed since. */
  note: string | null;
  status: 'uploading' | 'error';
  message?: string;
  /** Set when a finalize is not settled: Retry resends only it. */
  pendingFinalize?: PhotoFinalizeInput;
  /** Its answer was lost: the photo may be saved (dismissing re-reads). */
  answerLost?: boolean;
  /** False after a refusal the server would repeat: Dismiss only. */
  retryable?: boolean;
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

/**
 * The maintenance attachment routes: the panel's default endpoints, exactly
 * the requests it has always sent. `kind` is always sent explicitly — never
 * omitted just because it happens to equal the server's own default — so the
 * mint and finalize bodies agree with each other and with what actually gets
 * threaded through to the insert row.
 */
export function maintenancePhotoEndpoints(
  requestId: string,
  kind: MaintenanceAttachmentKind = 'requester',
): PhotoPanelEndpoints {
  return {
    async mint({ fileExt, originalFilename }) {
      // Server mint (rate-limited, entity-checked).
      const mintRes = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileExt, originalFilename, kind }),
      });
      if (!mintRes.ok) {
        throw new Error(await humanizeUploadError(mintRes, 'Upload not allowed right now.'));
      }
      const mint = (await mintRes.json()) as MintResponse;
      return { path: mint.path, signedUrl: mint.signedUrl, thumbSignedUrl: mint.thumbSignedUrl };
    },
    async finalize({ path, originalFilename, declaredMime }) {
      // Finalize: server downloads + magic-byte-verifies before recording.
      // thumbPath is deliberately NOT sent — the finalize route derives it
      // server-side (Task 9 CRITICAL 1c); the client-supplied field would be
      // dead weight at best and a rejected shape at worst.
      const finRes = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, originalFilename, declaredMime, kind }),
      });
      if (!finRes.ok) {
        throw new Error(await humanizeUploadError(finRes, 'That file is not a supported photo.'));
      }
    },
    async remove(photoId) {
      const res = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments/${photoId}`, {
        method: 'DELETE',
      }).catch(() => null);
      if (!res?.ok) throw new Error('Could not remove the photo.');
    },
  };
}

async function uploadOne(endpoints: PhotoPanelEndpoints, file: File, note: string | null): Promise<void> {
  // 1) Client-side resize + HEIC->JPEG transcode + thumb generation. The
  // real return shape is { master: File, thumbBlob: Blob | null, lqip }
  // (`ImageVariants` in lib/image-variants.ts) — thumbBlob can be null when transcoding
  // fails, so the thumb PUT below is skipped rather than sending "null".
  const variants = await compressImageVariants(file);
  const ext = extFromMime(variants.master.type);

  // 2) Server mint.
  const mint = await endpoints.mint({
    fileExt: ext,
    originalFilename: file.name,
    declaredMime: variants.master.type,
    byteSize: variants.master.size,
  });

  // 3) PUT master (and thumb, when one was generated and the backend takes
  // one) to the signed URLs.
  const putMaster = await fetch(mint.signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': variants.master.type },
    body: variants.master,
  });
  if (!putMaster.ok) throw new Error('The photo upload failed. Try again.');
  if (variants.thumbBlob && mint.thumbSignedUrl) {
    await fetch(mint.thumbSignedUrl, {
      method: 'PUT',
      // The blob's OWN type: the canvas decides what these bytes are (WebP; JPEG
      // or PNG on Safari). The bucket accepts all three.
      headers: { 'Content-Type': variants.thumbBlob.type || VARIANT_MIME },
      body: variants.thumbBlob,
    }).catch(() => null);
  }

  // 4) Finalize: the server checks the bytes before recording.
  const input: PhotoFinalizeInput = {
    path: mint.path,
    originalFilename: file.name,
    declaredMime: variants.master.type,
    note,
  };
  try {
    await endpoints.finalize(input);
  } catch (e) {
    throw unsettled(e, input);
  }
}

/** The note field (the `card` variant's photos carry a note). */
export interface PhotoNoteField {
  label: string;
  max: number;
  placeholder?: string;
}

/** Remove asks first, with an optional reason, when this is given. */
export interface PhotoRemoval {
  title: string;
  description: string;
  reasonLabel: string;
  reasonMax: number;
  confirmLabel: string;
}

type EndpointProps =
  | {
      /** Maintenance: the request the default endpoints upload to. */
      requestId: string;
      /** Migration 0317/spec §2.2 — which attachment kind THIS panel instance
       *  uploads. Defaults to `'requester'` (today's only behavior, unchanged).
       *  The resolve dialog reuses this same panel with `kind="resolution"`
       *  for proof photos; the server is the one place 'resolution' gets
       *  manage-gated (see maintenance-attachments.ts's validateKind) — this
       *  prop only decides what gets threaded into the mint/finalize request
       *  bodies, never an authorization decision made client-side. */
      kind?: MaintenanceAttachmentKind;
      endpoints?: undefined;
    }
  | {
      /** Another backend (the exception occurrence detail, F1-4). */
      endpoints: PhotoPanelEndpoints;
      requestId?: undefined;
      kind?: undefined;
    };

type Props = EndpointProps & {
  photos: PanelPhoto[];
  onChange: () => void; // parent refetches
  /** `dropzone` (default): the maintenance box. `card`: no box of its own
   *  (the parent card is one), larger tiles with captions. */
  variant?: 'dropzone' | 'card';
  maxPhotos?: number;
  /** The heading. Default "Photos (n/max)". */
  countLabel?: string;
  /** Said when a selection would pass the cap. */
  capMessage?: string;
  /** No Add photos, no note field and no drop target: the reader can only
   *  look (and remove where a photo says so). */
  readOnly?: boolean;
  /** Why adding is unavailable now, or null. Shown; while set, Add photos
   *  (and the note field) is disabled. */
  addDisabledReason?: string | null;
  noteField?: PhotoNoteField;
  removal?: PhotoRemoval;
  /** Shown when there are no photos and nothing is uploading. */
  emptyText?: string;
  /** Small print under the photos (limits, privacy). */
  footnote?: readonly string[];
  ariaLabel?: string;
  /** Why Remove is unavailable now (offline), or null. While set, each
   *  removable photo keeps its Remove, disabled, described by this reason
   *  (never a button that silently disappears). */
  removeDisabledReason?: string | null;
  /** What a photo that fails to load says (an expired link, a missing file),
   *  with a Try again that fetches fresh links. Without it a failed image is
   *  left as the browser shows it (maintenance). */
  photoLoadFailure?: { message: string; onRetry: () => void };
};

const MAINTENANCE_EMPTY_TEXT =
  'Drag photos here, or use your camera. HEIC photos are converted automatically.';

export function MaintenancePhotosPanel(props: Props) {
  const {
    photos,
    onChange,
    variant = 'dropzone',
    maxPhotos = MAINTENANCE_MAX_PHOTOS,
    readOnly = false,
    addDisabledReason = null,
    noteField,
    removal,
    removeDisabledReason = null,
    photoLoadFailure,
  } = props;
  // Read only by the handlers below; building the default per render keeps it
  // in step with requestId and kind.
  const endpoints: PhotoPanelEndpoints =
    props.endpoints ?? maintenancePhotoEndpoints(props.requestId, props.kind ?? 'requester');
  const countLabel = props.countLabel ?? `Photos (${photos.length}/${maxPhotos})`;
  const capMessage = props.capMessage ?? `A request can carry at most ${maxPhotos} photos.`;
  const emptyText = props.emptyText ?? MAINTENANCE_EMPTY_TEXT;

  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<QueuedUpload[]>([]);
  const [note, setNote] = useState('');
  // Which photo the lightbox is showing; null = closed. The lightbox gets the
  // MASTER url (p.url) — thumbs are small variants and would blur at zoom.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Remove-with-reason (only when `removal` is given).
  const [removing, setRemoving] = useState<PanelPhoto | null>(null);
  const [reason, setReason] = useState('');
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Image URLs that failed to load. Keyed by URL, so fresh links (a re-read)
  // are tried again.
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(() => new Set());
  const busy = uploads.some((u) => u.status === 'uploading');
  const removeReasonId = useId();

  function markFailed(url: string) {
    setFailedUrls((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
  }

  const trimmedNote = note.trim();
  const noteTooLong = noteField ? Array.from(trimmedNote).length > noteField.max : false;
  const addBlocked = readOnly || addDisabledReason !== null;
  const card = variant === 'card';

  function queueKey(file: File): string {
    return `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async function runUpload(item: QueuedUpload) {
    setUploads((prev) => prev.map((u) => (u.key === item.key ? { ...u, status: 'uploading', message: undefined } : u)));
    try {
      if (item.pendingFinalize) {
        // The photo is already up; only its finalize is unsettled.
        try {
          await endpoints.finalize(item.pendingFinalize);
        } catch (e) {
          throw unsettled(e, item.pendingFinalize);
        }
      } else {
        await uploadOne(endpoints, item.file, item.note);
      }
      setUploads((prev) => prev.filter((u) => u.key !== item.key));
      onChange();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Photo upload failed.';
      // Any settling answer from the server ends the finalize: the next Retry
      // starts again from the mint. Only an unsettled one keeps it.
      const pendingFinalize = e instanceof FinalizeUnconfirmed ? e.input : undefined;
      const answerLost = e instanceof FinalizeUnconfirmed && e.lost;
      const refused = e instanceof PhotoRefusedError;
      setUploads((prev) =>
        prev.map((u) =>
          u.key === item.key
            ? { ...u, status: 'error', message, pendingFinalize, answerLost, retryable: !refused }
            : u,
        ),
      );
      toast.error(message);
      // A final refusal means what the panel shows has changed (resolved,
      // the cap): read it again.
      if (refused) onChange();
    }
  }

  function dismissUpload(key: string) {
    const item = uploads.find((u) => u.key === key);
    setUploads((prev) => prev.filter((u) => u.key !== key));
    // Its answer was lost: it may be saved, and a read shows whether.
    if (item?.answerLost) onChange();
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    if (addBlocked || noteTooLong) {
      // A drop can arrive while adding is unavailable: nothing is sent.
      if (!readOnly && addDisabledReason) toast.error(addDisabledReason);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    // Client-side cap enforcement is UX only — the server re-enforces both
    // at mint (live count) and again at finalize (live re-check,
    // maintenance-attachments.ts IMPORTANT 3). Queued-but-not-yet-failed
    // uploads count against the cap too, so a second rapid-fire selection
    // can't blow past it before the first batch finishes.
    const pendingCount = uploads.filter((u) => u.status !== 'error').length;
    if (photos.length + pendingCount + files.length > maxPhotos) {
      toast.error(capMessage);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    const itemNote = noteField ? trimmedNote || null : null;
    const items: QueuedUpload[] = Array.from(files).map((file) => ({
      key: queueKey(file),
      file,
      name: file.name,
      note: itemNote,
      status: 'uploading',
    }));
    setUploads((prev) => [...prev, ...items]);
    // The note now travels with these uploads (shown on their rows).
    if (noteField) setNote('');
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
    try {
      await endpoints.remove(id, null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove the photo.');
      return;
    }
    onChange();
  }

  function askRemove(p: PanelPhoto) {
    setRemoving(p);
    setReason('');
    setRemoveError(null);
  }

  const trimmedReason = reason.trim();
  const reasonTooLong = removal ? Array.from(trimmedReason).length > removal.reasonMax : false;

  async function confirmRemove() {
    if (!removing || removePending || reasonTooLong) return;
    setRemovePending(true);
    setRemoveError(null);
    try {
      await endpoints.remove(removing.id, trimmedReason || null);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Could not remove the photo.');
      setRemovePending(false);
      return;
    }
    setRemovePending(false);
    setRemoving(null);
    onChange();
  }

  return (
    <section
      aria-label={props.ariaLabel ?? 'Request photos'}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void handleFiles(e.dataTransfer.files);
      }}
      className={card ? 'space-y-3' : 'space-y-3 rounded-xl border border-dashed p-4'}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={card ? 'text-base font-semibold' : 'text-sm font-medium'}>{countLabel}</p>
        {readOnly ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || addBlocked || noteTooLong}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? 'Uploading...' : 'Add photos'}
          </Button>
        )}
      </div>
      {addDisabledReason ? (
        <p className="text-muted-foreground text-sm" data-testid="photos-add-unavailable">
          {addDisabledReason}
        </p>
      ) : null}
      {noteField && !readOnly ? (
        <div className="space-y-1">
          <label htmlFor="photo-note" className="text-sm font-medium">
            {noteField.label}
          </label>
          <Textarea
            id="photo-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={noteField.placeholder}
            disabled={addBlocked}
          />
          <p className={noteTooLong ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
            {Array.from(trimmedNote).length.toLocaleString('en-US')} / {noteField.max.toLocaleString('en-US')}
          </p>
        </div>
      ) : null}
      {readOnly ? null : (
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
      )}
      {photos.length > 0 ? (
        <ul className={card ? 'grid grid-cols-2 gap-3 sm:grid-cols-3' : 'grid grid-cols-3 gap-3 sm:grid-cols-4'}>
          {photos.map((p) => {
            const removable = p.canRemove !== false;
            const shown = p.thumbUrl ?? p.url;
            const loadFailed = photoLoadFailure !== undefined && failedUrls.has(shown);
            const tile = (
              <>
                {loadFailed ? (
                  <div
                    role="group"
                    aria-label={p.originalFilename}
                    className={cn(
                      'flex w-full flex-col items-start justify-center gap-1 rounded-lg border p-2',
                      card ? 'h-32' : 'h-24',
                    )}
                  >
                    <p className="text-muted-foreground text-xs">{photoLoadFailure.message}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Try again: ${p.originalFilename}`}
                      onClick={photoLoadFailure.onRetry}
                    >
                      Try again
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label={`View ${p.originalFilename}`}
                    className="block w-full cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setLightboxIndex(photos.findIndex((x) => x.id === p.id))}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={shown}
                      alt={p.originalFilename}
                      onError={photoLoadFailure ? () => markFailed(shown) : undefined}
                      className={cn('w-full rounded-lg border object-cover', card ? 'h-32' : 'h-24')}
                    />
                  </button>
                )}
                {removable ? (
                  <button
                    type="button"
                    aria-label={`Remove ${p.originalFilename}`}
                    // At least 24px tall (WCAG 2.5.8).
                    className="absolute right-1 top-1 min-h-6 rounded bg-background/80 px-2 text-xs disabled:opacity-60"
                    disabled={removeDisabledReason !== null}
                    aria-describedby={removeDisabledReason !== null ? removeReasonId : undefined}
                    onClick={() => (removal ? askRemove(p) : void removePhoto(p.id))}
                  >
                    Remove
                  </button>
                ) : null}
              </>
            );
            if (!card) {
              return (
                <li key={p.id} className="group relative">
                  {tile}
                </li>
              );
            }
            return (
              <li key={p.id} className="min-w-0 space-y-1">
                <div className="group relative">{tile}</div>
                {p.caption?.note ? (
                  <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap">{p.caption.note}</p>
                ) : null}
                {p.caption?.lines?.map((line) => (
                  <p key={line} className="text-muted-foreground text-xs break-words">
                    {line}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      ) : uploads.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : null}
      {removeDisabledReason !== null && photos.some((p) => p.canRemove !== false) ? (
        <p id={removeReasonId} className="text-muted-foreground text-xs" data-testid="photos-remove-unavailable">
          {removeDisabledReason}
        </p>
      ) : null}
      {uploads.length > 0 ? (
        <ul className="space-y-1">
          {uploads.map((u) => (
            <li key={u.key} className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate">
                {u.name}
                {u.note ? <span className="text-muted-foreground"> (note: {u.note})</span> : null}
              </span>
              {u.status === 'uploading' ? (
                <span className="text-muted-foreground">Uploading...</span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="text-destructive">{u.message ?? 'Upload failed.'}</span>
                  {u.retryable !== false ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Retry ${u.name}`}
                      onClick={() => void retryUpload(u.key)}
                    >
                      Retry
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Dismiss ${u.name}`}
                    onClick={() => dismissUpload(u.key)}
                  >
                    Dismiss
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {props.footnote?.length ? (
        <div className="space-y-0.5">
          {props.footnote.map((line) => (
            <p key={line} className="text-muted-foreground text-xs">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {/* No onDelete on purpose — deletion stays on the panel's Remove
          buttons, matching the order-proof precedent in the lightbox's own
          docstring: one deletion surface is enough. */}
      <ImageLightbox
        images={photos.map((p) => ({ id: p.id, url: p.url }))}
        startIndex={lightboxIndex ?? 0}
        open={lightboxIndex !== null}
        onClose={() => setLightboxIndex(null)}
        loadFailure={photoLoadFailure}
      />
      {removal ? (
        <Dialog
          open={removing !== null}
          onOpenChange={(open) => {
            // An in-flight removal is not orphaned by a half-closed dialog.
            if (!open && !removePending) setRemoving(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{removal.title}</DialogTitle>
              <DialogDescription>{removal.description}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <label htmlFor="photo-remove-reason" className="text-sm font-medium">
                {removal.reasonLabel}
              </label>
              <Textarea
                id="photo-remove-reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setRemoveError(null);
                }}
                rows={2}
                disabled={removePending}
              />
              <p className={reasonTooLong ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
                {Array.from(trimmedReason).length.toLocaleString('en-US')} /{' '}
                {removal.reasonMax.toLocaleString('en-US')}
              </p>
            </div>
            {removeError ? (
              <p role="alert" className="text-destructive text-sm">
                {removeError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRemoving(null)}
                disabled={removePending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void confirmRemove()}
                disabled={removePending || reasonTooLong}
              >
                {removePending ? 'Removing...' : removal.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
