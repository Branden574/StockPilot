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
import { isControlFlow } from '@/lib/control-flow';
import {
  beginRun,
  finishRun,
  leaveRunUnfinished,
  recordRun,
  takeInterruptedRun,
  type RunHandle,
} from '@/lib/interrupted-run';
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

/**
 * The record a create-mode video batch keeps in this tab (lib/interrupted-run)
 * so that a page load partway through still leads to the procedure it saved.
 */
const VIDEO_BATCH_RUN = 'procedure-video-batch';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseVideoBatchRun(payload: unknown): { procedureId: string } | null {
  const id = (payload as { procedureId?: unknown } | null)?.procedureId;
  return typeof id === 'string' && UUID_RE.test(id) ? { procedureId: id } : null;
}

/** The edit page, where UploadRecoveryToast says to re-drop the missing videos. */
function uploadRecoveryHref(procedureId: string): string {
  return `/dashboard/procedures/${procedureId}/edit?upload_recovery=1`;
}

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
  /** The signed-in user. With organizationId, the account a create-mode video
   *  batch's record in this tab belongs to (see VIDEO_BATCH_RUN). */
  userId: string;
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
 *
 * A create-mode batch that a page load cuts short (the session ended and the
 * next action was answered with a redirect to sign-in, or the page was
 * reloaded) leaves a record in this tab. The procedure already exists then, so
 * when this form opens again for the same account it goes on to that
 * procedure's edit page, where the recovery notice says to re-drop the missing
 * videos, instead of offering an empty form that would make a second one.
 */
export function ProcedureForm({
  mode,
  categories,
  warehouses,
  userId,
  organizationId,
  defaults,
  videos = [],
}: ProcedureFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';
  const [title, setTitle] = React.useState(defaults?.title ?? '');
  const [description, setDescription] = React.useState(defaults?.description ?? '');
  const [body, setBody] = React.useState(defaults?.body ?? '');
  const [categoryId, setCategoryId] = React.useState<string>(defaults?.categoryId ?? NULL_VALUE);
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

  // Create mode, once as the form opens: a batch this tab started and a page
  // load cut short left its procedure's id (see VIDEO_BATCH_RUN). Go on to
  // that procedure. Only on opening: a batch cut short here, while this page
  // is on its way to sign-in, is not taken back by its own form.
  const lookedForCutShort = React.useRef(false);
  React.useEffect(() => {
    if (isEdit || lookedForCutShort.current) return;
    lookedForCutShort.current = true;
    const cutShort = takeInterruptedRun(
      VIDEO_BATCH_RUN,
      { userId, organizationId },
      parseVideoBatchRun,
    );
    if (cutShort) router.replace(uploadRecoveryHref(cutShort.procedureId));
  }, [isEdit, userId, organizationId, router]);

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
  async function runStagedUploads(procedureId: string, run: RunHandle): Promise<boolean> {
    const supabase = createClient();
    let allOk = true;
    // Before each Server Action: the batch is still going, for this procedure.
    // A redirect answering that action ends the page, and this record with
    // its procedure id is what is left (see VIDEO_BATCH_RUN).
    const recordBatch = () => recordRun(run, { procedureId });
    // Snapshot the array now — the indices we use for orderIdx must be
    // stable across the loop even as we update per-item status.
    const snapshot = staged;
    // Byte-weighted across the whole batch, denominator fixed up front —
    // see BatchProgress for why a moving denominator would let the
    // percentage travel backwards. Uploads are sequential, but a failed
    // file settles as FAILED and keeps only the fraction it truly reached,
    // so the batch can never read 100% when an upload died.
    const batch = new BatchProgress(snapshot.map((s) => ({ key: s.tempId, weight: s.sizeBytes })));
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
          extensionFromMime(entry.mimeType) || (entry.file.name.split('.').pop() ?? 'mp4');

        // Server mints the storage path + presigned PUT URLs from its own
        // org id; recordProcedureVideoAction re-validates the same shape.
        recordBatch();
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

        // The upload can take many minutes; this step's record is fresh.
        recordBatch();
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
        // A redirect (the session ended) stops the batch: the router is
        // already navigating, so no file is marked failed. onSubmit keeps
        // the way back to the procedure.
        if (isControlFlow(e)) throw e;
        allOk = false;
        const msg = e instanceof Error ? e.message : 'Upload failed';
        setStaged((arr) =>
          arr.map((s) => (s.tempId === entry.tempId ? { ...s, status: 'failed', error: msg } : s)),
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
    // Create mode with videos staged: the batch (see VIDEO_BATCH_RUN), which
    // ends below. Every way out of this handler that does not end it on the
    // page stops it in the finally, where what it recorded stays.
    let run: RunHandle | null = null;
    const payload = {
      title: t,
      description: description.trim() || null,
      body: body.trim() || null,
      categoryId: categoryId === NULL_VALUE ? null : categoryId,
      authoringWarehouseId: authoringWarehouseId === NULL_VALUE ? null : authoringWarehouseId,
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

      // The batch is going on in this page from here, before the procedure is
      // saved: a sign-out, or the shell coming to render for another account,
      // while the save is on its way stops it from keeping any record
      // (lib/interrupted-run).
      if (staged.length > 0) run = beginRun(VIDEO_BATCH_RUN, { userId, organizationId });
      let res: Awaited<ReturnType<typeof createProcedureAction>>;
      try {
        res = await createProcedureAction(payload);
      } catch (e) {
        // A redirect (the session ended before the procedure was saved): the
        // router is already on its way to sign-in, nothing was saved, and
        // nothing is shown. Anything else is thrown on as before.
        if (isControlFlow(e)) return;
        throw e;
      }
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      const newId = res.data.id;

      if (!run) {
        toast.success('Procedure created.');
        router.push(`/dashboard/procedures/${newId}`);
        router.refresh();
        return;
      }

      let allOk: boolean;
      try {
        allOk = await runStagedUploads(newId, run);
      } catch (e) {
        // The batch stopped before it ended on this page, and the procedure
        // exists: its record stays (the finally below), so this form, opened
        // again in this tab, goes on to the procedure. A redirect (the session
        // ended) is already taking the browser to sign-in and is not shown;
        // anything else is thrown on as before.
        setUploadCursor(null);
        if (isControlFlow(e)) return;
        throw e;
      }
      // Ended on this page, which goes to the procedure below.
      finishRun(run);
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
      // Not ended on the page (a redirect, a refused save, anything thrown):
      // the batch stops here, and what it recorded stays for the form opened
      // again in this tab. A no-op once finishRun has ended it.
      if (run) leaveRunUnfinished(run);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
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
          <Select value={categoryId} onValueChange={setCategoryId} disabled={uploadCursor !== null}>
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
          className="font-mono text-[13px] leading-6"
          maxLength={50_000}
          disabled={uploadCursor !== null}
        />
        <p className="text-muted-foreground text-[12px] leading-[18px]">
          Supports standard Markdown — headings, lists, tables, task lists, and fenced code blocks.
          Raw HTML is not rendered.
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
          <p className="text-muted-foreground text-[12px] leading-[18px]">
            Drop videos in below — they upload right after the procedure is created.
          </p>
          <VideoUploader
            mode="staged"
            staged={staged}
            onStagedChange={setStaged}
            uploading={uploadCursor !== null}
          />
        </div>
      )}

      {/* Create is the page's accent primary (making something new); Save
          commits the record in front of you, the ink primary (DESIGN-SPEC
          6.2 hierarchy rule). */}
      <div className="border-border flex flex-wrap items-center gap-2 border-t pt-5">
        <Button type="submit" disabled={busy} variant={isEdit ? 'default' : 'gradient'}>
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {submitButtonCopy()}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
