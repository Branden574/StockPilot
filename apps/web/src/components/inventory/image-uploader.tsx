'use client';

import { ImagePlus, Loader2, Maximize2, Trash2, Upload } from 'lucide-react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

// Dynamic + conditional render — the lightbox carousel is 450+
// lines including image-zoom math + transition state. Only opens
// when the user clicks the maximize affordance; ship the chunk
// then, not on uploader mount.
const ImageLightbox = dynamic(
  () =>
    import('@/components/inventory/image-lightbox').then((m) => ({
      default: m.ImageLightbox,
    })),
  { ssr: false },
);
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { compressImageVariants } from '@/lib/image-variants';
import {
  createImageUploadAction,
  recordImageAction,
  removeImageAction,
} from '@/server/actions/item-images';
import { cn } from '@/lib/utils';

interface ImageRow {
  id: string;
  url: string;
  isPrimary: boolean;
}

interface ImageUploaderProps {
  itemId: string;
  initialImages: ImageRow[];
}

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];

export function ImageUploader({ itemId, initialImages }: ImageUploaderProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [images, setImages] = React.useState<ImageRow[]>(initialImages);
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<ImageRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  // Keep local state in sync if the server-passed list changes (e.g. after
  // router.refresh() following an upload).
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
    setImages(initialImages);
  }, [initialImages]);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    // Snapshot once at the start so every file in this batch sees the
    // same emptiness signal — matches the prior sequential behavior.
    const galleryWasEmpty = images.length === 0;
    try {
      // Concurrency-limited parallel upload. Three at a time matches
      // the typical browser HTTP/2 concurrency to one origin without
      // saturating a slow uplink — a batch of 4 phone photos drops
      // from ~12s to ~4s. Each item runs validate → compress → presign
      // → PUT → record independently, so a failure on one doesn't
      // block the others (mirrors the prior `continue` semantics).
      const CONCURRENCY = 3;
      async function processOne(original: File, index: number): Promise<void> {
        if (!ACCEPT.includes(original.type)) {
          toast.error(
            `"${original.name}" isn't a supported image type. Use PNG, JPG, WEBP, or AVIF.`,
          );
          return;
        }
        if (original.size > MAX_BYTES) {
          toast.error(`"${original.name}" is over 10 MB. Pick a smaller image.`);
          return;
        }
        const { master, thumbBlob, lqip } = await compressImageVariants(original);
        const ext = master.name.split('.').pop() ?? 'webp';

        const presign = await createImageUploadAction({ itemId, fileExt: ext });
        if (!presign.ok) {
          toast.error(presign.error.message);
          return;
        }

        // PUT master + thumb in parallel — the thumb is tiny (~5-15 KB)
        // so the wall-clock is dominated by the master upload anyway.
        const [masterRes, thumbRes] = await Promise.all([
          fetch(presign.data.signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': master.type, 'x-upsert': 'true' },
            body: master,
          }),
          thumbBlob
            ? fetch(presign.data.thumbSignedUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'image/webp', 'x-upsert': 'true' },
                body: thumbBlob,
              })
            : Promise.resolve(null),
        ]);
        if (!masterRes.ok) {
          toast.error(
            `Couldn't upload "${original.name}". Check your network and try again.`,
          );
          return;
        }
        // Thumb failure is non-fatal — the master is up, the row will
        // just render from the master via the existing fallback path.
        const thumbOk = thumbRes ? thumbRes.ok : false;

        // Only the first file claims isFirst when the gallery started
        // empty. Mirrors the original code which read the same
        // images.length snapshot for every iteration but is now
        // explicit about which item wins.
        const isFirst = galleryWasEmpty && index === 0;
        const record = await recordImageAction({
          itemId,
          storagePath: presign.data.path,
          thumbPath: thumbOk ? presign.data.thumbPath : null,
          lqip,
          isFirst,
        });
        if (!record.ok) {
          toast.error(record.error.message);
        }
      }

      // Drain the list in waves of CONCURRENCY using a worker pool —
      // simpler + cheaper than a full p-limit dep for a constant N.
      let cursor = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
        while (cursor < list.length) {
          const i = cursor++;
          await processOne(list[i]!, i);
        }
      });
      await Promise.all(workers);
      toast.success('Photos uploaded.');
      router.refresh();
    } finally {
      setUploading(false);
    }
  }

  // Variant used by the lightbox toolbar (already confirmed there).
  async function deleteImageById(imageId: string) {
    const res = await removeImageAction(imageId, itemId);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setImages((arr) => arr.filter((i) => i.id !== imageId));
    router.refresh();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteImageById(deleteTarget.id);
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-3">
      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {images.map((img, i) => (
            <div
              key={img.id}
              className="group relative aspect-square overflow-hidden rounded-lg border bg-muted"
            >
              <button
                type="button"
                onClick={() => setLightboxIndex(i)}
                className="absolute inset-0 cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label="Open image full screen"
              >
                <Image
                  src={img.url}
                  alt=""
                  fill
                  sizes="(max-width: 640px) 33vw, (max-width: 1024px) 25vw, 200px"
                  className="object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                />
                <span
                  aria-hidden
                  className="absolute inset-0 grid place-items-center bg-black/0 text-white/0 transition-colors group-hover:bg-black/20 group-hover:text-white/90"
                >
                  <Maximize2 className="h-5 w-5" />
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget(img);
                }}
                className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-md bg-black/65 text-white shadow-sm transition-colors hover:bg-red-500/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                aria-label="Remove image"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              {img.isPrimary && (
                <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
                  Primary
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {lightboxIndex !== null && images[lightboxIndex] && (
        <ImageLightbox
          images={images}
          startIndex={lightboxIndex}
          open
          onClose={() => setLightboxIndex(null)}
          onDelete={(id) => deleteImageById(id)}
        />
      )}

      <label
        htmlFor="image-upload"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-8 transition-colors hover:border-primary/40 hover:bg-muted/40',
          dragOver && 'border-primary bg-primary/5',
        )}
      >
        {uploading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <ImagePlus className="h-5 w-5 text-muted-foreground" />
        )}
        <p className="text-sm font-medium">{uploading ? 'Uploading…' : 'Drop images, or click to browse'}</p>
        <p className="text-xs text-muted-foreground">
          PNG, JPG, WebP, AVIF · up to 10 MB each · optimized in browser before upload
        </p>
        <input
          id="image-upload"
          ref={inputRef}
          type="file"
          accept={ACCEPT.join(',')}
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={uploading}>
          <Upload className="h-3.5 w-3.5" /> Choose files
        </Button>
      </label>

      <DestructiveConfirm
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title="Remove this image?"
        description="The image is removed from this item and deleted from storage. This cannot be undone — re-upload the photo if you need it back."
        confirmLabel="Remove"
        pending={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
