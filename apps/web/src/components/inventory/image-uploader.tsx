'use client';

import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

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
    const res = await removeImageAction(image.id, itemId);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setImages((arr) => arr.filter((i) => i.id !== image.id));
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {images.map((img) => (
            <div key={img.id} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => deleteImage(img)}
                className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-md bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Remove image"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              {img.isPrimary && (
                <span className="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
                  Primary
                </span>
              )}
            </div>
          ))}
        </div>
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
