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
import { TEMPLATES, type Template } from '@/components/inventory/label-templates';

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
  // Label stock. 'auto' fits whatever the printer's paper is set to (one
  // label); the explicit sizes force @page to the exact stock, which is how
  // you print to a thermal roll (Phomemo M120 etc.) instead of a paper sheet.
  const [size, setSize] = React.useState<Template | 'auto' | 'custom'>('auto');
  // Custom label dimensions in mm — the reliable path for odd thermal rolls
  // where the physical label doesn't match a preset. Entered as printed:
  // width across the roll, height along the feed.
  const [customW, setCustomW] = React.useState(50);
  const [customH, setCustomH] = React.useState(30);
  // Rotate the label content 90° — some rolls feed such that a wide barcode
  // must run along the LENGTH of the label to fit.
  const [rotate, setRotate] = React.useState(false);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
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
    // Resolve label size (in) + the @page size string from the chosen source.
    let widthIn: number | null = null;
    let heightIn: number | null = null;
    let pageSize = 'auto';
    if (size === 'custom') {
      widthIn = Math.max(0.2, customW / 25.4);
      heightIn = Math.max(0.2, customH / 25.4);
      pageSize = `${customW}mm ${customH}mm`;
    } else if (size !== 'auto') {
      const tpl = TEMPLATES[size];
      widthIn = tpl.widthIn;
      heightIn = tpl.heightIn;
      pageSize = tpl.pageSize;
    }
    // The label box IS one physical label: sized to the page, overflow clipped,
    // so content can never spill onto the next label. 'auto' fills whatever
    // paper the printer is set to (one page). 'rotate' turns the whole label
    // 90° for rolls that feed the long edge first — the box keeps the page
    // size, the inner content is rotated and its width/height swapped so it
    // still fills the label.
    const known = widthIn !== null && heightIn !== null;
    const boxCss = known ? `width:${widthIn}in;height:${heightIn}in;` : `width:100%;height:100vh;`;
    // Rotated inner content: swap dims so after rotate(90deg) it matches the box.
    const innerCss =
      rotate && known
        ? `width:${heightIn}in;height:${widthIn}in;transform:rotate(90deg);`
        : `width:100%;height:100%;`;
    const isSmall = known ? Math.min(widthIn!, heightIn!) < 1.4 : false;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Label</title>
<style>
  @page { size: ${pageSize}; margin: 0; }
  html,body{margin:0;padding:0;background:#fff;}
  .lbl{
    box-sizing:border-box;${boxCss}
    display:flex;align-items:center;justify-content:center;
    overflow:hidden;background:#fff;break-after:avoid;page-break-after:avoid;
  }
  .inner{
    box-sizing:border-box;${innerCss}
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:1mm;padding:1.5mm;overflow:hidden;text-align:center;
    font-family:system-ui,-apple-system,sans-serif;color:#000;
  }
  .inner img{max-width:100%;max-height:${isSmall ? '78%' : '68%'};object-fit:contain;}
  .nm{font-size:${isSmall ? '8px' : '11px'};font-weight:600;line-height:1.1;
    max-height:20%;overflow:hidden;${isSmall ? 'display:none;' : ''}}
  .sk{font-family:ui-monospace,Menlo,monospace;font-size:${isSmall ? '8px' : '10px'};letter-spacing:.5px;}
</style>
</head><body>
<div class="lbl"><div class="inner"><img id="bc" alt="" /><div class="nm" id="t"></div><div class="sk" id="s"></div></div></div>
<script>
(function(){
  var p=new URLSearchParams(location.hash.slice(1));
  document.getElementById('bc').src=p.get('src')||'';
  document.getElementById('t').textContent=p.get('t')||'';
  document.getElementById('s').textContent=p.get('s')||'';
  document.title=p.get('t')||'Label';
  var img=document.getElementById('bc');
  function go(){setTimeout(function(){window.print();},250);}
  // Wait for the barcode image to decode before printing so it isn't blank.
  if(img.complete){window.addEventListener('load',go);}else{img.addEventListener('load',go);img.addEventListener('error',go);}
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
          <div className="flex flex-wrap items-center justify-between gap-3">
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
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground text-xs">Label size</span>
              <select
                value={size}
                onChange={(e) => setSize(e.target.value as Template | 'auto' | 'custom')}
                className="border-input bg-background h-9 rounded-md border px-2.5 text-sm"
              >
                <option value="auto">Fit to printer (auto)</option>
                {(Object.keys(TEMPLATES) as Template[]).map((t) => (
                  <option key={t} value={t}>
                    {TEMPLATES[t].label}
                  </option>
                ))}
                <option value="custom">Custom size (mm)…</option>
              </select>
            </label>
          </div>

          {size === 'custom' && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 p-3">
              <label className="flex items-center gap-1.5 text-sm">
                <span className="text-muted-foreground text-xs">Width</span>
                <input
                  type="number"
                  min={5}
                  max={200}
                  value={customW}
                  onChange={(e) => setCustomW(Math.max(5, Math.min(200, Number(e.target.value) || 0)))}
                  className="border-input bg-background h-9 w-20 rounded-md border px-2 text-sm"
                />
                <span className="text-muted-foreground text-xs">mm</span>
              </label>
              <span className="text-muted-foreground">×</span>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="text-muted-foreground text-xs">Height</span>
                <input
                  type="number"
                  min={5}
                  max={200}
                  value={customH}
                  onChange={(e) => setCustomH(Math.max(5, Math.min(200, Number(e.target.value) || 0)))}
                  className="border-input bg-background h-9 w-20 rounded-md border px-2 text-sm"
                />
                <span className="text-muted-foreground text-xs">mm</span>
              </label>
              <p className="text-muted-foreground w-full text-[11px] leading-snug">
                Measure your loaded label exactly (width across the roll × height along the feed).
              </p>
            </div>
          )}

          {size !== 'auto' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={rotate}
                onChange={(e) => setRotate(e.target.checked)}
                className="h-4 w-4"
              />
              <span>Rotate 90°</span>
              <span className="text-muted-foreground text-xs">— if the barcode prints sideways</span>
            </label>
          )}
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
          {size !== 'auto' && (
            <p className="text-muted-foreground rounded-md bg-muted/30 px-3 py-2 text-[11px] leading-snug">
              In the print dialog, set <strong>Scale 100%</strong> (not &ldquo;Fit&rdquo;),{' '}
              <strong>Margins: None</strong>, and leave orientation as-is — use the Rotate 90°
              toggle above instead of the dialog&rsquo;s Landscape option.
            </p>
          )}
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
