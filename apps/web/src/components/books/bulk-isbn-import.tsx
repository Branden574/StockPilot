'use client';

import {
  CheckCircle2,
  FileUp,
  Loader2,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
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
import { resolveListReturnHref } from '@/lib/last-list-url';
import { cn } from '@/lib/utils';
import { bulkCreateBooksAction } from '@/server/actions/books-bulk-import';

interface Resolved {
  isbn: string;
  status: 'pending' | 'looking_up' | 'ready' | 'failed';
  title: string | null;
  author: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  publisher: string | null;
  publishedDate: string | null;
  pageCount: number | null;
  grade: string | null;
  quantity: number;
  error: string | null;
}

interface BulkIsbnImportProps {
  warehouses: Array<{ id: string; name: string }>;
  charters: Array<{ id: string; name: string }>;
  warehouseCharters: Array<{ warehouse_id: string; charter_id: string }>;
  forcedWarehouseId: string | null;
  warehouseLabel: string;
  charterLabel: string;
}

const LOOKUP_CONCURRENCY = 4;

export function BulkIsbnImport({
  warehouses,
  charters,
  warehouseCharters,
  forcedWarehouseId,
  warehouseLabel,
  charterLabel,
}: BulkIsbnImportProps) {
  const router = useRouter();
  const [raw, setRaw] = React.useState('');
  const [warehouseId, setWarehouseId] = React.useState<string>(
    forcedWarehouseId ?? warehouses[0]?.id ?? '',
  );
  const [charterId, setCharterId] = React.useState<string>('__generic__');
  const [defaultQty, setDefaultQty] = React.useState('1');
  const [resolved, setResolved] = React.useState<Resolved[]>([]);
  const [scanning, setScanning] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [extracting, setExtracting] = React.useState(false);
  const [aiExtracting, setAiExtracting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const aiFileInputRef = React.useRef<HTMLInputElement | null>(null);

  async function handleFileUpload(file: File, mode: 'regex' | 'ai') {
    const setBusy = mode === 'ai' ? setAiExtracting : setExtracting;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const endpoint =
        mode === 'ai' ? '/api/books/extract-isbns-ai' : '/api/books/extract-isbns';
      const res = await fetch(endpoint, { method: 'POST', body: fd });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        isbns?: string[];
        totalFound?: number;
        kind?: string;
        notes?: string;
        message?: string;
      };
      if (!res.ok || !json.ok) {
        toast.error(json.message ?? `Couldn't parse "${file.name}" (${res.status}). Try a different file.`);
        return;
      }
      const found = json.isbns ?? [];
      if (found.length === 0) {
        toast.warning(`No ISBNs found in "${file.name}".`);
        return;
      }
      // Append to whatever the user already has, then dedupe at parse
      // time when they click Look up. Newline-separated so it's easy
      // for them to eyeball. Stack regex + AI passes — the parser
      // dedupes on the way to lookup.
      setRaw((prev) => {
        const trimmed = prev.trim();
        const sep = trimmed.length > 0 ? '\n' : '';
        return `${trimmed}${sep}${found.join('\n')}`;
      });
      const label = mode === 'ai' ? 'AI extracted' : 'Extracted';
      toast.success(
        `${label} ${found.length} ISBN${found.length === 1 ? '' : 's'} from "${file.name}".`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload the file. Check your network and try again.");
    } finally {
      setBusy(false);
      // Reset the input so the same file can be uploaded again if needed.
      if (mode === 'ai') {
        if (aiFileInputRef.current) aiFileInputRef.current.value = '';
      } else if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const allowedCharterIds = React.useMemo(() => {
    const set = new Set<string>();
    for (const p of warehouseCharters) {
      if (p.warehouse_id === warehouseId) set.add(p.charter_id);
    }
    return set;
  }, [warehouseCharters, warehouseId]);

  const charterOptions = React.useMemo(
    () => charters.filter((c) => allowedCharterIds.has(c.id)),
    [charters, allowedCharterIds],
  );

  function parseIsbns(): string[] {
    const lines = raw
      .split(/[\s,;\n\r]+/)
      .map((s) => s.replace(/[^0-9Xx]/g, '').toUpperCase())
      .filter((s) => s.length === 10 || s.length === 13);
    // Dedupe, preserve order.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of lines) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  async function lookupOne(isbn: string): Promise<Partial<Resolved>> {
    try {
      const res = await fetch(`/api/books/lookup?isbn=${encodeURIComponent(isbn)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        return { status: 'failed', error: `Lookup failed (${res.status})` };
      }
      const data = await res.json();
      if (!data || !data.title) {
        return { status: 'failed', error: 'No metadata found across sources' };
      }
      return {
        status: 'ready',
        title: data.title ?? null,
        author: Array.isArray(data.authors) ? data.authors.join(', ') : null,
        description: data.description ?? null,
        thumbnailUrl: data.thumbnailUrl ?? null,
        publisher: data.publisher ?? null,
        publishedDate: data.publishedDate ?? null,
        pageCount: data.pageCount ?? null,
        grade: data.grade ?? null,
        error: null,
      };
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  async function runLookups() {
    const isbns = parseIsbns();
    if (isbns.length === 0) {
      toast.error('Paste at least one valid ISBN-10 or ISBN-13 to look up.');
      return;
    }
    if (isbns.length > 200) {
      toast.error('Limit is 200 ISBNs per batch. Split your list into smaller groups.');
      return;
    }
    const qty = Math.max(0, Number.parseInt(defaultQty, 10) || 0);
    setScanning(true);

    const initial: Resolved[] = isbns.map((isbn) => ({
      isbn,
      status: 'pending',
      title: null,
      author: null,
      description: null,
      thumbnailUrl: null,
      publisher: null,
      publishedDate: null,
      pageCount: null,
      grade: null,
      quantity: qty,
      error: null,
    }));
    setResolved(initial);

    // Concurrency-limited fan-out so we don't hammer Google Books with
    // 200 simultaneous requests (gets us throttled).
    let cursor = 0;
    async function worker() {
      while (cursor < isbns.length) {
        const i = cursor++;
        const isbn = isbns[i];
        if (!isbn) continue;
        setResolved((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, status: 'looking_up' as const } : r,
          ),
        );
        const partial = await lookupOne(isbn);
        setResolved((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, ...partial } : r)),
        );
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(LOOKUP_CONCURRENCY, isbns.length) }, worker),
    );
    setScanning(false);
  }

  function updateRow(i: number, patch: Partial<Resolved>) {
    setResolved((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
  }

  function removeRow(i: number) {
    setResolved((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function importAll() {
    const ready = resolved.filter((r) => r.status === 'ready' && r.title);
    if (ready.length === 0) {
      toast.error('Nothing to import yet. Run the lookup first.');
      return;
    }
    if (!warehouseId) {
      toast.error(`Pick a ${warehouseLabel.toLowerCase()} before importing books.`);
      return;
    }
    setSubmitting(true);
    const r = await bulkCreateBooksAction({
      warehouseId,
      charterId: charterId === '__generic__' ? null : charterId,
      books: ready.map((b) => ({
        isbn: b.isbn,
        title: b.title!,
        author: b.author,
        description: b.description,
        thumbnailUrl: b.thumbnailUrl,
        publisher: b.publisher,
        publishedDate: b.publishedDate,
        pageCount: b.pageCount,
        grade: b.grade,
        quantityOnHand: Math.max(0, b.quantity || 0),
        unitCost: 0,
        retailPrice: 0,
      })),
    });
    setSubmitting(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    const { created, skipped, errors } = r.data;
    if (errors.length > 0) {
      toast.error(
        `Created ${created}, skipped ${skipped}, ${errors.length} failed. Open the books page to retry the failures.`,
      );
    } else if (skipped > 0) {
      toast.success(
        `Created ${created} · ${skipped} already existed (matched by ISBN/SKU).`,
      );
      router.push(resolveListReturnHref('/dashboard/books', null));
    } else {
      toast.success(`Created ${created} book${created === 1 ? '' : 's'}.`);
      router.push(resolveListReturnHref('/dashboard/books', null));
    }
  }

  const ready = resolved.filter((r) => r.status === 'ready');
  const failed = resolved.filter((r) => r.status === 'failed');
  const inFlight = resolved.filter(
    (r) => r.status === 'pending' || r.status === 'looking_up',
  );

  return (
    <div className="space-y-5">
      <div className="border-border bg-card space-y-4 rounded-lg border p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{warehouseLabel}</Label>
            <Select
              value={warehouseId}
              onValueChange={setWarehouseId}
              disabled={!!forcedWarehouseId}
            >
              <SelectTrigger>
                <SelectValue placeholder={`Pick ${warehouseLabel.toLowerCase()}`} />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Default qty per book</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={defaultQty}
              onChange={(e) => setDefaultQty(e.target.value)}
            />
          </div>
        </div>

        {charterOptions.length > 0 && (
          <div className="space-y-1.5">
            <Label>{charterLabel}</Label>
            <Select value={charterId} onValueChange={setCharterId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__generic__">Generic — any charter</SelectItem>
                {charterOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="isbn-list">ISBNs</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp,.heic,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain,image/png,image/jpeg,image/webp,image/heic"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f, 'regex');
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={extracting || aiExtracting}
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.dataset.mode = 'regex';
                    fileInputRef.current.click();
                  }
                }}
                title="Pull ISBNs out of a PDF / Word / Excel / CSV / TXT file using regex (fast, free)."
              >
                {extracting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileUp className="h-3.5 w-3.5" />
                )}
                Extract from file
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={extracting || aiExtracting}
                onClick={() => {
                  if (aiFileInputRef.current) aiFileInputRef.current.click();
                }}
                title="Use Gemini to find ISBNs and book references that the regex misses (slower, uses tokens)."
              >
                {aiExtracting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Extract with AI
              </Button>
              <input
                ref={aiFileInputRef}
                type="file"
                accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp,.heic,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain,image/png,image/jpeg,image/webp,image/heic"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f, 'ai');
                }}
              />
            </div>
          </div>
          <Textarea
            id="isbn-list"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={6}
            placeholder="One ISBN per line, or comma-separated. ISBN-10 and ISBN-13 both work, with or without dashes. You can also upload a PDF, Word doc, Excel sheet, CSV, or TXT — extract pulls the ISBNs out for you."
            className="font-mono text-[12.5px]"
          />
          <p className="text-muted-foreground text-[11px]">
            Up to 200 per batch. The system runs Google Books, Open Library,
            Open Library Search, and the Library of Congress in parallel for
            each ISBN. When all four come up empty (often the case for
            HMH / Pearson / McGraw-Hill academic ISBNs), Gemini is used as
            a fallback — only the entries it identifies with high or
            medium confidence are kept.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={runLookups}
            disabled={scanning || submitting}
            variant="gradient"
          >
            {scanning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Look up
          </Button>
          {resolved.length > 0 && (
            <Button
              onClick={importAll}
              disabled={submitting || ready.length === 0}
              variant="outline"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Import {ready.length} book{ready.length === 1 ? '' : 's'}
            </Button>
          )}
          {resolved.length > 0 && (
            <span className="text-muted-foreground ml-auto text-[11.5px]">
              {ready.length} ready · {failed.length} failed
              {inFlight.length > 0 && ` · ${inFlight.length} pending`}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar — only shown while lookups are running. Once the
          batch finishes (every row resolved or failed) the bar
          disappears and the row list below carries the final status.
          Bar position transitions smoothly so partial-batch progress
          feels alive instead of jumpy. */}
      {resolved.length > 0 && inFlight.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              Looking up books… {resolved.length - inFlight.length} of{' '}
              {resolved.length}
            </span>
            <span className="tabular-nums">
              {Math.round(
                ((resolved.length - inFlight.length) / resolved.length) * 100,
              )}
              %
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground/80 transition-[width] duration-300 ease-out"
              style={{
                width: `${
                  ((resolved.length - inFlight.length) / resolved.length) * 100
                }%`,
              }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={resolved.length}
              aria-valuenow={resolved.length - inFlight.length}
              aria-label="Bulk ISBN lookup progress"
            />
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <ul className="space-y-2">
          {resolved.map((r, i) => (
            <li
              key={r.isbn + i}
              className={cn(
                'border-border bg-card flex items-start gap-3 rounded-lg border p-3',
                r.status === 'failed' && 'border-destructive/30',
              )}
            >
              <div className="grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted">
                {r.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-muted-foreground font-mono text-[10.5px]">
                    {r.isbn}
                  </span>
                  {r.status === 'looking_up' && (
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-[10.5px]">
                      <Loader2 className="h-3 w-3 animate-spin" /> looking up
                    </span>
                  )}
                  {r.status === 'pending' && (
                    <span className="text-muted-foreground text-[10.5px]">queued</span>
                  )}
                  {r.status === 'ready' && (
                    <span className="text-success inline-flex items-center gap-1 text-[10.5px]">
                      <CheckCircle2 className="h-3 w-3" /> ready
                    </span>
                  )}
                  {r.status === 'failed' && (
                    <span className="text-destructive inline-flex items-center gap-1 text-[10.5px]">
                      <XCircle className="h-3 w-3" /> {r.error ?? 'failed'}
                    </span>
                  )}
                </div>
                {r.status === 'ready' && (
                  <>
                    <Input
                      value={r.title ?? ''}
                      onChange={(e) => updateRow(i, { title: e.target.value })}
                      placeholder="Title"
                      className="h-8 text-sm"
                    />
                    <div className="grid gap-2 sm:grid-cols-[1fr_120px_120px]">
                      <Input
                        value={r.author ?? ''}
                        onChange={(e) => updateRow(i, { author: e.target.value })}
                        placeholder="Author"
                        className="h-8 text-xs"
                      />
                      <Input
                        value={r.grade ?? ''}
                        onChange={(e) => updateRow(i, { grade: e.target.value })}
                        placeholder="Grade"
                        className="h-8 text-xs"
                      />
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={r.quantity}
                        onChange={(e) =>
                          updateRow(i, {
                            quantity: Math.max(
                              0,
                              Number.parseInt(e.target.value, 10) || 0,
                            ),
                          })
                        }
                        placeholder="Qty"
                        className="h-8 text-xs"
                      />
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="text-muted-foreground hover:text-destructive shrink-0 p-1"
                aria-label={`Remove ${r.isbn}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
