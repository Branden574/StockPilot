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
// Anything a Code 128 / EAN / UPC scanner can produce. Used when the
// caller wants a generic product barcode (regular inventory items)
// instead of strictly an ISBN.
const PRODUCT_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'itf',
];

interface IsbnScannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDetected: (isbn: string) => void;
  /**
   * Default 'isbn' — locks scanning to ISBN-shaped barcodes, with
   * ISBN-specific labels and a 978/979 prefix gate. Pass 'barcode'
   * when adding a regular item: accepts any product barcode the
   * scanner can read, and the labels/placeholder swap accordingly.
   */
  mode?: 'isbn' | 'barcode';
}

function looksLikeIsbn(raw: string): boolean {
  const digits = raw.replace(/[^0-9Xx]/g, '');
  if (digits.length !== 13 && digits.length !== 10) return false;
  if (digits.length === 13) return digits.startsWith('978') || digits.startsWith('979');
  return true;
}

/**
 * Loose validator for generic product barcodes. Accepts any string of
 * 6-30 alphanumeric chars + a few symbols. The detector itself filters
 * for valid linear-barcode shapes; we just sanity-check the typed
 * fallback path.
 */
function looksLikeBarcode(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < 4 || trimmed.length > 32) return false;
  return /^[A-Za-z0-9\-_./ ]+$/.test(trimmed);
}

type Stage = 'idle' | 'permission' | 'camera' | 'detector' | 'scanning' | 'error';
const STAGE_MESSAGES: Record<Exclude<Stage, 'idle' | 'scanning' | 'error'>, string> = {
  permission: 'Waiting for camera permission…',
  camera: 'Starting camera…',
  detector: 'Loading scanner…',
};

export function IsbnScanner({
  open,
  onOpenChange,
  onDetected,
  mode = 'isbn',
}: IsbnScannerProps) {
  const isIsbn = mode === 'isbn';
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const stopFnRef = React.useRef<(() => void) | null>(null);
  const [stage, setStage] = React.useState<Stage>('idle');
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
      // Accept based on mode: ISBN form requires 10/13 digits +
      // 978/979 prefix; generic mode passes through whatever the
      // scanner produced.
      if (isIsbn) {
        if (!looksLikeIsbn(raw)) return;
        stopAll();
        onDetected(raw.replace(/[^0-9Xx]/g, ''));
        onOpenChange(false);
      } else {
        const trimmed = raw.trim();
        if (trimmed.length === 0) return;
        stopAll();
        onDetected(trimmed);
        onOpenChange(false);
      }
    },
    [isIsbn, onDetected, onOpenChange, stopAll],
  );

  React.useEffect(() => {
    if (!open) {
      stopAll();
      setStage('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    setStage('permission');
    setError(null);

    // The native BarcodeDetector is available on Chrome/Edge and iOS
    // Safari 17+. When it isn't, we fall back to @zxing/browser — large
    // module, ~80KB. Kick off the import in PARALLEL with camera setup
    // so it's already resolved by the time the camera is ready, instead
    // of stretching the warm-up by a sequential network round-trip.
    const Native = (
      globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
    ).BarcodeDetector;
    const zxingPromise = Native
      ? null
      : Promise.all([import('@zxing/browser'), import('@zxing/library')]);

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
        if (!cancelled) setStage('camera');
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) throw new Error('Video element missing');
        video.srcObject = stream;
        await video.play();

        if (!cancelled) setStage('detector');

        if (Native) {
          const detector = new Native({
            formats: isIsbn ? ISBN_FORMATS : PRODUCT_FORMATS,
          });
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
        } else if (zxingPromise) {
          const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] =
            await zxingPromise;
          if (cancelled) return;
          const hints = new Map();
          hints.set(
            DecodeHintType.POSSIBLE_FORMATS,
            isIsbn
              ? [
                  BarcodeFormat.EAN_13,
                  BarcodeFormat.EAN_8,
                  BarcodeFormat.UPC_A,
                  BarcodeFormat.UPC_E,
                ]
              : [
                  BarcodeFormat.EAN_13,
                  BarcodeFormat.EAN_8,
                  BarcodeFormat.UPC_A,
                  BarcodeFormat.UPC_E,
                  BarcodeFormat.CODE_128,
                  BarcodeFormat.CODE_39,
                  BarcodeFormat.CODE_93,
                  BarcodeFormat.CODABAR,
                  BarcodeFormat.ITF,
                ],
          );
          const reader = new BrowserMultiFormatReader(hints);
          const controls = await reader.decodeFromVideoElement(video, (result) => {
            if (result) handleHit(result.getText());
          });
          stopFnRef.current = () => controls.stop();
        }

        if (!cancelled) setStage('scanning');
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Camera failed';
        setError(msg);
        setStage('error');
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
    if (isIsbn) {
      if (!looksLikeIsbn(cleaned)) {
        toast.error("That doesn't look like a valid ISBN. Check the digits and try again.");
        return;
      }
      onDetected(cleaned.replace(/[^0-9Xx]/g, ''));
    } else {
      if (!looksLikeBarcode(cleaned)) {
        toast.error("That doesn't look like a valid barcode. Check the digits and try again.");
        return;
      }
      onDetected(cleaned);
    }
    onOpenChange(false);
    setManualIsbn('');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-4 w-4" /> {isIsbn ? 'Scan ISBN' : 'Scan barcode'}
          </DialogTitle>
        </DialogHeader>

        <div className="bg-muted relative aspect-video w-full overflow-hidden rounded-md">
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            playsInline
            muted
          />
          {(stage === 'permission' || stage === 'camera' || stage === 'detector') && (
            <div className="bg-background/70 text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs backdrop-blur-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{STAGE_MESSAGES[stage]}</span>
              <span className="text-[10.5px] opacity-70">
                First scan can take a few seconds
              </span>
            </div>
          )}
          {stage === 'error' && (
            <div className="bg-background/90 text-destructive absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-xs">
              <Camera className="h-4 w-4" />
              <span>{error}</span>
              <span className="text-muted-foreground">
                Type the {isIsbn ? 'ISBN' : 'barcode'} below instead.
              </span>
            </div>
          )}
          {stage === 'scanning' && (
            <div className="pointer-events-none absolute inset-x-6 top-1/2 h-px -translate-y-1/2 bg-emerald-400/80 shadow-[0_0_12px_rgba(52,211,153,0.6)]" />
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[11px]">
            Or type the {isIsbn ? 'ISBN' : 'barcode'}
          </label>
          <div className="flex gap-2">
            <Input
              value={manualIsbn}
              onChange={(e) => setManualIsbn(e.target.value)}
              placeholder={isIsbn ? '978…' : 'Type or paste'}
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
