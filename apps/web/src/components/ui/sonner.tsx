'use client';

import { useTheme } from 'next-themes';
import type * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * The toast look (DESIGN-SPEC 6.19): the ink fill with the inverse ink text,
 * radius 8, Inter 13 / 500. Warnings and errors keep their own tone (the caution
 * and danger washes with their text colours), so an error still reads as one.
 *
 * Sonner injects its stylesheet unlayered, which beats every Tailwind utility
 * (those live in @layer utilities), so the look is set through sonner's own CSS
 * variables on the toaster element instead of class names. Stacking, swipe,
 * actions, the close button, the screen-reader region and the update-notice
 * offset (globals.css lifts the toaster above the product-update card) are all
 * sonner's and unchanged.
 */
const INK = 'hsl(var(--primary))';
const ON_INK = 'hsl(var(--primary-foreground))';

const TOAST_TOKENS = {
  fontFamily: 'var(--font-sans)',
  '--border-radius': '8px',
  '--normal-bg': INK,
  '--normal-border': INK,
  '--normal-text': ON_INK,
  '--success-bg': INK,
  '--success-border': INK,
  '--success-text': ON_INK,
  '--info-bg': INK,
  '--info-border': INK,
  '--info-text': ON_INK,
  '--warning-bg': 'hsl(var(--warning-wash))',
  '--warning-border': 'hsl(var(--warning) / 0.35)',
  '--warning-text': 'hsl(var(--warning))',
  '--error-bg': 'hsl(var(--destructive-wash))',
  '--error-border': 'hsl(var(--destructive) / 0.35)',
  '--error-text': 'hsl(var(--destructive))',
  // The close button's hover. Sonner paints it a pale grey in light and a dark
  // grey in dark, which hides the light X of an ink toast; it keeps the
  // toast's own fill instead (the warning and error toasts override these
  // below), and the ring takes the text colour.
  '--gray2': INK,
  '--gray5': ON_INK,
  '--normal-bg-hover': INK,
  '--normal-border-hover': ON_INK,
} as React.CSSProperties;

const CLOSE_HOVER_WARNING =
  '[--gray2:var(--warning-bg)] [--gray5:var(--warning-text)] [--normal-bg-hover:var(--warning-bg)] [--normal-border-hover:var(--warning-text)]';
const CLOSE_HOVER_ERROR =
  '[--gray2:var(--error-bg)] [--gray5:var(--error-text)] [--normal-bg-hover:var(--error-bg)] [--normal-border-hover:var(--error-text)]';

export function Toaster({ style, toastOptions, ...props }: ToasterProps) {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      position="bottom-right"
      richColors
      closeButton
      style={{ ...TOAST_TOKENS, ...style }}
      toastOptions={{
        ...toastOptions,
        style: { padding: '12px 16px', ...toastOptions?.style },
        classNames: {
          warning: CLOSE_HOVER_WARNING,
          error: CLOSE_HOVER_ERROR,
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}
