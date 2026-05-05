'use client';

import { AlertTriangle, Download, Loader2, Printer, QrCode } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface BarcodeDisplayProps {
  itemId: string;
  itemName: string;
  sku: string;
  barcode: string | null;
}

/**
 * Generates a Code 128 barcode or QR code via /api/v1/items/[id]/barcode
 * and renders it inside a Dialog. We *fetch* the image (instead of using
 * a plain <img src=...>) so we can:
 *   - surface the actual server error if the route fails (auth, missing
 *     value, render error) instead of showing a silent broken-image icon
 *   - read the bytes once and use the same blob URL for the visible
 *     <img>, the Download button, and the Print window — no double
 *     fetch and no caching surprises
 */
export function BarcodeDisplay({ itemId, itemName, sku, barcode }: BarcodeDisplayProps) {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<'code128' | 'qr'>(barcode ? 'code128' : 'qr');
  const [state, setState] = React.useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; url: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const blobUrlRef = React.useRef<string | null>(null);

  // Per-render cache buster so toggling between Barcode / QR and re-
  // opening the dialog always hits a fresh request (browsers can cache
  // both successful PNGs and earlier error responses).
  const requestUrl = React.useMemo(
    () => `/api/v1/items/${itemId}/barcode?type=${type}&_v=${Date.now().toString(36)}`,
    [itemId, type],
  );

  // Fetch + decode whenever the dialog is open and the type changes.
  // Cleans up the blob URL so we don't leak.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await fetch(requestUrl, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          setState({
            status: 'error',
            message: `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
          });
          return;
        }
        const ct = res.headers.get('content-type') ?? '';
        if (!ct.startsWith('image/')) {
          const body = await res.text().catch(() => '');
          setState({
            status: 'error',
            message: `Server returned ${ct || 'unknown content type'}${body ? ` — ${body.slice(0, 200)}` : ''}`,
          });
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setState({ status: 'ready', url });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: 'error',
          message: e instanceof Error ? e.message : 'Network error',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, requestUrl]);

  // Final cleanup on unmount.
  React.useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  function printIt() {
    if (state.status !== 'ready') return;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title></title>
<style>body{font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:32px;margin:0;}
img{max-width:100%;height:auto;}
h2{font-size:14px;margin:16px 0 4px;font-weight:600;}
p{font-size:12px;color:#52525b;margin:0;}</style>
</head><body>
<img id="bc" alt="" />
<h2 id="t"></h2>
<p id="s"></p>
<script>
(function(){
  var p=new URLSearchParams(location.hash.slice(1));
  document.getElementById('bc').src=p.get('src')||'';
  document.getElementById('t').textContent=p.get('t')||'';
  document.getElementById('s').textContent=p.get('s')||'';
  document.title=p.get('t')||'Label';
  window.addEventListener('load',function(){setTimeout(function(){window.print();},250);});
})();
</script>
</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const params = new URLSearchParams({ src: state.url, t: itemName, s: sku }).toString();
    window.open(`${url}#${params}`, '_blank', 'width=420,height=600');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <QrCode className="h-4 w-4" /> Label
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Print label</DialogTitle>
          <DialogDescription>Generate a barcode or QR code label for this item.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="inline-flex items-center rounded-full border bg-muted/40 p-1 text-sm">
            {(['code128', 'qr'] as const).map((opt) => (
              <button
                type="button"
                key={opt}
                onClick={() => setType(opt)}
                className={
                  'rounded-full px-4 py-1.5 transition-colors ' +
                  (type === opt
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                {opt === 'code128' ? 'Barcode' : 'QR code'}
              </button>
            ))}
          </div>
          <div className="relative grid min-h-[180px] place-items-center rounded-lg border bg-white p-6">
            {state.status === 'loading' && (
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            )}
            {state.status === 'ready' && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={state.url} alt="barcode" className="max-h-48" />
            )}
            {state.status === 'error' && (
              <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
                <AlertTriangle className="text-destructive h-5 w-5" />
                <p className="text-destructive text-xs font-medium">
                  Couldn't generate the label
                </p>
                <p className="text-muted-foreground break-all text-[11px]">
                  {state.message}
                </p>
                <p className="text-muted-foreground text-[10.5px]">
                  Try Reload — if the prompt to update appeared after a deploy,
                  pick it up and try again.
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              asChild
              disabled={state.status !== 'ready'}
              aria-disabled={state.status !== 'ready'}
            >
              <a
                href={state.status === 'ready' ? state.url : '#'}
                download={`${sku}-${type}.png`}
                onClick={(e) => {
                  if (state.status !== 'ready') e.preventDefault();
                }}
              >
                <Download className="h-4 w-4" /> Download
              </a>
            </Button>
            <Button
              variant="gradient"
              onClick={printIt}
              disabled={state.status !== 'ready'}
            >
              <Printer className="h-4 w-4" /> Print
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
