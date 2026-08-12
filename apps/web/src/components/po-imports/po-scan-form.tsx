'use client';

import { Camera, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { PO_IMPORT_DISPLAY_NAME_MAX } from '@stockpilot/core';

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
  /**
   * The human name for each attached file, INDEX-ALIGNED with `files` — the
   * same alignment the API's `displayNames` JSON array is defined by, so the
   * form and the wire contract cannot drift.
   *
   * Deliberately NOT prefilled from the filename (unlike the CSV/PDF upload
   * form): a phone capture is called `image.jpg` or `IMG_4471.HEIC`, and
   * prefilling that would hand the user back the exact noise this field exists
   * to replace.
   */
  const [names, setNames] = React.useState<string[]>([]);
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
    // Keep `names` exactly as long as `files`, preserving what was already
    // typed. Any drift here becomes an off-by-one on the wire (file 2 named
    // with file 1's name), which is the failure this alignment exists to avoid.
    setNames((cur) => next.map((_, idx) => cur[idx] ?? ''));
  }

  function remove(i: number) {
    setFiles((cur) => cur.filter((_, idx) => idx !== i));
    setNames((cur) => cur.filter((_, idx) => idx !== i));
  }

  function setName(i: number, value: string) {
    setNames((cur) => {
      const next = [...cur];
      next[i] = value;
      return next;
    });
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
      const mode = files.length > 1 && separate ? 'separate' : 'combined';
      fd.append('mode', mode);
      // `displayNames` — ONE JSON array entry per IMPORT, in file order. See
      // the contract in app/api/po-imports/scan/route.ts for why this is a JSON
      // array and not repeated form fields: "this file has no name" has to
      // survive the wire as a real value, and an empty multipart part does not
      // reliably do that. An unnamed slot is `null`, never a dropped entry.
      const toEntry = (v: string | undefined) => {
        const trimmed = (v ?? '').trim();
        return trimmed === '' ? null : trimmed;
      };
      fd.append(
        'displayNames',
        JSON.stringify(
          mode === 'separate'
            ? files.map((_, i) => toEntry(names[i]))
            : [toEntry(names[0])],
        ),
      );
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

  // 2+ files each becoming their OWN import means each needs its OWN name, so
  // the single field above the dropzone gives way to one input per file row.
  const perFileNames = files.length > 1 && separate;

  return (
    <div className="space-y-4">
      {!perFileNames && (
        <div className="space-y-1.5">
          <Label htmlFor="scan-display-name">PO name</Label>
          <Input
            id="scan-display-name"
            value={names[0] ?? ''}
            onChange={(e) => setName(0, e.target.value)}
            maxLength={PO_IMPORT_DISPLAY_NAME_MAX}
            placeholder="Example: August DC4 Book Order"
            disabled={busy}
          />
          <p className="text-muted-foreground text-xs">
            Give this import a name so it is easy to find later. Optional — without
            one, the import is listed by its file name.
          </p>
        </div>
      )}

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
        onClick={(e) => {
          // The file input lives INSIDE this div, so a click on it bubbles back
          // here and re-clicks it — an infinite loop (RangeError: maximum call
          // stack). Users never hit it in a browser because the input is
          // hidden, but anything that clicks it directly does. Ignore clicks
          // that came from the input itself.
          if (e.target === inputRef.current) return;
          inputRef.current?.click();
        }}
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
          data-testid="po-scan-file-input"
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
              className="border-border bg-card space-y-2 rounded-md border px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-3">
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
              </div>
              {perFileNames && (
                <div className="space-y-1">
                  <Label htmlFor={`scan-display-name-${i}`} className="text-xs">
                    PO name
                  </Label>
                  <Input
                    id={`scan-display-name-${i}`}
                    // The visible label reads "PO name" on every row; the
                    // accessible name says WHICH file, so screen readers (and
                    // the alignment tests) can tell row 2 from row 3.
                    aria-label={`PO name for ${f.name}`}
                    value={names[i] ?? ''}
                    onChange={(e) => setName(i, e.target.value)}
                    maxLength={PO_IMPORT_DISPLAY_NAME_MAX}
                    placeholder="Example: August DC4 Book Order"
                    disabled={busy}
                    className="h-8 text-sm"
                  />
                </div>
              )}
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
                Each file becomes its own import to review &amp; approve — name
                them individually above
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
            <Button
              variant="outline"
              onClick={() => {
                setFiles([]);
                setNames([]);
              }}
            >
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
