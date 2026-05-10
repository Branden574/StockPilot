'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Minus,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import * as React from 'react';

import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { cn } from '@/lib/utils';

interface LightboxImage {
  id: string;
  url: string;
  isPrimary: boolean;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  startIndex: number;
  open: boolean;
  onClose: () => void;
  onDelete: (imageId: string) => Promise<void> | void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;
const DRAG_THRESHOLD = 4; // px before a click counts as a drag

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function pinchDistance(touches: React.TouchList | TouchList) {
  if (touches.length < 2) return 0;
  const a = touches[0]!;
  const b = touches[1]!;
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function ImageLightbox({
  images,
  startIndex,
  open,
  onClose,
  onDelete,
}: ImageLightboxProps) {
  const [index, setIndex] = React.useState(startIndex);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [loadedUrls, setLoadedUrls] = React.useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const dragRef = React.useRef<{
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
  } | null>(null);
  const pinchRef = React.useRef<{ distance: number; zoom: number } | null>(null);

  // Reset to caller's start index when (re-)opened.
  React.useEffect(() => {
    if (open) {
      setIndex(startIndex);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [open, startIndex]);

  // Reset zoom + pan when the active image changes.
  React.useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [index]);

  // If parent removes images via delete, keep the index valid (or close
  // when nothing's left).
  React.useEffect(() => {
    if (!open) return;
    if (images.length === 0) {
      onClose();
    } else if (index >= images.length) {
      setIndex(images.length - 1);
    }
  }, [open, images.length, index, onClose]);

  const current = images[index];
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  const goPrev = React.useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);
  const goNext = React.useCallback(() => {
    setIndex((i) => Math.min(images.length - 1, i + 1));
  }, [images.length]);

  // Keyboard navigation. ESC is handled by Radix Dialog itself.
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, hasPrev, hasNext, goPrev, goNext]);

  // Preload neighboring images so prev/next feels instant. Uses
  // <link rel="preload" as="image"> so the browser warms its cache
  // without inserting hidden <img> elements that affect layout.
  React.useEffect(() => {
    if (!open) return;
    const neighbors: string[] = [];
    if (index > 0 && images[index - 1]) neighbors.push(images[index - 1]!.url);
    if (index < images.length - 1 && images[index + 1])
      neighbors.push(images[index + 1]!.url);
    const links = neighbors.map((url) => {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.href = url;
      document.head.appendChild(link);
      return link;
    });
    return () => {
      links.forEach((l) => l.remove());
    };
  }, [open, index, images]);

  if (!current) return null;

  const adjustZoom = (next: number) => {
    const clamped = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (clamped === MIN_ZOOM) setPan({ x: 0, y: 0 });
    setZoom(clamped);
  };

  // ---- Wheel (desktop zoom) ----
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    adjustZoom(zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP) * 0.5);
  };

  // ---- Mouse / single-pointer drag (works while zoomed) ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pinchRef.current) return; // pinch is taking precedence
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
      moved: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (pinchRef.current || !dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      dragRef.current.moved = true;
    }
    if (zoom > 1) {
      setPan({
        x: dragRef.current.startPanX + dx,
        y: dragRef.current.startPanY + dy,
      });
    }
  };
  const onPointerUp = () => {
    // Defer reset so the image's onClick can still see `.moved`.
    const dr = dragRef.current;
    setTimeout(() => {
      if (dragRef.current === dr) dragRef.current = null;
    }, 0);
  };

  // ---- Touch (pinch zoom) ----
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchRef.current = { distance: pinchDistance(e.touches), zoom };
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const ratio = pinchDistance(e.touches) / pinchRef.current.distance;
      adjustZoom(pinchRef.current.zoom * ratio);
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) pinchRef.current = null;
  };

  // ---- Image click → toggle zoom (suppressed if it was a drag) ----
  const onImageClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragRef.current?.moved) return;
    if (zoom === 1) {
      adjustZoom(2);
    } else {
      adjustZoom(1);
    }
  };

  const handleDelete = () => {
    setConfirmOpen(true);
  };

  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await onDelete(current.id);
    } finally {
      setDeleteBusy(false);
      setConfirmOpen(false);
    }
    // Parent will pass a new images array on next render; the index-fix
    // effect above keeps us on a valid slide (or closes if empty).
  };

  // Keep the original filename portion of the storage path (the UUID) for
  // the download attribute. Servers generally honor `download` for
  // same-origin or signed URLs from Supabase Storage.
  const downloadName = (() => {
    const tail = current.url.split('?')[0]?.split('/').pop() ?? 'image';
    return tail.length > 0 ? tail : 'image';
  })();

  return (
    <>
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/95 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          onClick={onClose}
        >
          <DialogPrimitive.Title className="sr-only">Image viewer</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Image {index + 1} of {images.length}. Use left and right arrows to navigate, escape to
            close.
          </DialogPrimitive.Description>

          {/* Top toolbar */}
          <div
            className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 p-3 text-white sm:p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <span className="font-mono text-[13px] tabular-nums">
                {index + 1} <span className="text-white/50">of</span> {images.length}
              </span>
              {current.isPrimary && (
                <span className="rounded-sm bg-white/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                  Primary
                </span>
              )}
            </div>

            <div className="flex items-center gap-1">
              <ToolbarButton
                onClick={() => adjustZoom(zoom - ZOOM_STEP)}
                disabled={zoom <= MIN_ZOOM}
                ariaLabel="Zoom out"
              >
                <Minus className="h-4 w-4" />
              </ToolbarButton>
              <span className="w-12 text-center font-mono text-[12px] tabular-nums text-white/70">
                {Math.round(zoom * 100)}%
              </span>
              <ToolbarButton
                onClick={() => adjustZoom(zoom + ZOOM_STEP)}
                disabled={zoom >= MAX_ZOOM}
                ariaLabel="Zoom in"
              >
                <Plus className="h-4 w-4" />
              </ToolbarButton>

              <span className="mx-1 h-5 w-px bg-white/20" />

              <a
                href={current.url}
                download={downloadName}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="grid h-9 w-9 place-items-center rounded-md text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Download image"
              >
                <Download className="h-4 w-4" />
              </a>
              <ToolbarButton
                onClick={handleDelete}
                ariaLabel="Delete image"
                tone="danger"
              >
                <Trash2 className="h-4 w-4" />
              </ToolbarButton>

              <span className="mx-1 h-5 w-px bg-white/20" />

              <ToolbarButton onClick={onClose} ariaLabel="Close">
                <X className="h-4 w-4" />
              </ToolbarButton>
            </div>
          </div>

          {/* Image area */}
          <div
            className="relative flex-1 overflow-hidden"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            {!loadedUrls.has(current.url) && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 grid place-items-center text-white/50"
              >
                <Loader2 className="h-8 w-8 animate-spin" />
              </div>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={current.url}
              alt=""
              draggable={false}
              loading="eager"
              fetchPriority="high"
              onLoad={() =>
                setLoadedUrls((prev) => {
                  if (prev.has(current.url)) return prev;
                  const next = new Set(prev);
                  next.add(current.url);
                  return next;
                })
              }
              onClick={onImageClick}
              className={cn(
                'absolute inset-0 m-auto max-h-full max-w-full select-none object-contain transition-[transform,opacity] duration-100',
                zoom === 1 ? 'cursor-zoom-in' : 'cursor-grab',
                loadedUrls.has(current.url) ? 'opacity-100' : 'opacity-0',
              )}
              style={{
                transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                touchAction: 'none',
              }}
            />
          </div>

          {/* Prev / next arrows */}
          {hasPrev && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                goPrev();
              }}
              className="absolute left-3 top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20 sm:left-5 sm:h-12 sm:w-12"
              aria-label="Previous image"
            >
              <ChevronLeft className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                goNext();
              }}
              className="absolute right-3 top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20 sm:right-5 sm:h-12 sm:w-12"
              aria-label="Next image"
            >
              <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
    <DestructiveConfirm
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title="Remove this image?"
      description="The image is removed from this item and deleted from storage. This cannot be undone — re-upload the photo if you need it back."
      confirmLabel="Remove"
      pending={deleteBusy}
      onConfirm={confirmDelete}
    />
    </>
  );
}

function ToolbarButton({
  children,
  onClick,
  disabled,
  ariaLabel,
  tone = 'default',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'grid h-9 w-9 place-items-center rounded-md text-white/80 transition-colors disabled:cursor-not-allowed disabled:opacity-30',
        tone === 'danger'
          ? 'hover:bg-red-500/30 hover:text-white'
          : 'hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
    </button>
  );
}
