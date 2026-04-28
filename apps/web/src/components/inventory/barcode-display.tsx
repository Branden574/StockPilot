'use client';

import { Download, Printer, QrCode } from 'lucide-react';
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

export function BarcodeDisplay({ itemId, itemName, sku, barcode }: BarcodeDisplayProps) {
  const [type, setType] = React.useState<'code128' | 'qr'>(barcode ? 'code128' : 'qr');
  const src = `/api/v1/items/${itemId}/barcode?type=${type}`;

  function printIt() {
    // Build print-ready HTML and open via Blob URL to avoid document.write.
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
    const params = new URLSearchParams({ src, t: itemName, s: sku }).toString();
    window.open(`${url}#${params}`, '_blank', 'width=420,height=600');
    // Schedule revoke; the new window has loaded by then.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <Dialog>
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
                  (type === opt ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')
                }
              >
                {opt === 'code128' ? 'Barcode' : 'QR code'}
              </button>
            ))}
          </div>
          <div className="grid place-items-center rounded-lg border bg-white p-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="barcode" className="max-h-48" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" asChild>
              <a href={src} download={`${sku}-${type}.png`}>
                <Download className="h-4 w-4" /> Download
              </a>
            </Button>
            <Button variant="gradient" onClick={printIt}>
              <Printer className="h-4 w-4" /> Print
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
