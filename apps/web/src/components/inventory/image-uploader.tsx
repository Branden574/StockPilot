'use client';

import { ImagePlus, Loader2, Maximize2, Trash2, Upload } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { ImageLightbox } from '@/components/inventory/image-lightbox';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
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
const MAX_DIMENSION = 2048;
const WEBP_QUALITY = 0.85;

/**
 * Resize + transcode an upload to WebP in the browser before it ever
 * touches the network. Typical 2–10× reduction in bytes uploaded for
 * phone-camera JPEGs (4-12 MB → ~300-1200 KB) and the stored object is
 * already in a format next/image can serve directly.
 *
 * Falls back to the original file when:
 *   - createImageBitmap is unavailable (very old browser)
 *   - decoding fails (e.g. malformed file)
 *   - the WebP output ends up larger than the source (rare but possible
 *     for already-tiny images)
 *
 * Server-side validation still applies; this is just an optimization.
 */
async function compressImage(file: File): Promise<File> {
  if (typeof window === 'undefined' || typeof createImageBitmap !== 'function') {
    return file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const { width, height } = bitmap;
    let targetW = width;
    let targetH = height;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      if (width >= height) {
        targetW = MAX_DIMENSION;
        targetH = Math.round((height * MAX_DIMENSION) / width);
      } else {
        targetH = MAX_DIMENSION;
        targetW = Math.round((width * MAX_DIMENSION) / height);
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/webp', WEBP_QUALITY);
    });
    if (!blob || blob.size >= file.size) return file;
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${baseName}.webp`, {
      type: 'image/webp',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

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
    setImages(initialImages);
  }, [initialImages]);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const original of list) {
        if (!ACCEPT.includes(original.type)) {
          toast.error(`"${original.name}" isn't a supported image type. Use PNG, JPG, WEBP, or AVIF.`);
          continue;
        }
        if (original.size > MAX_BYTES) {
          toast.error(`"${original.name}" is over 10 MB. Pick a smaller image.`);
          continue;
        }

        // Compress + transcode to WebP in the browser before upload.
        // Falls back to the original on any failure.
        const file = await compressImage(original);
        const ext = file.name.split('.').pop() ?? 'webp';

        const presign = await createImageUploadAction({ itemId, fileExt: ext });
        if (!presign.ok) {
          toast.error(presign.error.message);
          continue;
        }

        const put = await fetch(presign.data.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
          body: file,
        });
        if (!put.ok) {
          toast.error(`Couldn't upload "${original.name}". Check your network and try again.`);
          continue;
        }

        const isFirst = images.length === 0;
        const record = await recordImageAction({
          itemId,
          storagePath: presign.data.path,
          isFirst,
        });
        if (!record.ok) {
          toast.error(record.error.message);
          continue;
        }
      }
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
