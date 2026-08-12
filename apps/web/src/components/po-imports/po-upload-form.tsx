'use client';

import { Loader2, Upload as UploadIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { prettifyFileNameForDisplay } from '@/lib/po-imports/display-name';
import {
  parsePoImportAction,
  presignPoUploadAction,
  recordPoUploadAction,
} from '@/server/actions/po-imports';

import { PO_IMPORT_DISPLAY_NAME_MAX } from '@stockpilot/core';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = ['application/pdf', 'text/csv'];

export function PoUploadForm() {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  // The human name for this import. PREFILLED from the picked file's name so
  // the common case is one keystroke-free step, and fully editable — the
  // uploaded file itself is never renamed (file_name keeps the real filename).
  const [displayName, setDisplayName] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  function pickFile(next: File | null) {
    setFile(next);
    setDisplayName(next ? prettifyFileNameForDisplay(next.name) : '');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      toast.error('Pick a PDF or CSV file to upload.');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('File is over the 25 MB limit. Pick a smaller file.');
      return;
    }
    if (!ACCEPT.includes(file.type)) {
      toast.error('Only PDF or CSV uploads are supported.');
      return;
    }
    setSubmitting(true);
    try {
      const presign = await presignPoUploadAction({
        fileName: file.name,
        fileMimeType: file.type,
        fileSize: file.size,
      });
      if (!presign.ok) {
        toast.error(presign.error.message);
        return;
      }

      // PUT the file directly to Supabase Storage
      const put = await fetch(presign.data.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
        body: file,
      });
      if (!put.ok) {
        toast.error("Couldn't upload the file. Check your network and try again.");
        return;
      }

      // Compute checksum
      const ab = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', ab);
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const sourceType: 'pdf' | 'csv' = file.type === 'application/pdf' ? 'pdf' : 'csv';
      const recorded = await recordPoUploadAction({
        storagePath: presign.data.storagePath,
        // The REAL uploaded filename, unchanged — this is what the detail page
        // shows as "Source file" and what troubleshooting needs.
        fileName: file.name,
        fileMimeType: file.type,
        fileSize: file.size,
        sha256,
        sourceType,
        // Separate field, separate column. Blank means "no name" (null).
        displayName,
      });
      if (!recorded.ok) {
        toast.error(recorded.error.message);
        return;
      }
      if (recorded.data.duplicateOf) {
        // Still a genuine duplicate: the file's previous import is either
        // in-flight or produced a PO that is still live.
        toast.message('This file is already imported — opening that import.');
        router.push(`/dashboard/purchase-orders/imports/${recorded.data.duplicateOf}`);
        return;
      }
      if (recorded.data.reimportOfCancelled) {
        // The previous import's PO was CANCELLED, so this is a legitimate redo
        // (e.g. the original was approved against the wrong charter). The
        // cancelled PO and its import are preserved; this is a new import
        // linked back to them.
        const po = recorded.data.reimportOfCancelled.cancelledPoNumber;
        toast.success(
          po
            ? `Re-importing — the previous ${po} was cancelled. That record is kept for history.`
            : 'Re-importing — the previous purchase order was cancelled. That record is kept for history.',
        );
      }

      const parsed = await parsePoImportAction(recorded.data.id);
      if (!parsed.ok) {
        toast.error(parsed.error.message);
      }
      router.push(`/dashboard/purchase-orders/imports/${recorded.data.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="po-file">PO file (PDF or CSV)</Label>
        <Input
          id="po-file"
          type="file"
          accept={ACCEPT.join(',')}
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
        <p className="text-xs text-muted-foreground">
          Max 25 MB. Inventory will not be updated by this upload — receiving
          posts the actual stock change in a separate step.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="po-display-name">PO name</Label>
        <Input
          id="po-display-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={PO_IMPORT_DISPLAY_NAME_MAX}
          placeholder="Example: August DC4 Book Order"
        />
        <p className="text-xs text-muted-foreground">
          Give this import a name so it is easy to find later. Prefilled from the
          file name — edit it freely; the uploaded file keeps its own name.
        </p>
      </div>
      <Button type="submit" disabled={!file || submitting} variant="gradient">
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <UploadIcon className="h-4 w-4" />
        )}
        Upload &amp; parse
      </Button>
    </form>
  );
}
