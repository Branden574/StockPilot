/**
 * Class names shared by the glass marketing twins. Each element carries the
 * glass hook class (lgs-*, styled by styles/liquid-glass/pages/site.css under
 * the glass root) and a few utilities that keep it readable on classic CSS,
 * which is what a visitor without JavaScript gets (R8, accepted).
 */

const BUTTON_BASE =
  'lgs-btn inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold no-underline';

const BUTTON_SIZE = {
  md: 'lgs-md h-9 px-3.5 text-sm',
  lg: 'lgs-lg h-11 px-[18px] text-[15px]',
  xl: 'lgs-xl h-[52px] px-[22px] text-base',
} as const;

const BUTTON_KIND = {
  primary: 'lgs-btn-primary bg-foreground text-background',
  secondary: 'lgs-btn-secondary border border-border bg-card text-foreground',
  glass: 'lgs-btn-glass border border-border text-foreground',
  ghost: 'lgs-btn-ghost text-foreground',
} as const;

export type ButtonKind = keyof typeof BUTTON_KIND;
export type ButtonSize = keyof typeof BUTTON_SIZE;

/** A link drawn as one of the board's buttons (btn-primary, btn-glass, ...). */
export function buttonClass(kind: ButtonKind, size: ButtonSize = 'md', pill = true): string {
  return [
    BUTTON_BASE,
    BUTTON_SIZE[size],
    BUTTON_KIND[kind],
    pill ? 'lgs-pill rounded-full' : 'rounded-xl',
  ].join(' ');
}

/** The board's text link (.link): accent text, underlined. */
export const LINK_CLASS = 'lgs-a underline underline-offset-2';
