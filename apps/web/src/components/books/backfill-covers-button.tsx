'use client';

import { ImageDown, Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { backfillBookCoversAction } from '@/server/actions/books-backfill-covers';

/**
 * One-tap rehost of book cover URLs into our own Supabase Storage
 * bucket. Books imported before the cover-rehost flow landed have
 * a third-party URL stashed in custom_fields.thumbnail_url but no
 * item_images row — and many of those URLs are unreliable
 * (archive.org ERR_CONNECTION_RESET). This button repairs the
 * existing library in one go.
 *
 * Idempotent: skips books that already have a primary photo, skips
 * books with no thumbnail_url to start with. Safe to re-run.
 */
export function BackfillCoversButton() {
  const [busy, setBusy] = React.useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await backfillBookCoversAction();
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      const { rehosted, alreadyHadPrimary, failed, scanned } = res.data;
      const parts: string[] = [];
      if (rehosted > 0) parts.push(`rehosted ${rehosted}`);
      if (alreadyHadPrimary > 0) parts.push(`${alreadyHadPrimary} already had a photo`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (parts.length === 0) {
        toast.info(`Scanned ${scanned} books — nothing to backfill.`);
      } else {
        toast.success(`Scanned ${scanned}: ${parts.join(' · ')}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Backfill failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={run}
      disabled={busy}
      title="Re-download cover images for books that came in before the cover-rehost flow landed. Skips books that already have a primary photo."
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <ImageDown className="h-3.5 w-3.5" />
      )}
      Backfill covers
    </Button>
  );
}
