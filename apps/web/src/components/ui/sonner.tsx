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
 * variables on the toaster element instead of class names. Where a property has
 * no sonner variable (the shadow, the focus rings), the class carries a
 * trailing `!`, and an !important declaration beats sonner's normal one.
 * Stacking, swipe, actions, the close button, the screen-reader region and the
 * update-notice offset (globals.css lifts the toaster above the product-update
 * card) are all sonner's and unchanged.
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

/**
 * Sonner draws a toast's action button in --normal-text with --normal-bg words,
 * and its cancel words in --normal-text, whatever the toast's type. On the ink
 * toast that is right; on the pale warning and error washes the ink pair made
 * the cancel words near-white on the wash (unreadable: "Open it" on the SKU
 * taken error) and the action pill nearly the wash's colour. On those two the
 * pair is turned round, as sonner had it before the redesign: an ink pill with
 * on-ink words, and ink cancel words. Every toast with buttons in the app today
 * is an error toast. Only the buttons and their focus rings read this pair: the
 * warning and error toasts take their own fill, edge, text and close button
 * from the --warning-* and --error-* variables.
 */
const BUTTONS_ON_WASH =
  '[--normal-bg:hsl(var(--primary-foreground))] [--normal-text:hsl(var(--primary))]';

/**
 * The toast's shadow (DESIGN-SPEC 6.19), over sonner's lighter one. The focus
 * class keeps a ring when the toast itself is focused; globals.css's
 * :focus-visible ring also composes into this shadow, so the app's own ring
 * shows there.
 */
const TOAST_SHADOW =
  'shadow-[0_10px_30px_rgba(0,0,0,0.25)]! focus-visible:shadow-[0_10px_30px_rgba(0,0,0,0.25),0_0_0_2px_hsl(var(--ring))]!';

/**
 * The focus ring of the close, action and cancel buttons: a 2 px band in
 * --normal-bg, then a 2 px ring in --normal-text. On the ink toast that is a
 * gap in the toast's fill and a ring in its text colour; on the warning and
 * error washes (pair turned round above) an on-ink band and an ink ring. One
 * band always contrasts with what is behind it, including the part of the
 * close button that sits outside the toast. Sonner's own rings are black at 20%
 * and 40%, invisible on the ink toast (1.02:1 in light). It is a plain
 * box-shadow, not a shadow-[] utility: those put the app's ring variables
 * (set by globals.css :focus-visible) ahead of their own value, so the
 * page-coloured global ring would cover these bands, and on the ink toast the
 * action pill would only look 2 px larger.
 */
const BUTTON_FOCUS =
  'focus-visible:[box-shadow:0_0_0_2px_var(--normal-bg),0_0_0_4px_var(--normal-text)]!';

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
          toast: TOAST_SHADOW,
          warning: `${CLOSE_HOVER_WARNING} ${BUTTONS_ON_WASH}`,
          error: `${CLOSE_HOVER_ERROR} ${BUTTONS_ON_WASH}`,
          closeButton: BUTTON_FOCUS,
          actionButton: BUTTON_FOCUS,
          cancelButton: BUTTON_FOCUS,
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}
