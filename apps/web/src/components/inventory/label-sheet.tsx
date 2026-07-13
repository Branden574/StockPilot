'use client';

import { Printer } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface LabelItem {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
}

export type Template =
  | 'small'
  | 'medium'
  | 'large'
  | 'thermal-40x30'
  | 'thermal-50x30'
  | 'thermal-50x80';
export type LabelFormat = 'barcode' | 'qr';

interface TemplateDef {
  label: string;
  /** 'sheet' = grid of labels on US-Letter (Avery). 'thermal' = roll printer
   *  (Phomemo M110/M120/M200-class): ONE label per page, @page size = the
   *  label size, zero margins, page-break after every label. */
  kind: 'sheet' | 'thermal';
  widthIn: number;
  heightIn: number;
  perRow: number;
  gapIn: number;
  /** CSS @page size. Sheets print on letter; thermal pages ARE the label. */
  pageSize: string;
}

const MM_PER_IN = 25.4;

const TEMPLATES: Record<Template, TemplateDef> = {
  // Avery 5160 / Avery J8160 — 30 labels per US Letter sheet (3 x 10).
  small: { label: 'Small (Avery 5160 · 1" × 2 ⅝")', kind: 'sheet', widthIn: 2.625, heightIn: 1, perRow: 3, gapIn: 0.125, pageSize: 'letter' },
  // Avery 5163 — 10 labels per US Letter sheet (2 x 5).
  medium: { label: 'Medium (Avery 5163 · 2" × 4")', kind: 'sheet', widthIn: 4, heightIn: 2, perRow: 2, gapIn: 0.125, pageSize: 'letter' },
  // Avery 5164 — 6 labels per US Letter sheet (2 x 3).
  large: { label: 'Large (Avery 5164 · 3 ⅓" × 4")', kind: 'sheet', widthIn: 4, heightIn: 3.333, perRow: 2, gapIn: 0.125, pageSize: 'letter' },
  // Thermal roll stocks (Phomemo M110/M120/M200/M220 and similar). Sizes are
  // the common die-cut label stocks; pick the one matching the loaded roll.
  'thermal-40x30': { label: 'Thermal roll · 40 × 30 mm (Phomemo)', kind: 'thermal', widthIn: 40 / MM_PER_IN, heightIn: 30 / MM_PER_IN, perRow: 1, gapIn: 0, pageSize: '40mm 30mm' },
  'thermal-50x30': { label: 'Thermal roll · 50 × 30 mm (Phomemo)', kind: 'thermal', widthIn: 50 / MM_PER_IN, heightIn: 30 / MM_PER_IN, perRow: 1, gapIn: 0, pageSize: '50mm 30mm' },
  'thermal-50x80': { label: 'Thermal roll · 50 × 80 mm (Phomemo large)', kind: 'thermal', widthIn: 50 / MM_PER_IN, heightIn: 80 / MM_PER_IN, perRow: 1, gapIn: 0, pageSize: '50mm 80mm' },
};

/** Server-safe template validation for the ?template= URL param. */
export function parseTemplate(raw: string | undefined): Template {
  return raw && raw in TEMPLATES ? (raw as Template) : 'medium';
}

interface Props {
  items: LabelItem[];
  copies: number;
  template: Template;
  format?: LabelFormat;
}

export function LabelSheet({
  items,
  copies: initialCopies,
  template: initialTemplate,
  format: initialFormat = 'barcode',
}: Props) {
  const [copies, setCopies] = React.useState(initialCopies);
  const [template, setTemplate] = React.useState<Template>(initialTemplate);
  const [format, setFormat] = React.useState<LabelFormat>(initialFormat);

  const expanded = React.useMemo(() => {
    const out: LabelItem[] = [];
    for (const item of items) {
      for (let i = 0; i < copies; i++) out.push(item);
    }
    return out;
  }, [items, copies]);

  if (items.length === 0) {
    return (
      <div className="border-border bg-card rounded-md border p-8 text-center print:hidden">
        <p className="text-muted-foreground text-sm">
          No items selected. Go to the inventory list, pick rows, and use the
          "Print labels" bulk action.
        </p>
      </div>
    );
  }

  const tpl = TEMPLATES[template];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end gap-3 print:hidden">
        <div className="space-y-1.5">
          <Label className="text-muted-foreground text-[11px]">Template</Label>
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value as Template)}
            className="border-input bg-background h-10 rounded-md border px-3 text-sm"
          >
            {(Object.keys(TEMPLATES) as Template[]).map((t) => (
              <option key={t} value={t}>
                {TEMPLATES[t].label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-muted-foreground text-[11px]">Format</Label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as LabelFormat)}
            className="border-input bg-background h-10 rounded-md border px-3 text-sm"
          >
            <option value="barcode">Barcode (Code 128)</option>
            <option value="qr">QR code</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-muted-foreground text-[11px]">Copies per item</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={copies}
            onChange={(e) => setCopies(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className="w-24"
          />
        </div>
        <div className="ml-auto">
          <Button onClick={() => window.print()} variant="gradient">
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>
      </div>

      <div className="label-print-page">
        <div
          className={tpl.kind === 'thermal' ? 'label-grid label-grid--thermal' : 'label-grid'}
          style={
            tpl.kind === 'thermal'
              ? // One label per printed page — stack vertically; the print CSS
                // page-breaks after each cell so the roll advances label by label.
                { display: 'flex', flexDirection: 'column', gap: '8px' }
              : {
                  display: 'grid',
                  gridTemplateColumns: `repeat(${tpl.perRow}, ${tpl.widthIn}in)`,
                  gap: `${tpl.gapIn}in`,
                }
          }
        >
          {expanded.map((it, idx) => (
            <LabelCell
              key={`${it.id}-${idx}-${format}`}
              item={it}
              widthIn={tpl.widthIn}
              heightIn={tpl.heightIn}
              format={format}
            />
          ))}
        </div>
      </div>

      {/*
        Print stylesheet: hides everything outside the label sheet and removes
        the dashboard chrome's body lock so the sheet can flow across pages.
        @page follows the template: Avery sheets print on US Letter with a
        0.5in margin; thermal-roll templates make the PAGE the label (e.g.
        "50mm 80mm", zero margin) and break after every cell so each label
        lands on its own stock — that's what roll printers like the Phomemo
        M120 expect. The on-screen dashed cut guide never prints on thermal
        (it would ink a frame onto the die-cut label).
      */}
      <style jsx global>{`
        @media print {
          @page {
            size: ${tpl.pageSize};
            margin: ${tpl.kind === 'thermal' ? '0' : '0.5in'};
          }
          html,
          body {
            background: #fff !important;
            height: auto !important;
            overflow: visible !important;
          }
          body * {
            visibility: hidden !important;
          }
          .label-print-page,
          .label-print-page * {
            visibility: visible !important;
          }
          .label-print-page {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            background: #fff;
            color: #000;
          }
          .label-grid--thermal {
            display: block !important;
          }
          .label-grid--thermal .label-cell {
            border: none !important;
            page-break-after: always;
            break-after: page;
          }
          .label-grid--thermal .label-cell:last-child {
            page-break-after: auto;
            break-after: auto;
          }
        }
      `}</style>
    </>
  );
}

function LabelCell({
  item,
  widthIn,
  heightIn,
  format,
}: {
  item: LabelItem;
  widthIn: number;
  heightIn: number;
  format: LabelFormat;
}) {
  const barcodeRef = React.useRef<SVGSVGElement | null>(null);
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);

  // Barcode (Code-128) path.
  React.useEffect(() => {
    if (format !== 'barcode') return;
    let cancelled = false;
    (async () => {
      const { default: JsBarcode } = await import('jsbarcode');
      if (cancelled || !barcodeRef.current) return;
      const value = item.barcode?.trim() || item.sku;
      try {
        JsBarcode(barcodeRef.current, value, {
          format: 'CODE128',
          displayValue: false,
          margin: 0,
          height: Math.max(28, heightIn * 36),
          width: 1.4,
        });
      } catch {
        // Bad characters for CODE128 → fall back to plain text only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [format, item.barcode, item.sku, heightIn]);

  // QR path. Encodes the public deep-link URL so a printed batch QR
  // resolves to the same /p/items/[id] page when scanned. Render via
  // PNG data URL inside an <img> — sharper than canvas at the small
  // 1-inch print size and avoids innerHTML-style SVG injection.
  React.useEffect(() => {
    if (format !== 'qr') return;
    let cancelled = false;
    (async () => {
      const { default: QRCode } = await import('qrcode');
      const origin =
        typeof window !== 'undefined' ? window.location.origin : '';
      const url = `${origin}/p/items/${item.id}`;
      try {
        const dataUrl = await QRCode.toDataURL(url, {
          margin: 1,
          width: 600, // generous so print rasterizes crisply at 1in
          errorCorrectionLevel: 'M',
        });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch {
        if (!cancelled) setQrDataUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [format, item.id]);

  const encodedHeight =
    format === 'qr'
      ? heightIn >= 2
        ? '70%'
        : '60%'
      : heightIn >= 2
        ? '50%'
        : '55%';

  return (
    <div
      className="label-cell"
      style={{
        width: `${widthIn}in`,
        height: `${heightIn}in`,
        border: '1px dashed #d4d4d8',
        boxSizing: 'border-box',
        padding: '0.08in',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#fff',
        color: '#000',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          fontSize: heightIn >= 2 ? 12 : 10,
          fontWeight: 600,
          lineHeight: 1.15,
          maxHeight: heightIn >= 2 ? '0.55in' : '0.32in',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: heightIn >= 2 ? 3 : 2,
        }}
      >
        {item.name}
      </div>
      {format === 'qr' ? (
        <div
          style={{
            width: encodedHeight,
            height: encodedHeight,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : null}
        </div>
      ) : (
        <svg
          ref={barcodeRef}
          style={{ width: '100%', height: encodedHeight }}
          aria-hidden
        />
      )}
      <div
        style={{
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: heightIn >= 2 ? 11 : 9,
          letterSpacing: 0.5,
          textAlign: 'center',
        }}
      >
        {item.barcode?.trim() || item.sku}
      </div>
    </div>
  );
}
