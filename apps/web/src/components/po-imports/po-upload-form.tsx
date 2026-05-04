'use client';

import { Loader2, Upload as UploadIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  parsePoImportAction,
  presignPoUploadAction,
  recordPoUploadAction,
} from '@/server/actions/po-imports';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = ['application/pdf', 'text/csv'];

export function PoUploadForm() {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      toast.error('Pick a PDF or CSV first');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('File is too large (25 MB max)');
      return;
    }
    if (!ACCEPT.includes(file.type)) {
      toast.error('Only PDF or CSV is supported');
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
        toast.error('Upload failed');
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
        fileName: file.name,
        fileMimeType: file.type,
        fileSize: file.size,
        sha256,
        sourceType,
      });
      if (!recorded.ok) {
        toast.error(recorded.error.message);
        return;
      }
      if (recorded.data.duplicateOf) {
        toast.message('Duplicate file — opening existing import.');
        router.push(`/dashboard/purchase-orders/imports/${recorded.data.duplicateOf}`);
        return;
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
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <p className="text-[11px] text-muted-foreground">
          Max 25 MB. Inventory will not be updated by this upload — receiving
          posts the actual stock change in a separate step.
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
