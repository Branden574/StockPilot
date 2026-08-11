'use client';

import {
  ArrowDown,
  ArrowUp,
  Film,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { uploadWithProgress } from '@/lib/upload-with-progress';
import { captureVideoPoster } from '@/components/procedures/capture-poster';
import { uploadVideoMaster } from '@/components/procedures/upload-video-master';
import {
  createProcedureVideoUploadAction,
  deleteProcedureVideoAction,
  recordProcedureVideoAction,
} from '@/server/actions/procedures';

const PROCEDURE_VIDEOS_BUCKET = 'procedure-videos';
const ACCEPT_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];
// 1 GB matches the bucket's file_size_limit from the migration. NOTE: the
// Supabase project-wide global upload limit must also be >= this value, or
// storage rejects the upload regardless of the per-bucket cap.
const MAX_BYTES = 1024 * 1024 * 1024;

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

/**
 * In-memory representation of a video the user has dropped into the
 * create-page uploader but hasn't yet uploaded. Owned by the parent
 * <ProcedureForm> so the form can drive the upload loop after the
 * procedure row is created.
 */
export interface StagedVideo {
  tempId: string;
  file: File;
  title: string;
  durationSeconds: number | null;
  sizeBytes: number;
  mimeType: string;
  status: 'pending' | 'uploading' | 'recorded' | 'failed';
  error?: string;
}

type ImmediateProps = {
  mode: 'immediate';
  procedureId: string;
  organizationId: string;
  initialVideos: UploadedVideo[];
};

type StagedProps = {
  mode: 'staged';
  staged: StagedVideo[];
  onStagedChange: (next: StagedVideo[]) => void;
  /** When true, the form is busy uploading after submit. Lock the UI. */
  uploading?: boolean;
};

type VideoUploaderProps = ImmediateProps | StagedProps;

interface PendingUpload {
  key: string;
  name: string;
  status: 'uploading' | 'recording' | 'done' | 'error';
  /** Real transported percentage for this file, or null before the first
   *  transport event. Never synthesised — see lib/upload-with-progress.ts. */
  percent: number | null;
  error?: string;
}

export function extensionFromMime(mime: string): string {
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'video/webm') return 'webm';
  return 'mp4';
}

export async function probeVideoMetadata(
  file: File,
): Promise<{ duration: number | null }> {
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

function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * Capture + upload a poster JPEG for a video file. Best-effort: returns the
 * poster storage path on success, null on any failure (capture or upload) —
 * the video records without a poster and the grid falls back to the
 * video-first-frame trick. PUTs to the presigned poster URL minted alongside
 * the master's (createProcedureVideoUploadAction) — no progress reporting;
 * a ~30 KB JPEG is a rounding error next to the video.
 */
export async function uploadPosterFor(
  file: File,
  posterSignedUrl: string,
  posterPath: string,
): Promise<string | null> {
  try {
    const blob = await captureVideoPoster(file);
    if (!blob) return null;
    const res = await uploadWithProgress({
      url: posterSignedUrl,
      body: blob,
      contentType: 'image/jpeg',
      // The SDK upload this replaced set cacheControl: '3600'; the presigned
      // PUT carries the same object metadata via the header form.
      headers: { 'cache-control': 'max-age=3600' },
    });
    return res.ok ? posterPath : null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFile(file: File): string | null {
  if (!ACCEPT_MIME.includes(file.type)) {
    return `"${file.name}" isn't a supported video type. Use MP4, MOV, or WEBM.`;
  }
  if (file.size > MAX_BYTES) {
    return `"${file.name}" is over 1 GB.`;
  }
  return null;
}

/**
 * Drag-and-drop video uploader for procedures. Two modes:
 *
 *   immediate — used on the edit page. Mints a presigned upload URL
 *               (createProcedureVideoUploadAction — the server builds the
 *               `{org_id}/{procedure_id}/{uuid}.{ext}` path from its own org
 *               id) and PUTs the file to it via `uploadVideoMaster`, then
 *               calls `recordProcedureVideoAction` to insert the DB row.
 *
 *   staged    — used on the create page. Validates + probes duration in
 *               the browser, then HANDS the file back to the parent form
 *               via `onStagedChange`. No network calls. The parent drives
 *               the upload loop after creating the procedure row.
 *
 * The Supabase JS SDK's `storage.from(...).upload(...)` does not expose XHR
 * upload progress, which is why the master goes through the presigned-URL +
 * XHR PUT route instead (lib/upload-with-progress) — each uploading file
 * shows the REAL transported percentage, never a synthesised one.
 */
export function VideoUploader(props: VideoUploaderProps) {
  if (props.mode === 'staged') return <StagedUploader {...props} />;
  return <ImmediateUploader {...props} />;
}

// ---------------------------------------------------------------------------
// Shared row rendering — used by both modes for the dropped-files list.
// ---------------------------------------------------------------------------

interface VideoRowProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  meta: string;
  status?: React.ReactNode;
  actions?: React.ReactNode;
}

function VideoRow({ icon, title, meta, status, actions }: VideoRowProps) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="grid h-9 w-12 flex-none place-items-center rounded bg-muted text-muted-foreground">
          {icon ?? <Film className="h-4 w-4" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          <p className="text-xs text-muted-foreground">{meta}</p>
          {status && <div className="mt-0.5 text-xs">{status}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-none items-center gap-1">{actions}</div>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Immediate mode — same behavior as before the refactor.
// ---------------------------------------------------------------------------

function ImmediateUploader({ procedureId, initialVideos }: ImmediateProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [videos, setVideos] = React.useState<UploadedVideo[]>(initialVideos);
  const [pending, setPending] = React.useState<PendingUpload[]>([]);
  const [deleteTarget, setDeleteTarget] = React.useState<UploadedVideo | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
    setVideos(initialVideos);
  }, [initialVideos]);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const supabase = createClient();

    // Track how many uploads actually made it through. The pre-fix path
    // fired "Videos uploaded." unconditionally — even when EVERY file
    // failed validation or upload — which was a confusing lie.
    let successCount = 0;

    for (const file of list) {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const validationError = validateFile(file);
      if (validationError) {
        toast.error(validationError);
        continue;
      }

      setPending((p) => [...p, { key, name: file.name, status: 'uploading', percent: null }]);

      try {
        const { duration } = await probeVideoMetadata(file);
        const ext = extensionFromMime(file.type) || (file.name.split('.').pop() ?? 'mp4');

        // Server mints the storage path + presigned PUT URLs — the path is
        // built from the SERVER's org id, and record() below re-validates it.
        const presign = await createProcedureVideoUploadAction({ procedureId, fileExt: ext });
        if (!presign.ok) {
          setPending((p) =>
            p.map((x) =>
              x.key === key ? { ...x, status: 'error', error: presign.error.message } : x,
            ),
          );
          toast.error(`Couldn't upload "${file.name}": ${presign.error.message}`);
          continue;
        }
        const path = presign.data.path;

        // XHR PUT with real transported progress — the file is handed to XHR
        // as the Blob it already is (streamed from disk, never arrayBuffer'd;
        // these run up to 1 GB). See upload-video-master.ts for the honesty
        // rules: monotonic, held at 99 until success, never 100 on failure.
        const upRes = await uploadVideoMaster({
          signedUrl: presign.data.signedUrl,
          file,
          contentType: file.type || 'video/mp4',
          onProgress: ({ percent }) => {
            setPending((p) => p.map((x) => (x.key === key ? { ...x, percent } : x)));
          },
        });
        if (!upRes.ok) {
          const message = `upload failed (HTTP ${upRes.status})`;
          setPending((p) =>
            p.map((x) => (x.key === key ? { ...x, status: 'error', error: message } : x)),
          );
          toast.error(`Couldn't upload "${file.name}": ${message}`);
          continue;
        }

        // Poster frame — best-effort. A ~30 KB JPEG lets the Procedures grid
        // render an <img> instead of range-fetching the full video file.
        const posterPath = await uploadPosterFor(
          file,
          presign.data.posterSignedUrl,
          presign.data.posterPath,
        );

        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, status: 'recording' } : x)),
        );

        const record = await recordProcedureVideoAction({
          procedureId,
          storagePath: path,
          thumbnailPath: posterPath,
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
        successCount += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Upload failed';
        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, status: 'error', error: msg } : x)),
        );
        toast.error(msg);
      }
    }

    if (successCount > 0) {
      toast.success(
        successCount === 1 ? 'Video uploaded.' : `${successCount} videos uploaded.`,
      );
    }
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
            <VideoRow
              key={v.id}
              title={v.title ?? 'Untitled video'}
              meta={`${v.duration_seconds ? `${v.duration_seconds}s` : 'unknown duration'}${
                v.size_bytes ? ` · ${formatBytes(v.size_bytes)}` : ''
              }`}
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(v)}
                  aria-label={`Delete ${v.title ?? 'video'}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              }
            />
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
                <span className="text-muted-foreground">
                  {p.percent === null ? 'uploading…' : `uploading… ${p.percent}%`}
                </span>
              )}
              {p.status === 'recording' && (
                <span className="text-muted-foreground">finalizing…</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <DropZone
        dragOver={dragOver}
        setDragOver={setDragOver}
        inputRef={inputRef}
        onFiles={uploadFiles}
        disabled={false}
      />

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

// ---------------------------------------------------------------------------
// Staged mode — used on the create page. Parent owns the array.
// ---------------------------------------------------------------------------

function StagedUploader({
  staged,
  onStagedChange,
  uploading = false,
}: StagedProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);

  async function stageFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const next: StagedVideo[] = [...staged];

    for (const file of list) {
      const validationError = validateFile(file);
      if (validationError) {
        toast.error(validationError);
        continue;
      }
      const { duration } = await probeVideoMetadata(file);
      next.push({
        tempId: crypto.randomUUID(),
        file,
        title: stripExtension(file.name),
        durationSeconds: duration,
        sizeBytes: file.size,
        mimeType: file.type || 'video/mp4',
        status: 'pending',
      });
    }

    onStagedChange(next);
  }

  function rename(tempId: string, title: string) {
    onStagedChange(staged.map((s) => (s.tempId === tempId ? { ...s, title } : s)));
  }

  function remove(tempId: string) {
    onStagedChange(staged.filter((s) => s.tempId !== tempId));
  }

  function move(tempId: string, dir: -1 | 1) {
    const idx = staged.findIndex((s) => s.tempId === tempId);
    if (idx < 0) return;
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= staged.length) return;
    const next = staged.slice();
    [next[idx], next[swapWith]] = [next[swapWith]!, next[idx]!];
    onStagedChange(next);
  }

  return (
    <div className="space-y-3">
      {staged.length > 0 && (
        <ul className="space-y-2">
          {staged.map((s, idx) => (
            <VideoRow
              key={s.tempId}
              title={
                <Input
                  value={s.title}
                  onChange={(e) => rename(s.tempId, e.target.value)}
                  disabled={uploading}
                  maxLength={200}
                  className="h-8 text-sm"
                  aria-label={`Title for ${s.file.name}`}
                />
              }
              meta={`${s.durationSeconds ? `${s.durationSeconds}s` : 'unknown duration'}${
                s.sizeBytes ? ` · ${formatBytes(s.sizeBytes)}` : ''
              }`}
              status={<StagedStatus video={s} />}
              actions={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => move(s.tempId, -1)}
                    disabled={uploading || idx === 0}
                    aria-label={`Move ${s.file.name} up`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => move(s.tempId, 1)}
                    disabled={uploading || idx === staged.length - 1}
                    aria-label={`Move ${s.file.name} down`}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(s.tempId)}
                    disabled={uploading}
                    aria-label={`Remove ${s.file.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              }
            />
          ))}
        </ul>
      )}

      <DropZone
        dragOver={dragOver}
        setDragOver={setDragOver}
        inputRef={inputRef}
        onFiles={stageFiles}
        disabled={uploading}
      />
    </div>
  );
}

function StagedStatus({ video }: { video: StagedVideo }) {
  if (video.status === 'pending') {
    return <span className="text-muted-foreground">Ready to upload</span>;
  }
  if (video.status === 'uploading') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
      </span>
    );
  }
  if (video.status === 'recorded') {
    return <span className="text-success">Uploaded</span>;
  }
  return (
    <span className="text-destructive">
      Failed{video.error ? `: ${video.error}` : ''}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared drop zone
// ---------------------------------------------------------------------------

interface DropZoneProps {
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | File[]) => void | Promise<void>;
  disabled: boolean;
}

function DropZone({
  dragOver,
  setDragOver,
  inputRef,
  onFiles,
  disabled,
}: DropZoneProps) {
  return (
    <label
      htmlFor="video-upload"
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files) void onFiles(e.dataTransfer.files);
      }}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 px-6 py-8 transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-60'
          : 'cursor-pointer hover:border-primary/40 hover:bg-muted/40',
        !disabled && dragOver && 'border-primary bg-primary/5',
      )}
    >
      <Film className="h-5 w-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">Drop videos, or click to browse</p>
      <p className="text-xs text-muted-foreground">
        MP4, MOV, WEBM · up to 1 GB each
      </p>
      <input
        id="video-upload"
        ref={inputRef}
        type="file"
        accept={ACCEPT_MIME.join(',')}
        multiple
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          if (e.target.files) void onFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-3.5 w-3.5" /> Choose files
      </Button>
    </label>
  );
}
