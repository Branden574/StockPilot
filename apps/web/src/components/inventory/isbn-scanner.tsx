'use client';

import { Camera, Loader2, ScanLine, X } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type BarcodeDetectorLike = {
  detect: (
    source: HTMLVideoElement | ImageBitmap,
  ) => Promise<Array<{ rawValue: string; format?: string }>>;
};
type BarcodeDetectorCtor = new (init?: { formats?: string[] }) => BarcodeDetectorLike;

const ISBN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

interface IsbnScannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDetected: (isbn: string) => void;
}

function looksLikeIsbn(raw: string): boolean {
  const digits = raw.replace(/[^0-9Xx]/g, '');
  if (digits.length !== 13 && digits.length !== 10) return false;
  if (digits.length === 13) return digits.startsWith('978') || digits.startsWith('979');
  return true;
}

export function IsbnScanner({ open, onOpenChange, onDetected }: IsbnScannerProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const stopFnRef = React.useRef<(() => void) | null>(null);
  const [status, setStatus] = React.useState<'idle' | 'starting' | 'scanning' | 'error'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [manualIsbn, setManualIsbn] = React.useState('');

  const stopAll = React.useCallback(() => {
    stopFnRef.current?.();
    stopFnRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const handleHit = React.useCallback(
    (raw: string) => {
      if (!looksLikeIsbn(raw)) return;
      stopAll();
      onDetected(raw.replace(/[^0-9Xx]/g, ''));
      onOpenChange(false);
    },
    [onDetected, onOpenChange, stopAll],
  );

  React.useEffect(() => {
    if (!open) {
      stopAll();
      setStatus('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus('starting');
    setError(null);

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera not available in this browser');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) throw new Error('Video element missing');
        video.srcObject = stream;
        await video.play();

        const Native = (
          globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
        ).BarcodeDetector;
        if (Native) {
          const detector = new Native({ formats: ISBN_FORMATS });
          let raf = 0;
          const tick = async () => {
            if (cancelled) return;
            try {
              const codes = await detector.detect(video);
              if (codes.length > 0) {
                handleHit(codes[0]!.rawValue);
                return;
              }
            } catch {
              // detect() can throw transiently; keep going
            }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
          stopFnRef.current = () => cancelAnimationFrame(raf);
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const { BarcodeFormat, DecodeHintType } = await import('@zxing/library');
          const hints = new Map();
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
          ]);
          const reader = new BrowserMultiFormatReader(hints);
          const controls = await reader.decodeFromVideoElement(video, (result) => {
            if (result) handleHit(result.getText());
          });
          stopFnRef.current = () => controls.stop();
        }

        if (!cancelled) setStatus('scanning');
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Camera failed';
        setError(msg);
        setStatus('error');
        stopAll();
      }
    })();

    return () => {
      cancelled = true;
      stopAll();
    };
  }, [open, handleHit, stopAll]);

  function submitManual() {
    const cleaned = manualIsbn.trim();
    if (!looksLikeIsbn(cleaned)) {
      toast.error('That doesn’t look like a valid ISBN');
      return;
    }
    onDetected(cleaned.replace(/[^0-9Xx]/g, ''));
    onOpenChange(false);
    setManualIsbn('');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-4 w-4" /> Scan ISBN
          </DialogTitle>
        </DialogHeader>

        <div className="bg-muted relative aspect-video w-full overflow-hidden rounded-md">
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            playsInline
            muted
          />
          {status === 'starting' && (
            <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting camera…
            </div>
          )}
          {status === 'error' && (
            <div className="bg-background/90 text-destructive absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-xs">
              <Camera className="h-4 w-4" />
              <span>{error}</span>
              <span className="text-muted-foreground">Type the ISBN below instead.</span>
            </div>
          )}
          {status === 'scanning' && (
            <div className="pointer-events-none absolute inset-x-6 top-1/2 h-px -translate-y-1/2 bg-emerald-400/80 shadow-[0_0_12px_rgba(52,211,153,0.6)]" />
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[11px]">
            Or type the ISBN
          </label>
          <div className="flex gap-2">
            <Input
              value={manualIsbn}
              onChange={(e) => setManualIsbn(e.target.value)}
              placeholder="978…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitManual();
                }
              }}
            />
            <Button type="button" variant="outline" onClick={submitManual}>
              Use
            </Button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            <X className="h-3.5 w-3.5" /> Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
