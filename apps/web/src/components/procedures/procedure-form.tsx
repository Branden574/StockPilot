'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createClient } from '@/lib/supabase/client';
import { BatchProgress } from '@/lib/upload-with-progress';
import {
  createProcedureAction,
  createProcedureVideoUploadAction,
  recordProcedureVideoAction,
  updateProcedureAction,
} from '@/server/actions/procedures';

import { uploadVideoMaster } from './upload-video-master';
import {
  VideoUploader,
  extensionFromMime,
  uploadPosterFor,
  type StagedVideo,
  type UploadedVideo,
} from './video-uploader';

const PROCEDURE_VIDEOS_BUCKET = 'procedure-videos';

interface CategoryOption {
  id: string;
  name: string;
  color: string | null;
}

interface WarehouseOption {
  id: string;
  name: string;
}

interface Defaults {
  id?: string;
  title?: string;
  description?: string | null;
  body?: string | null;
  categoryId?: string | null;
  authoringWarehouseId?: string | null;
  /**
   * ISO timestamp of the procedure row's `updated_at` at the time this
   * form was loaded. Passed as `ifMatch` on save so a concurrent edit by
   * another manager surfaces as a `conflict` rather than silently
   * overwriting their changes. Omit for create-mode.
   */
  updatedAt?: string;
}

interface ProcedureFormProps {
  mode: 'create' | 'edit';
  categories: CategoryOption[];
  warehouses: WarehouseOption[];
  /** Org id for the storage path prefix (RLS gates the first segment). */
  organizationId: string;
  defaults?: Defaults;
  videos?: UploadedVideo[];
}

const NULL_VALUE = '__none';

/**
 * Procedure create/edit form.
 *
 * Create mode: videos can be STAGED inline (held in browser memory). On
 * submit we (1) create the procedure row, then (2) loop sequentially over
 * the staged files, upload each to storage, and call
 * recordProcedureVideoAction. Sequential because parallel uploads of
 * large files thrash small uplinks.
 *
 * Edit mode: the uploader is in "immediate" mode — each drop uploads
 * right away against the known procedure id.
 */
export function ProcedureForm({
  mode,
  categories,
  warehouses,
  organizationId,
  defaults,
  videos = [],
}: ProcedureFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';
  const [title, setTitle] = React.useState(defaults?.title ?? '');
  const [description, setDescription] = React.useState(defaults?.description ?? '');
  const [body, setBody] = React.useState(defaults?.body ?? '');
  const [categoryId, setCategoryId] = React.useState<string>(
    defaults?.categoryId ?? NULL_VALUE,
  );
  const [authoringWarehouseId, setAuthoringWarehouseId] = React.useState<string>(
    defaults?.authoringWarehouseId ?? NULL_VALUE,
  );
  const [busy, setBusy] = React.useState(false);
  const [staged, setStaged] = React.useState<StagedVideo[]>([]);
  /** While > 0, the form is mid-batch uploading staged videos. `percent` is
   *  the byte-weighted REAL transported percentage across the whole batch
   *  (see lib/upload-with-progress's BatchProgress) — never synthesised. */
  const [uploadCursor, setUploadCursor] = React.useState<{
    current: number;
    total: number;
    percent: number;
  } | null>(null);

  function submitButtonCopy(): string {
    if (uploadCursor) {
      return `Uploading ${uploadCursor.current} of ${uploadCursor.total}… ${uploadCursor.percent}%`;
    }
    if (busy) return isEdit ? 'Saving…' : 'Creating…';
    return isEdit ? 'Save changes' : 'Create procedure';
  }

  /**
   * Sequentially upload each staged video to storage, then call
   * recordProcedureVideoAction. Returns true if every file recorded;
   * false if any failed. Mutates `staged` (via setStaged) to reflect
   * per-file status.
   */
  async function runStagedUploads(procedureId: string): Promise<boolean> {
    const supabase = createClient();
    let allOk = true;
    // Snapshot the array now — the indices we use for orderIdx must be
    // stable across the loop even as we update per-item status.
    const snapshot = staged;
    // Byte-weighted across the whole batch, denominator fixed up front —
    // see BatchProgress for why a moving denominator would let the
    // percentage travel backwards. Uploads are sequential, but a failed
    // file settles as FAILED and keeps only the fraction it truly reached,
    // so the batch can never read 100% when an upload died.
    const batch = new BatchProgress(
      snapshot.map((s) => ({ key: s.tempId, weight: s.sizeBytes })),
    );
    const publishProgress = (current: number) =>
      setUploadCursor({ current, total: snapshot.length, percent: batch.percent });
    for (let i = 0; i < snapshot.length; i++) {
      const entry = snapshot[i]!;
      publishProgress(i + 1);
      // Flip this row to "uploading".
      setStaged((arr) =>
        arr.map((s) => (s.tempId === entry.tempId ? { ...s, status: 'uploading' } : s)),
      );

      try {
        const ext =
          extensionFromMime(entry.mimeType) ||
          (entry.file.name.split('.').pop() ?? 'mp4');

        // Server mints the storage path + presigned PUT URLs from its own
        // org id; recordProcedureVideoAction re-validates the same shape.
        const presign = await createProcedureVideoUploadAction({
          procedureId,
          fileExt: ext,
        });
        if (!presign.ok) throw new Error(presign.error.message);
        const path = presign.data.path;

        // XHR PUT with real transported progress — the file goes to XHR as
        // the Blob it already is (streamed, never arrayBuffer'd; these run
        // up to 1 GB). See upload-video-master.ts for the honesty rules.
        const upRes = await uploadVideoMaster({
          signedUrl: presign.data.signedUrl,
          file: entry.file,
          contentType: entry.mimeType || 'video/mp4',
          onProgress: ({ fraction }) => {
            batch.set(entry.tempId, fraction);
            publishProgress(i + 1);
          },
        });
        if (!upRes.ok) {
          batch.settle(entry.tempId, false);
          publishProgress(i + 1);
          throw new Error(`upload failed (HTTP ${upRes.status})`);
        }
        batch.settle(entry.tempId, true);
        publishProgress(i + 1);

        // Best-effort poster frame so the Procedures grid renders a small
        // <img> instead of range-fetching the full video (see uploadPosterFor).
        const posterPath = await uploadPosterFor(
          entry.file,
          presign.data.posterSignedUrl,
          presign.data.posterPath,
        );

        const record = await recordProcedureVideoAction({
          procedureId,
          storagePath: path,
          thumbnailPath: posterPath,
          title: entry.title.trim() || entry.file.name,
          durationSeconds: entry.durationSeconds,
          sizeBytes: entry.sizeBytes,
          mimeType: entry.mimeType || null,
          orderIdx: i,
        });
        if (!record.ok) {
          // DB row failed — clean up the storage object so we don't
          // leave orphan files behind. Best-effort.
          await supabase.storage.from(PROCEDURE_VIDEOS_BUCKET).remove([path]);
          throw new Error(record.error.message);
        }

        setStaged((arr) =>
          arr.map((s) => (s.tempId === entry.tempId ? { ...s, status: 'recorded' } : s)),
        );
      } catch (e) {
        allOk = false;
        const msg = e instanceof Error ? e.message : 'Upload failed';
        setStaged((arr) =>
          arr.map((s) =>
            s.tempId === entry.tempId ? { ...s, status: 'failed', error: msg } : s,
          ),
        );
        toast.error(`Couldn't upload "${entry.title || entry.file.name}": ${msg}`);
        // Continue on to the next file — partial success is better than
        // an aborted batch.
      }
    }
    setUploadCursor(null);
    return allOk;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const t = title.trim();
    if (!t) {
      toast.error('Give the procedure a title.');
      return;
    }
    setBusy(true);
    const payload = {
      title: t,
      description: description.trim() || null,
      body: body.trim() || null,
      categoryId: categoryId === NULL_VALUE ? null : categoryId,
      authoringWarehouseId:
        authoringWarehouseId === NULL_VALUE ? null : authoringWarehouseId,
    };
    try {
      if (isEdit && defaults?.id) {
        // Pass the loaded updated_at as ifMatch for optimistic-concurrency
        // protection. If another manager saved in the meantime, the
        // service returns a `conflict` error and the toast below tells
        // the user to refresh.
        const res = await updateProcedureAction(defaults.id, {
          ...payload,
          ...(defaults?.updatedAt ? { ifMatch: defaults.updatedAt } : {}),
        });
        if (!res.ok) {
          toast.error(res.error.message);
          return;
        }
        toast.success('Procedure saved.');
        router.push(`/dashboard/procedures/${defaults.id}`);
        router.refresh();
        return;
      }

      const res = await createProcedureAction(payload);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      const newId = res.data.id;

      if (staged.length === 0) {
        toast.success('Procedure created.');
        router.push(`/dashboard/procedures/${newId}`);
        router.refresh();
        return;
      }

      const allOk = await runStagedUploads(newId);
      if (allOk) {
        toast.success('Procedure created with videos.');
        router.push(`/dashboard/procedures/${newId}`);
        router.refresh();
      } else {
        // Some uploads failed; the surviving rows are already recorded
        // and the failed ones are gone from memory after redirect. The
        // edit page renders a recovery toast off this query param.
        router.push(`/dashboard/procedures/${newId}/edit?upload_recovery=1`);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Replace a fluorescent ballast"
          maxLength={200}
          required
          disabled={uploadCursor !== null}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Short description</Label>
        <Input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One sentence summary"
          maxLength={2000}
          disabled={uploadCursor !== null}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="category">Category</Label>
          <Select
            value={categoryId}
            onValueChange={setCategoryId}
            disabled={uploadCursor !== null}
          >
            <SelectTrigger id="category">
              <SelectValue placeholder="No category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NULL_VALUE}>No category</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="warehouse">Authoring warehouse</Label>
          <Select
            value={authoringWarehouseId}
            onValueChange={setAuthoringWarehouseId}
            disabled={uploadCursor !== null}
          >
            <SelectTrigger id="warehouse">
              <SelectValue placeholder="No warehouse" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NULL_VALUE}>No warehouse</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="body">Instructions (Markdown)</Label>
        <Textarea
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          placeholder={
            '## Tools needed\n- ladder\n- screwdriver\n\n## Steps\n1. Turn off the breaker.\n2. ...'
          }
          className="font-mono text-sm"
          maxLength={50_000}
          disabled={uploadCursor !== null}
        />
        <p className="text-xs text-muted-foreground">
          Supports standard Markdown — headings, lists, tables, task lists, and
          fenced code blocks. Raw HTML is not rendered.
        </p>
      </div>

      {isEdit && defaults?.id ? (
        <div className="space-y-2">
          <Label>Videos</Label>
          <VideoUploader
            mode="immediate"
            procedureId={defaults.id}
            organizationId={organizationId}
            initialVideos={videos}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Label>Videos</Label>
          <p className="text-xs text-muted-foreground">
            Drop videos in below — they upload right after the procedure is
            created.
          </p>
          <VideoUploader
            mode="staged"
            staged={staged}
            onStagedChange={setStaged}
            uploading={uploadCursor !== null}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy} variant="gradient">
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {submitButtonCopy()}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.back()}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
