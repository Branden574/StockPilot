import {
  BookOpen,
  Cable,
  CupSoda,
  HardHat,
  Highlighter,
  NotebookText,
  Shirt,
  Stethoscope,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { ThumbKind } from './data';

/**
 * Small pieces the landing's product previews are drawn with. Every preview is
 * decoration over demo data: its container is one labelled image
 * ("Product preview with demo data") and everything inside is hidden from
 * assistive technology, so a screen reader hears the page's words, not a fake
 * table.
 */

const THUMB_ICON: Record<ThumbKind, LucideIcon> = {
  shirt: Shirt,
  book: BookOpen,
  vest: HardHat,
  bottle: CupSoda,
  planner: NotebookText,
  charger: Cable,
  kit: Stethoscope,
  marker: Highlighter,
};

/** A product photo stand-in: a tinted tile with the product's kind as an icon. */
export function Thumb({ kind, size = 'md' }: { kind: ThumbKind; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = THUMB_ICON[kind];
  return (
    <span className={`lgl-thumb lgl-thumb-${size} lgl-kind-${kind}`}>
      <Icon aria-hidden="true" />
    </span>
  );
}

/** A status badge with its dot (b-warn, b-ok, b-accent, b-outline). */
export function Badge({
  tone,
  dot = false,
  children,
}: {
  tone: string;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`lgl-badge lgl-tone-${tone}`}>
      {dot ? <span className="lgl-dot" /> : null}
      {children}
    </span>
  );
}

/** A labelled preview frame: one image to assistive technology. */
export function Preview({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={className} role="img" aria-label="Product preview with demo data">
      <div aria-hidden="true" className="contents">
        {children}
      </div>
    </div>
  );
}
