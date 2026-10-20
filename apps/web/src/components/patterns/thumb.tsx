import * as React from 'react';

import { cn } from '@/lib/utils';

import { MissingPhoto } from './missing-photo';
import { PatternPhoto } from './photo';

/**
 * A fixed-size thumbnail frame (DESIGN-SPEC 4 and 6.14): white tile in both
 * themes (photos shot on white read the same either way), 1 px hairline,
 * declared sizes as border-box outer sizes. The photo covers the frame; with
 * no photo the hatch shows.
 *
 * Pass `children` to put the caller's own image element in the frame (a
 * next/image with its LQIP blur, an ImageHoverPreview around it); otherwise
 * `src` / `alt` render a plain lazy image with the failure fallback.
 */
export type ThumbSize = 22 | 28 | 30 | 32 | 34 | 56 | 64;

const SIZE: Record<ThumbSize, string> = {
  22: 'size-[22px] rounded-[5px]',
  28: 'size-7 rounded-[5px]',
  30: 'size-[30px] rounded-md',
  32: 'size-8 rounded-md',
  34: 'size-[34px] rounded-md',
  56: 'size-14 rounded-[10px]',
  64: 'size-16 rounded-lg',
};

export interface ThumbProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  size?: ThumbSize;
  src?: string | null;
  alt?: string;
  children?: React.ReactNode;
}

export function Thumb({ size = 34, src, alt = '', children, className, ...props }: ThumbProps) {
  return (
    <span
      data-slot="thumb"
      className={cn(
        'border-border relative block shrink-0 overflow-hidden border bg-white',
        SIZE[size],
        className,
      )}
      {...props}
    >
      {children ??
        (src ? (
          <PatternPhoto src={src} alt={alt} fit="cover" />
        ) : (
          <MissingPhoto className="absolute inset-0" />
        ))}
    </span>
  );
}
