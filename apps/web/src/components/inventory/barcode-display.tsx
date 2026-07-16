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
import {
  buildPhomemoFilename,
  computeLabelPx,
  formatLabelPx,
} from '@/lib/labels/phomemo-png';

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
  // width across the roll, height along the feed. Held as strings so the
  // field can be cleared/retyped freely; clamped to 5-200mm only at print
  // time (clamping on each keystroke snapped a half-typed value back and
  // made the input impossible to edit).
  const [customW, setCustomW] = React.useState('50');
  const [customH, setCustomH] = React.useState('30');
  const clampMm = (raw: string, fallback: number) =>
    Math.max(5, Math.min(200, Number(raw) || fallback));
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
  // "Download PNG (Phomemo)" — the M120's macOS driver misrotates thermal
  // output, so this renders the label at the printer's EXACT native pixel
  // size (203 DPI) client-side and hands the owner a PNG to print from the
  // Phomemo app instead, which handles orientation correctly. Needs a known
  // physical size, so it's only available once a template/custom size is
  // picked (same gating as the rotate toggle below — 'auto' has no mm size).
  const [phomemoBusy, setPhomemoBusy] = React.useState(false);
  const [phomemoError, setPhomemoError] = React.useState<string | null>(null);

  // Resolve the selected label's physical size in mm — null for 'auto'
  // (no known physical dimensions, so the Phomemo PNG can't be sized).
  const labelMm = React.useMemo((): { widthMm: number; heightMm: number } | null => {
    if (size === 'custom') {
      return { widthMm: clampMm(customW, 50), heightMm: clampMm(customH, 30) };
    }
    if (size === 'auto') return null;
    const tpl = TEMPLATES[size];
    return { widthMm: tpl.widthIn * 25.4, heightMm: tpl.heightIn * 25.4 };
  }, [size, customW, customH]);

  const labelPx = React.useMemo(
    () => (labelMm ? computeLabelPx(labelMm.widthMm, labelMm.heightMm) : null),
    [labelMm],
  );

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
      const wMm = clampMm(customW, 50);
      const hMm = clampMm(customH, 30);
      widthIn = wMm / 25.4;
      heightIn = hMm / 25.4;
      pageSize = `${wMm}mm ${hMm}mm`;
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
    // The inner is ABSOLUTELY centered on the label (top/left 50% +
    // translate(-50%,-50%)) so it stays centered whether or not it is rotated.
    // When rotating, its width/height are swapped to the box's opposite dims,
    // then rotate(90deg) lands it back filling the label. (The previous flex
    // approach let the pre-rotation box overflow the label and knocked the
    // print off-center — that's the "won't center" bug.)
    const innerDims = known
      ? rotate
        ? `width:${heightIn}in;height:${widthIn}in;`
        : `width:${widthIn}in;height:${heightIn}in;`
      : `width:100%;height:100%;`;
    const innerTransform = `translate(-50%,-50%)${rotate && known ? ' rotate(90deg)' : ''}`;
    const isSmall = known ? Math.min(widthIn!, heightIn!) < 1.4 : false;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Label</title>
<style>
  @page { size: ${pageSize}; margin: 0; }
  html,body{margin:0;padding:0;background:#fff;}
  .lbl{
    box-sizing:border-box;${boxCss}
    position:relative;overflow:hidden;background:#fff;
    break-after:avoid;page-break-after:avoid;
  }
  .inner{
    box-sizing:border-box;${innerDims}
    position:absolute;top:50%;left:50%;transform:${innerTransform};
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

  // Renders the label onto an offscreen canvas at the EXACT device-pixel
  // size for the printer's native 203 DPI (see phomemo-png.ts) and downloads
  // it as a PNG — bypassing the macOS print driver entirely so the owner can
  // print it from the Phomemo app, which handles orientation correctly.
  // Draws client-side with JsBarcode/qrcode directly (rather than reusing
  // the server-rendered preview PNG above) so the pixel dimensions are
  // exact and deterministic, matching label-sheet.tsx's bulk-print approach.
  async function downloadPhomemoPng() {
    if (!labelMm || !labelPx) return;
    setPhomemoError(null);
    setPhomemoBusy(true);
    try {
      const { widthPx, heightPx } = labelPx;
      const canvas = document.createElement('canvas');
      canvas.width = widthPx;
      canvas.height = heightPx;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable in this browser');
      // Nearest-neighbor scaling for the barcode/QR drawImage below — keeps
      // bars/modules crisp instead of anti-aliased fuzz at thermal DPI.
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, widthPx, heightPx);
      ctx.fillStyle = '#000';
      ctx.textAlign = 'center';

      // Same "small label" threshold as printIt() above (1.4in = 35.56mm):
      // the name is dropped so the barcode/QR gets the space instead.
      const isSmall = Math.min(labelMm.widthMm, labelMm.heightMm) < 35.56;
      const padPx = Math.max(2, Math.round(widthPx * 0.03));
      const skuText = barcode?.trim() || sku;

      let cursorY = padPx;
      if (!isSmall) {
        const nameFontPx = Math.max(8, Math.round(heightPx * 0.11));
        ctx.font = `700 ${nameFontPx}px system-ui, -apple-system, sans-serif`;
        cursorY += nameFontPx;
        ctx.fillText(
          fitCanvasText(ctx, itemName, widthPx - padPx * 2),
          widthPx / 2,
          cursorY,
          widthPx - padPx * 2,
        );
        cursorY += Math.round(nameFontPx * 0.4);
      }

      const skuFontPx = Math.max(7, Math.round(heightPx * (isSmall ? 0.14 : 0.08)));
      const bottomReserved = skuFontPx + Math.round(skuFontPx * 0.6);
      const codeAreaTop = cursorY;
      const codeAreaWidth = widthPx - padPx * 2;
      const codeAreaHeight = Math.max(1, heightPx - padPx - bottomReserved - cursorY);

      if (type === 'qr') {
        const origin = window.location.origin;
        const itemUrl = `${origin}/p/items/${itemId}`;
        const { default: QRCode } = await import('qrcode');
        const sizePx = Math.max(1, Math.round(Math.min(codeAreaWidth, codeAreaHeight)));
        // Render larger than the target box then downscale — sharper edges
        // once imageSmoothingEnabled=false snaps them back to hard pixels.
        const dataUrl = await QRCode.toDataURL(itemUrl, {
          margin: 1,
          width: Math.max(128, sizePx * 4),
          errorCorrectionLevel: 'M',
        });
        const img = await loadImageElement(dataUrl);
        const dx = Math.round((widthPx - sizePx) / 2);
        const dy = Math.round(codeAreaTop + (codeAreaHeight - sizePx) / 2);
        ctx.drawImage(img, dx, dy, sizePx, sizePx);
      } else {
        const { default: JsBarcode } = await import('jsbarcode');
        const barcodeCanvas = document.createElement('canvas');
        // Integer bar-module width so bars land on whole device pixels
        // instead of sub-pixel widths that blur on a 1-bit thermal head.
        const moduleWidthPx = Math.max(1, Math.round(widthPx / 220));
        JsBarcode(barcodeCanvas, skuText, {
          format: 'CODE128',
          displayValue: false,
          margin: 0,
          width: moduleWidthPx,
          height: Math.max(20, codeAreaHeight),
        });
        const scale = Math.min(
          codeAreaWidth / barcodeCanvas.width,
          codeAreaHeight / barcodeCanvas.height,
          1,
        );
        const drawW = Math.max(1, Math.round(barcodeCanvas.width * scale));
        const drawH = Math.max(1, Math.round(barcodeCanvas.height * scale));
        const dx = Math.round((widthPx - drawW) / 2);
        const dy = Math.round(codeAreaTop + (codeAreaHeight - drawH) / 2);
        ctx.drawImage(barcodeCanvas, dx, dy, drawW, drawH);
      }

      ctx.font = `400 ${skuFontPx}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.fillText(skuText, widthPx / 2, heightPx - padPx, widthPx - padPx * 2);

      const pngUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = buildPhomemoFilename({
        sku,
        widthMm: labelMm.widthMm,
        heightMm: labelMm.heightMm,
      });
      a.click();
    } catch (e) {
      setPhomemoError(e instanceof Error ? e.message : 'Could not render the PNG');
    } finally {
      setPhomemoBusy(false);
    }
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
                  inputMode="decimal"
                  min={5}
                  max={200}
                  value={customW}
                  onChange={(e) => setCustomW(e.target.value)}
                  onBlur={() => setCustomW(String(clampMm(customW, 50)))}
                  className="border-input bg-background h-9 w-20 rounded-md border px-2 text-sm"
                />
                <span className="text-muted-foreground text-xs">mm</span>
              </label>
              <span className="text-muted-foreground">×</span>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="text-muted-foreground text-xs">Height</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={5}
                  max={200}
                  value={customH}
                  onChange={(e) => setCustomH(e.target.value)}
                  onBlur={() => setCustomH(String(clampMm(customH, 30)))}
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
          {size !== 'auto' && labelPx && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3">
              <div>
                <p className="text-sm font-medium">Phomemo printer app</p>
                <p className="text-muted-foreground text-[11px] leading-snug">
                  If the M120&rsquo;s macOS driver misrotates this label, download it as a PNG at
                  the printer&rsquo;s exact size and print it from the Phomemo app instead —{' '}
                  {formatLabelPx(labelPx)}.
                </p>
                {phomemoError && (
                  <p role="alert" className="text-destructive mt-1 text-[11px] font-medium">
                    {phomemoError}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={downloadPhomemoPng}
                disabled={phomemoBusy}
              >
                {phomemoBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Download PNG (Phomemo)
              </Button>
            </div>
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

/** Truncate `text` with an ellipsis so it fits within `maxWidth` canvas
 *  px, using the context's current font. Canvas text never wraps on its
 *  own, so the name line needs this to avoid spilling off the label. */
function fitCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + ellipsis;
}

/** Promise wrapper so a data-URL image can be awaited before drawImage. */
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode QR image'));
    img.src = src;
  });
}
