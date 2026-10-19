import { TriangleAlert } from 'lucide-react';

import { StopActingAsButton } from './stop-acting-as-button';

/**
 * The caution strip a platform admin sees at the top of every dashboard page
 * while acting as another organization (matrix W-SH-06b). The warning is
 * carried by the words and an icon, never by colour alone; the icon replaces
 * the old "⚠" glyph (owner rule: no emoji or glyph art in UI copy) and is
 * hidden from screen readers, which read the sentence.
 *
 * Presentational only: ImpersonationBanner decides whether it renders.
 */
export function ImpersonationStrip() {
  return (
    <div
      data-slot="impersonation-banner"
      className="border-warning/40 bg-warning-wash text-foreground flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2 text-[13px]"
    >
      <span className="flex min-w-0 items-start gap-2 font-medium">
        <TriangleAlert
          className="text-warning mt-0.5 h-4 w-4 shrink-0"
          strokeWidth={2}
          aria-hidden
        />
        <span>
          You are acting as another organization — you are viewing and editing their live data.
        </span>
      </span>
      <StopActingAsButton />
    </div>
  );
}
