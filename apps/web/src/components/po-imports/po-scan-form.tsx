'use client';

import { Camera, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,application/pdf';
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

  function add(picked: FileList | File[]) {
    const incoming = Array.from(picked);
    const next: File[] = [...files];
    for (const f of incoming) {
      if (next.length >= MAX_FILES) {
        toast.error(`Limit is ${MAX_FILES} files per scan.`);
        break;
      }
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name} is over 8 MB.`);
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
      toast.error('Pick at least one photo or PDF.');
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('file', f);
      const res = await fetch('/api/po-imports/scan', {
        method: 'POST',
        body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        toast.error(json.message || `Scan failed (${res.status})`);
        return;
      }
      if (json.duplicateOf) {
        toast.success('Already scanned earlier — opening existing import.');
      } else if (json.lowConfidenceLines > 0) {
        toast.success(
          `Extracted. ${json.lowConfidenceLines} line${json.lowConfidenceLines === 1 ? '' : 's'} need a quick review.`,
        );
      } else {
        toast.success('Extracted cleanly — ready to approve.');
      }
      router.push(`/dashboard/purchase-orders/imports/${json.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Network error');
    } finally {
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

      <div className="flex flex-wrap gap-2">
        <Button onClick={submit} disabled={busy || files.length === 0} variant="gradient">
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Extracting…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" /> Extract with AI
            </>
          )}
        </Button>
        {files.length > 0 && !busy && (
          <Button variant="outline" onClick={() => setFiles([])}>
            Clear
          </Button>
        )}
      </div>

      <p className="text-muted-foreground text-[11px]">
        Scanned POs run through Gemini 2.0 Flash (free tier on Google AI
        Studio). Your data stays in your Supabase project; the scan
        endpoint only sends the image bytes for extraction. After review,
        the existing approve flow learns vendor-SKU mappings so repeat
        POs from the same supplier need almost no edits.
      </p>
    </div>
  );
}
