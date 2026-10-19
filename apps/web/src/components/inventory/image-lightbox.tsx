'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, Loader2, Minus, Plus, Trash2, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { cn } from '@/lib/utils';

interface LightboxImage {
  id: string;
  url: string;
  isPrimary?: boolean;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  startIndex: number;
  open: boolean;
  onClose: () => void;
  /** Optional — when omitted, the delete affordance is hidden (e.g. order
   *  proof attachments, where deletion lives in the panel and viewers may
   *  lack permission). */
  onDelete?: (imageId: string) => Promise<void> | void;
  /** When given, an image that fails to load (an expired signed link, a
   *  missing file) shows `message` and a Try again that calls `onRetry`,
   *  instead of the loading spinner forever. */
  loadFailure?: { message: string; onRetry: () => void };
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
  loadFailure,
}: ImageLightboxProps) {
  const [index, setIndex] = React.useState(startIndex);
  const [failedUrls, setFailedUrls] = React.useState<ReadonlySet<string>>(() => new Set());
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [loadedUrls, setLoadedUrls] = React.useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // The image Delete was pressed on. The confirm removes THAT image, whatever
  // the viewer shows by the time it is confirmed.
  const [deleteTargetId, setDeleteTargetId] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  // The delete confirm is a dialog of its own with no trigger, so when it
  // closed Radix had nothing to hand focus back to and it fell to the page
  // body: a keyboard user lost their place in the viewer. Focus goes back to
  // Delete (the next photo's, after a removal) once the confirm has closed.
  const deleteButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const confirmWasOpen = React.useRef(false);
  React.useEffect(() => {
    const justClosed = confirmWasOpen.current && !confirmOpen;
    confirmWasOpen.current = confirmOpen;
    if (!justClosed || !open) return;
    const id = window.setTimeout(() => deleteButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [confirmOpen, open]);
  // The viewer has no Radix trigger either: every caller opens it from its
  // own thumbnail button, so on close focus fell to the page body as well and
  // a keyboard user started again from the top of the page. It goes back to
  // what had focus when the viewer opened (the thumbnail), while that is
  // still on the page.
  const openerRef = React.useRef<HTMLElement | null>(null);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
      setIndex(startIndex);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [open, startIndex]);

  // Reset zoom + pan when the active image changes.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
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

  // Keyboard navigation. ESC is handled by Radix Dialog itself. While the
  // delete confirm is open the arrows belong to it: they used to page the
  // viewer behind it, so the confirm then removed a different image than the
  // one Delete was pressed on.
  React.useEffect(() => {
    if (!open || confirmOpen) return;
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
  }, [open, confirmOpen, hasPrev, hasNext, goPrev, goNext]);

  // Preload neighboring images so prev/next feels instant. Uses
  // <link rel="preload" as="image"> so the browser warms its cache
  // without inserting hidden <img> elements that affect layout.
  React.useEffect(() => {
    if (!open) return;
    const neighbors: string[] = [];
    if (index > 0 && images[index - 1]) neighbors.push(images[index - 1]!.url);
    if (index < images.length - 1 && images[index + 1]) neighbors.push(images[index + 1]!.url);
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
    setDeleteTargetId(current.id);
    setConfirmOpen(true);
  };

  const confirmDelete = async () => {
    const targetId = deleteTargetId;
    if (!onDelete || !targetId) return;
    setDeleteBusy(true);
    try {
      await onDelete(targetId);
    } finally {
      setDeleteBusy(false);
      setConfirmOpen(false);
      setDeleteTargetId(null);
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
          {/* The viewing surface stays near-black in both themes (like the
              scanner viewfinder) so every photo reads the same; the controls
              on it follow the theme. No blur anywhere: a full-screen
              backdrop-filter repaints on the CPU on every frame. */}
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/95 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className="fixed inset-0 z-50 flex flex-col outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 max-sm:pb-[calc(4.5rem_+_env(safe-area-inset-bottom))]"
            onClick={onClose}
            onOpenAutoFocus={() => {
              const el = document.activeElement;
              openerRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
            }}
            onCloseAutoFocus={(e) => {
              const opener = openerRef.current;
              openerRef.current = null;
              if (!opener) return;
              // In place of Radix's own step (focus the trigger), which finds
              // none here.
              e.preventDefault();
              opener.focus();
            }}
          >
            <DialogPrimitive.Title className="sr-only">Image viewer</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Image {index + 1} of {images.length}. Use left and right arrows to navigate, escape to
              close.
            </DialogPrimitive.Description>

            {/* Top bar: where the image is in the set on the left, Close on
                the right. The photo sits below it, never under it. */}
            <div
              className="relative z-10 flex shrink-0 items-center justify-between gap-2 p-3 sm:p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className={cn(CHIP, 'gap-2 px-3 py-0.5')}>
                {/* The words sit in a plain inline span: as direct text of a
                    flex box, the spaces around "of" would collapse ("1of3"). */}
                <span className={cn('flex items-center', TOUCH)}>
                  <span className="font-mono text-[12.5px] tabular-nums">
                    {index + 1} <span className="text-muted-foreground">of</span> {images.length}
                  </span>
                </span>
                {current.isPrimary && (
                  <span className="border-border text-muted-foreground border-l pl-2 text-[11px] font-medium uppercase tracking-[0.1em]">
                    Primary
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {/* Zoom, Download and Delete sit beside Close from sm up. At
                    phone width they move to the bottom, in thumb reach, so the
                    bar never runs past the screen edge (it did with Delete and
                    the Primary tag at 390px, pushing Close off screen). */}
                <div
                  className={cn(
                    CHIP,
                    'gap-0.5 p-0.5',
                    'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:mx-auto max-sm:w-max',
                  )}
                >
                  <ToolbarButton
                    onClick={() => adjustZoom(zoom - ZOOM_STEP)}
                    disabled={zoom <= MIN_ZOOM}
                    ariaLabel="Zoom out"
                  >
                    <Minus className="size-4" />
                  </ToolbarButton>
                  <span className="text-muted-foreground w-12 text-center font-mono text-[12px] tabular-nums">
                    {Math.round(zoom * 100)}%
                  </span>
                  <ToolbarButton
                    onClick={() => adjustZoom(zoom + ZOOM_STEP)}
                    disabled={zoom >= MAX_ZOOM}
                    ariaLabel="Zoom in"
                  >
                    <Plus className="size-4" />
                  </ToolbarButton>

                  <span aria-hidden className="bg-border mx-0.5 h-5 w-px" />

                  <a
                    href={current.url}
                    download={downloadName}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className={toolClass('default')}
                    aria-label="Download image"
                  >
                    <Download className="size-4" />
                  </a>
                  {onDelete && (
                    <ToolbarButton
                      onClick={handleDelete}
                      ariaLabel="Delete image"
                      tone="danger"
                      buttonRef={deleteButtonRef}
                    >
                      <Trash2 className="size-4" />
                    </ToolbarButton>
                  )}
                </div>

                <div className={cn(CHIP, 'p-0.5')}>
                  <ToolbarButton onClick={onClose} ariaLabel="Close">
                    <X className="size-4" />
                  </ToolbarButton>
                </div>
              </div>
            </div>

            {/* Image area */}
            <div
              className="relative min-h-0 flex-1 overflow-hidden"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            >
              {loadFailure && failedUrls.has(current.url) ? (
                <div
                  data-testid="image-viewer-failure"
                  className={cn(
                    'absolute inset-0 z-10 flex items-center justify-center px-6',
                    // At phone width the arrows sit 12px in from each edge and
                    // are 44px wide; the card slid under the Next arrow, so it
                    // keeps 64px clear of each edge while arrows are shown.
                    (hasPrev || hasNext) && 'max-sm:px-16',
                  )}
                >
                  {/* A card on the dark surface, in the theme's colours. A
                      press on it (Try again included) stays in the viewer:
                      it used to close it as well, so the retry landed on a
                      closed viewer. */}
                  <div
                    className="border-border bg-popover text-popover-foreground flex max-w-sm flex-col items-center gap-3 rounded-lg border px-5 py-4 text-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p role="alert" className="text-sm">
                      {loadFailure.message}
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={loadFailure.onRetry}>
                      Try again
                    </Button>
                  </div>
                </div>
              ) : !loadedUrls.has(current.url) ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 grid place-items-center text-white/60"
                >
                  <Loader2 className="size-8 animate-spin" />
                </div>
              ) : null}
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
                onError={
                  loadFailure
                    ? () =>
                        setFailedUrls((prev) =>
                          prev.has(current.url) ? prev : new Set(prev).add(current.url),
                        )
                    : undefined
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

            {/* Prev / next: solid chips (no blur), so they read over any photo */}
            {hasPrev && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  goPrev();
                }}
                className={cn(ARROW, 'left-3 sm:left-5')}
                aria-label="Previous image"
              >
                <ChevronLeft className="size-5" />
              </button>
            )}
            {hasNext && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  goNext();
                }}
                className={cn(ARROW, 'right-3 sm:right-5')}
                aria-label="Next image"
              >
                <ChevronRight className="size-5" />
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

/** 44px wherever a finger is the pointer (below sm, or any coarse pointer at
 *  any width), 32px on a mouse. The coarse rule is an arbitrary variant so it
 *  is emitted after `sm:` and wins when both match. */
const TOUCH = 'h-11 sm:h-8 [@media(pointer:coarse)]:h-11';

/** A control group on the viewing surface: the theme's popover surface behind
 *  the stronger hairline (--line2), so it reads in light and dark alike. */
const CHIP =
  'flex items-center rounded-lg border border-[var(--ed-line-strong)] bg-popover text-popover-foreground';

/** Every control draws its focus ring inside itself, on its own popover
 *  surface: ink on white in light, near-white on the dark chip in dark. The
 *  global ring sits outside the control (a 2px offset in the page colour, then
 *  the ring), so in light its offset fell on the white chip and its ink ring
 *  on the black viewing surface, and keyboard focus on Close and the arrows
 *  showed nothing (DESIGN-SPEC 2.4 item 3: always keep a visible focus ring). */
const INSET_FOCUS_RING = 'focus-visible:ring-inset focus-visible:ring-offset-0';

const ARROW = cn(
  'absolute top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-lg border border-[var(--ed-line-strong)] bg-popover text-popover-foreground transition-colors hover:bg-muted',
  INSET_FOCUS_RING,
);

/** The icon-button recipe (DESIGN-SPEC 6.2): ink2 on transparent, the neutral
 *  hover fill; Delete keeps the destructive colour and its wash on hover. */
function toolClass(tone: 'default' | 'danger') {
  return cn(
    'grid place-items-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    INSET_FOCUS_RING,
    'size-11 sm:size-8 [@media(pointer:coarse)]:size-11',
    tone === 'danger'
      ? 'text-destructive hover:bg-destructive-wash'
      : 'text-[var(--ed-ink-2)] hover:bg-muted hover:text-foreground',
  );
}

function ToolbarButton({
  children,
  onClick,
  disabled,
  ariaLabel,
  tone = 'default',
  buttonRef,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  tone?: 'default' | 'danger';
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={toolClass(tone)}
    >
      {children}
    </button>
  );
}
