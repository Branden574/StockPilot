'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

/**
 * Hover-anchored image preview popover. Wraps a small thumbnail
 * trigger; after a short delay on mouseenter, renders the full-size
 * image (signed URL is already the original upload, not a crop) plus
 * optional metadata in a portal anchored next to the trigger.
 *
 * Why portal + manual positioning instead of @radix-ui/react-hover-card:
 * the existing thumbnails sit inside scrollable tables with
 * `overflow-hidden` on parents. Radix HoverCard would clip against
 * those ancestors; rendering into document.body via portal escapes
 * cleanly. Manual positioning lets us flip left/right based on
 * viewport space without pulling in another Radix dep.
 *
 * Touch devices: hover events fire weirdly on touch (a "ghost hover"
 * after tap that sticks). We detect via the pointer media query and
 * skip the preview entirely on coarse pointers — the user already
 * has the click-through to the item detail page.
 */

const OPEN_DELAY_MS = 220;
const CLOSE_DELAY_MS = 120;
const PREVIEW_SIZE = 280;
const GAP_FROM_TRIGGER = 12;

export interface ImageHoverPreviewProps {
  /** Full-resolution image URL. When null/undefined, no preview is shown
   *  — the trigger renders without any hover behavior attached. */
  src: string | null | undefined;
  /** Required alt text for the floating preview's <img>. */
  alt: string;
  /** Optional title shown in the preview footer. */
  title?: string | null;
  /** Optional sub-line under the title (sku, author, etc.). */
  subtitle?: string | null;
  /** Optional extra meta line (on-hand qty, status, etc.). */
  meta?: React.ReactNode;
  /** The trigger element — usually the thumbnail itself. */
  children: React.ReactElement;
  /** Tailwind classes added to the trigger wrapper. */
  className?: string;
}

export function ImageHoverPreview({
  src,
  alt,
  title,
  subtitle,
  meta,
  children,
  className,
}: ImageHoverPreviewProps) {
  const [mounted, setMounted] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [coords, setCoords] = React.useState<{
    top: number;
    left: number;
    flipped: boolean;
  } | null>(null);
  const triggerRef = React.useRef<HTMLSpanElement | null>(null);
  const openTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCoarsePointer = React.useRef(false);

  React.useEffect(() => {
    setMounted(true);
    if (typeof window !== 'undefined' && window.matchMedia) {
      isCoarsePointer.current = window.matchMedia('(pointer: coarse)').matches;
    }
    return () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const compute = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Default: anchor to the right of the trigger, vertically centered
    // on the row. If the preview would clip the right edge, flip to
    // the left side of the trigger.
    const rightSpace = vw - rect.right;
    const flipped = rightSpace < PREVIEW_SIZE + GAP_FROM_TRIGGER + 16;
    const left = flipped
      ? Math.max(8, rect.left - PREVIEW_SIZE - GAP_FROM_TRIGGER)
      : Math.min(vw - PREVIEW_SIZE - 8, rect.right + GAP_FROM_TRIGGER);
    // Vertical: try to center on the row but clamp to the viewport.
    const idealTop = rect.top + rect.height / 2 - PREVIEW_SIZE / 2;
    const top = Math.max(
      8,
      Math.min(vh - PREVIEW_SIZE - 80, idealTop),
    );
    setCoords({ top, left, flipped });
  }, []);

  function scheduleOpen() {
    if (!src || isCoarsePointer.current) return;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openTimerRef.current || open) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      compute();
      setOpen(true);
    }, OPEN_DELAY_MS);
  }

  function scheduleClose() {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current || !open) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setCoords(null);
    }, CLOSE_DELAY_MS);
  }

  // Track scroll/resize while open so the preview tracks the trigger
  // if the table scrolls. Listening only while open keeps the cost off
  // the hundreds of idle thumbnails on the page.
  React.useEffect(() => {
    if (!open) return;
    const onScrollResize = () => compute();
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    return () => {
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
    };
  }, [open, compute]);

  const trigger = (
    <span
      ref={triggerRef}
      className={cn('inline-flex', className)}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
    >
      {children}
    </span>
  );

  // No image OR not mounted on the client yet: just render the trigger
  // pass-through.
  if (!src || !mounted) return trigger;

  return (
    <>
      {trigger}
      {open && coords
        ? createPortal(
            <div
              role="tooltip"
              aria-label={alt}
              className="pointer-events-none fixed z-[60] animate-in fade-in zoom-in-95 duration-150"
              style={{
                top: coords.top,
                left: coords.left,
                width: PREVIEW_SIZE,
              }}
            >
              <div className="border-border bg-background overflow-hidden rounded-lg border shadow-2xl">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt={alt}
                  className="block h-[280px] w-full bg-muted object-contain"
                  draggable={false}
                />
                {(title || subtitle || meta) && (
                  <div className="border-border border-t px-3 py-2.5">
                    {title ? (
                      <div className="text-foreground truncate text-sm font-medium">
                        {title}
                      </div>
                    ) : null}
                    {subtitle ? (
                      <div className="text-muted-foreground truncate font-mono text-[11px]">
                        {subtitle}
                      </div>
                    ) : null}
                    {meta ? (
                      <div className="text-muted-foreground mt-1.5 text-[11.5px]">
                        {meta}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
