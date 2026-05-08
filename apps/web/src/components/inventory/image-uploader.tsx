'use client';

import { ImagePlus, Loader2, Maximize2, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { ImageLightbox } from '@/components/inventory/image-lightbox';
import { Button } from '@/components/ui/button';
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
      for (const file of list) {
        if (!ACCEPT.includes(file.type)) {
          toast.error(`${file.name}: unsupported type`);
          continue;
        }
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name}: max 10 MB`);
          continue;
        }
        const ext = file.name.split('.').pop() ?? 'jpg';

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
          toast.error(`Upload failed: ${file.name}`);
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
      toast.success('Uploaded');
      router.refresh();
    } finally {
      setUploading(false);
    }
  }

  async function deleteImage(image: ImageRow) {
    if (!confirm('Remove this image?')) return;
    await deleteImageById(image.id);
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
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt=""
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
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
                  deleteImage(img);
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
        <p className="text-xs text-muted-foreground">PNG, JPG, WebP, AVIF · up to 10 MB each</p>
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
    </div>
  );
}
