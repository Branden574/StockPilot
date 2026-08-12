'use client';

import { Camera, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Mirrors the route's ACCEPT_TYPES / PO_IMPORT_SCAN_MIME_TYPES. `image/heif`
// is here for the same reason it is there: it and `image/heic` are the same
// iPhone picture under two labels, and which one arrives is the browser's
// choice — a picker offering only one silently greys out half of them.
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';
const MAX_FILES = 5;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Phone-or-laptop entry point for the new scan flow. Drag-drop or
 * pick a photo/PDF, hit "Extract", lands on the existing review UI
 * with extraction confidence highlights.
 */
export function PoScanForm() {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [files, setFiles] = React.useState<File[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  // When 2+ files are attached: true = each file is its OWN PO import (default);
  // false = combine them as pages of ONE PO. Ignored for a single file.
  const [separate, setSeparate] = React.useState(true);
  // Optimistic extraction progress. The scan is one request (upload + Gemini
  // vision, ~6-10s) with no server-streamed progress, so we ease a bar to ~92%
  // over ~13s on elapsed time, hold there until the response lands, then snap to
  // 100%, cycling stage labels so the user sees roughly where it is.
  const [pct, setPct] = React.useState(0);
  const [stage, setStage] = React.useState('');
  const progressTimer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  React.useEffect(
    () => () => {
      if (progressTimer.current) clearInterval(progressTimer.current);
    },
    [],
  );

  function add(picked: FileList | File[]) {
    const incoming = Array.from(picked);
    const next: File[] = [...files];
    for (const f of incoming) {
      if (next.length >= MAX_FILES) {
        toast.error(`Limit is ${MAX_FILES} files per scan. Remove some and try again.`);
        break;
      }
      if (f.size > MAX_BYTES) {
        toast.error(`"${f.name}" is over 8 MB. Pick a smaller file.`);
        continue;
      }
      next.push(f);
    }
    setFiles(next);
  }

  function remove(i: number) {
    setFiles((cur) => cur.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (files.length === 0) {
      toast.error('Pick at least one photo or PDF to scan.');
      return;
    }
    setBusy(true);

    // Drive the optimistic progress bar + rotating stage labels off elapsed time.
    const STAGES = [
      'Uploading…',
      'Reading the document…',
      'Extracting vendor & line items…',
      'Finishing up…',
    ];
    setPct(0);
    setStage(STAGES[0]!);
    const start = Date.now();
    progressTimer.current = setInterval(() => {
      const elapsed = Date.now() - start;
      const t = Math.min(1, elapsed / 13000);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quad
      setPct(Math.round(eased * 92));
      setStage(STAGES[Math.min(STAGES.length - 1, Math.floor(elapsed / 3200))]!);
    }, 120);

    const stopProgress = () => {
      if (progressTimer.current) {
        clearInterval(progressTimer.current);
        progressTimer.current = null;
      }
    };

    try {
      const fd = new FormData();
      for (const f of files) fd.append('file', f);
      // Only meaningful for 2+ files; the server ignores it otherwise.
      fd.append('mode', files.length > 1 && separate ? 'separate' : 'combined');
      const res = await fetch('/api/po-imports/scan', {
        method: 'POST',
        body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        toast.error(json.message || `Couldn't scan the upload (${res.status}). Try again or use a clearer photo.`);
        return;
      }
      stopProgress();
      setPct(100);

      // Separate mode: N imports created — land on the Active list to review
      // each one-by-one (there's no single detail to open).
      if (json.mode === 'separate' && Array.isArray(json.imports)) {
        const made = json.imports.length as number;
        const failed = Array.isArray(json.failed) ? json.failed.length : 0;
        toast.success(
          `${made} import${made === 1 ? '' : 's'} created${failed > 0 ? ` · ${failed} file${failed === 1 ? '' : 's'} couldn't be read` : ''}. Review and approve each below.`,
        );
        router.push('/dashboard/purchase-orders/imports?status=active');
        return;
      }

      if (json.duplicateOf) {
        toast.success('Already scanned earlier. Opening the existing import.');
      } else if (json.lowConfidenceLines > 0) {
        toast.success(
          `Scan extracted. ${json.lowConfidenceLines} line${json.lowConfidenceLines === 1 ? '' : 's'} need a quick review.`,
        );
      } else {
        toast.success('Scan extracted cleanly. Ready to approve.');
      }
      router.push(`/dashboard/purchase-orders/imports/${json.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't reach the scan service. Check your network and try again.");
    } finally {
      stopProgress();
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) add(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'border-border bg-muted/30 hover:bg-muted/40 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragOver && 'border-foreground/60 bg-muted/60',
        )}
      >
        <Camera className="text-muted-foreground h-6 w-6" />
        <p className="text-sm font-medium">
          Drop a photo or PDF of your PO
        </p>
        <p className="text-muted-foreground text-xs">
          Up to {MAX_FILES} files · 8 MB each · JPEG, PNG, WEBP, HEIC, or PDF
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="border-border bg-card flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <Upload className="text-muted-foreground h-3.5 w-3.5" />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-muted-foreground text-[11px] tabular-nums">
                {(f.size / 1024).toFixed(0)} KB
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-muted-foreground hover:text-destructive p-1"
                aria-label={`Remove ${f.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {files.length > 1 && !busy && (
        <div className="border-border bg-muted/30 space-y-2 rounded-lg border p-3">
          <p className="text-xs font-medium">
            You attached {files.length} files — are these…
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setSeparate(true)}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-xs transition-colors',
                separate
                  ? 'border-foreground/60 bg-card'
                  : 'border-border hover:bg-muted/40',
              )}
            >
              <span className="block font-medium">Separate POs</span>
              <span className="text-muted-foreground">
                Each file becomes its own import to review &amp; approve
              </span>
            </button>
            <button
              type="button"
              onClick={() => setSeparate(false)}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-xs transition-colors',
                !separate
                  ? 'border-foreground/60 bg-card'
                  : 'border-border hover:bg-muted/40',
              )}
            >
              <span className="block font-medium">One multi-page PO</span>
              <span className="text-muted-foreground">
                Combine all files as pages of a single PO
              </span>
            </button>
          </div>
        </div>
      )}

      {busy ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin" />
            {stage || 'Working…'}
          </div>
          <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
            <div
              className="bg-foreground h-full rounded-full transition-[width] duration-200 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Extracting with AI — this usually takes a few seconds. Keep this tab open.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={submit} disabled={files.length === 0} variant="gradient">
            <Sparkles className="h-4 w-4" /> Extract with AI
          </Button>
          {files.length > 0 && (
            <Button variant="outline" onClick={() => setFiles([])}>
              Clear
            </Button>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Scanned POs run through AI vision extraction. Your data stays in
        your Supabase project; the scan endpoint only sends the image bytes
        for extraction. After review, the existing approve flow learns
        vendor-SKU mappings so repeat POs from the same supplier need almost
        no edits.
      </p>
    </div>
  );
}
