'use client';

import { Film, Loader2, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import {
  deleteProcedureVideoAction,
  recordProcedureVideoAction,
} from '@/server/actions/procedures';

const PROCEDURE_VIDEOS_BUCKET = 'procedure-videos';
const ACCEPT_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];
// 500 MB matches the bucket's file_size_limit from the migration.
const MAX_BYTES = 500 * 1024 * 1024;

export interface UploadedVideo {
  id: string;
  title: string | null;
  storage_path: string;
  signed_url: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  mime_type: string | null;
  order_idx: number;
}

interface VideoUploaderProps {
  procedureId: string;
  organizationId: string;
  initialVideos: UploadedVideo[];
}

interface PendingUpload {
  key: string;
  name: string;
  status: 'uploading' | 'recording' | 'done' | 'error';
  error?: string;
}

function extensionFromMime(mime: string): string {
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'video/webm') return 'webm';
  return 'mp4';
}

async function probeVideoMetadata(file: File): Promise<{ duration: number | null }> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.src = url;
      v.onloadedmetadata = () => {
        const d = Number.isFinite(v.duration) ? Math.round(v.duration) : null;
        URL.revokeObjectURL(url);
        resolve({ duration: d });
      };
      v.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ duration: null });
      };
    } catch {
      resolve({ duration: null });
    }
  });
}

/**
 * Drag-and-drop video uploader for procedures. Mirrors ImageUploader:
 *   1. Validate file type + size
 *   2. Probe duration in-browser (best-effort)
 *   3. Upload directly to Supabase storage at
 *      `{org_id}/{procedure_id}/{uuid}.{ext}` (RLS gates the first path
 *      segment to the user's org, matching the migration's policies)
 *   4. Call `recordProcedureVideoAction` to insert the DB row
 *
 * The Supabase JS SDK's `storage.from(...).upload(...)` does not expose
 * XHR upload progress, so each file shows a pending → done indicator
 * rather than a percent bar. (Not worth the complexity of swapping to
 * a presigned PUT just for percent UI.)
 */
export function VideoUploader({
  procedureId,
  organizationId,
  initialVideos,
}: VideoUploaderProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [videos, setVideos] = React.useState<UploadedVideo[]>(initialVideos);
  const [pending, setPending] = React.useState<PendingUpload[]>([]);
  const [deleteTarget, setDeleteTarget] = React.useState<UploadedVideo | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  React.useEffect(() => {
    setVideos(initialVideos);
  }, [initialVideos]);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const supabase = createClient();

    for (const file of list) {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      if (!ACCEPT_MIME.includes(file.type)) {
        toast.error(`"${file.name}" isn't a supported video type. Use MP4, MOV, or WEBM.`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.error(`"${file.name}" is over 500 MB.`);
        continue;
      }

      setPending((p) => [...p, { key, name: file.name, status: 'uploading' }]);

      try {
        const { duration } = await probeVideoMetadata(file);
        const ext = extensionFromMime(file.type) || (file.name.split('.').pop() ?? 'mp4');
        const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase() || 'mp4';
        const uuid = crypto.randomUUID();
        const path = `${organizationId}/${procedureId}/${uuid}.${safeExt}`;

        const { error: upErr } = await supabase.storage
          .from(PROCEDURE_VIDEOS_BUCKET)
          .upload(path, file, {
            cacheControl: '3600',
            contentType: file.type || 'video/mp4',
            upsert: false,
          });
        if (upErr) {
          setPending((p) =>
            p.map((x) => (x.key === key ? { ...x, status: 'error', error: upErr.message } : x)),
          );
          toast.error(`Couldn't upload "${file.name}": ${upErr.message}`);
          continue;
        }

        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, status: 'recording' } : x)),
        );

        const record = await recordProcedureVideoAction({
          procedureId,
          storagePath: path,
          title: file.name,
          durationSeconds: duration,
          sizeBytes: file.size,
          mimeType: file.type || null,
        });
        if (!record.ok) {
          // DB row failed; clean up the storage object so we don't leave
          // orphans behind. Best-effort.
          await supabase.storage.from(PROCEDURE_VIDEOS_BUCKET).remove([path]);
          setPending((p) =>
            p.map((x) =>
              x.key === key ? { ...x, status: 'error', error: record.error.message } : x,
            ),
          );
          toast.error(record.error.message);
          continue;
        }

        setPending((p) => p.map((x) => (x.key === key ? { ...x, status: 'done' } : x)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Upload failed';
        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, status: 'error', error: msg } : x)),
        );
        toast.error(msg);
      }
    }

    toast.success('Videos uploaded.');
    router.refresh();
    // Clear successful pending rows after a short delay so the user sees
    // them flip to "done" before they disappear.
    setTimeout(() => {
      setPending((p) => p.filter((x) => x.status !== 'done'));
    }, 1500);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const res = await deleteProcedureVideoAction(deleteTarget.id);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setVideos((arr) => arr.filter((v) => v.id !== deleteTarget.id));
      toast.success('Video removed.');
      router.refresh();
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-3">
      {videos.length > 0 && (
        <ul className="space-y-2">
          {videos.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-9 w-12 flex-none place-items-center rounded bg-muted text-muted-foreground">
                  <Film className="h-4 w-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {v.title ?? 'Untitled video'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {v.duration_seconds ? `${v.duration_seconds}s` : 'unknown duration'}
                    {v.size_bytes ? ` · ${(v.size_bytes / (1024 * 1024)).toFixed(1)} MB` : ''}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDeleteTarget(v)}
                aria-label={`Delete ${v.title ?? 'video'}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <ul className="space-y-1">
          {pending.map((p) => (
            <li
              key={p.key}
              className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs"
            >
              {p.status === 'error' ? (
                <span className="text-destructive">Failed: {p.error ?? 'unknown'}</span>
              ) : p.status === 'done' ? (
                <span className="text-success">Uploaded</span>
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
              <span className="truncate">{p.name}</span>
              {p.status === 'uploading' && (
                <span className="text-muted-foreground">uploading…</span>
              )}
              {p.status === 'recording' && (
                <span className="text-muted-foreground">finalizing…</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <label
        htmlFor="video-upload"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files) void uploadFiles(e.dataTransfer.files);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-8 transition-colors hover:border-primary/40 hover:bg-muted/40',
          dragOver && 'border-primary bg-primary/5',
        )}
      >
        <Film className="h-5 w-5 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Drop videos, or click to browse</p>
        <p className="text-xs text-muted-foreground">
          MP4, MOV, WEBM · up to 500 MB each
        </p>
        <input
          id="video-upload"
          ref={inputRef}
          type="file"
          accept={ACCEPT_MIME.join(',')}
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" /> Choose files
        </Button>
      </label>

      <DestructiveConfirm
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title="Remove this video?"
        description="The video file is deleted from storage and the procedure no longer shows it. This cannot be undone."
        confirmLabel="Remove"
        pending={deleteBusy}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
