'use client';

import { FileText, Image as ImageIcon, FileX2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Two-option PDF download button. Used on every report page. Clicking
 * "PDF" pops open a small dropdown with:
 *
 *   • With images  — default rich render. Pulls each row's primary
 *                    thumbnail (or transformed master, or
 *                    custom_fields.thumbnail_url for bulk-imported
 *                    books) and embeds them inline. Slightly slower.
 *   • Without images — appends `?photos=0` to the same route. Server
 *                      skips the image fetch phase entirely. Renders
 *                      in ~half the time, file size is smaller, great
 *                      for archival exports.
 *
 * The base URL is whatever the page already passes for the CSV/PDF
 * link (may already contain `?days=...`); this component appends the
 * `photos=0` query param with the right separator.
 *
 * Optional, for a report that needs them (Book Order Totals); every other
 * caller passes none and renders exactly as before:
 *   • `labels`: the two items' words ("PDF with covers" / "PDF without
 *     covers") in place of "With images" / "Without images".
 *   • `note`: a disclosure shown in the menu before anyone downloads, such
 *     as a cap on how many covers the file embeds.
 *   • `disabledReason`: the file cannot be made for this view (too many
 *     rows); the button is disabled and the reason is shown beside it.
 *   • `onDownload`: the page fetches the file itself (a plain click calls
 *     it with the item's URL instead of opening a tab), so a refusal can be
 *     said on the page. The items keep their real hrefs, so a new tab or a
 *     copied link still works.
 *   • `busy`: a file is being prepared; the button says so and does not
 *     open. It stays focusable (aria-disabled, not disabled), so focus can
 *     return to it when the menu closes.
 */
export function PdfDownloadDropdown({
  baseUrl,
  labels,
  note,
  disabledReason,
  onDownload,
  busy = false,
}: {
  baseUrl: string;
  labels?: { withImages: string; withoutImages: string };
  note?: string | null;
  disabledReason?: string | null;
  onDownload?: (href: string) => void;
  busy?: boolean;
}) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const noPhotosUrl = `${baseUrl}${sep}photos=0`;
  const reasonId = React.useId();
  // The menu's open state is held here so a plain click that the page takes
  // over can still close it. Radix closes a menu from the item's own click
  // handler, which it SKIPS when the click was default-prevented (its
  // composeEventHandlers), and preventDefault is what stops the link opening
  // a tab. Without the explicit close the menu stayed open after the file
  // arrived, with the page behind it locked (Radix's modal pointer lock and
  // aria-hidden) until Escape.
  const [open, setOpen] = React.useState(false);
  const intercept = (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onDownload) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    setOpen(false);
    onDownload(href);
  };
  if (disabledReason) {
    return (
      <div className="flex max-w-xs flex-col items-start gap-1">
        <Button variant="outline" disabled aria-describedby={reasonId}>
          <FileText className="h-4 w-4" /> PDF
        </Button>
        <p id={reasonId} className="text-muted-foreground text-xs">
          {disabledReason}
        </p>
      </div>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && !busy)}>
      <DropdownMenuTrigger asChild>
        {/* While busy the button is aria-disabled rather than disabled: the
            menu hands focus back to it on close, and a disabled button
            cannot take focus, so a keyboard user would land on the page
            body. onOpenChange above keeps it from opening meanwhile. */}
        <Button
          variant="outline"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          className={busy ? 'pointer-events-none opacity-50' : undefined}
        >
          <FileText className="h-4 w-4" /> PDF
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={note ? 'w-64' : 'w-56'}>
        {note ? (
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            {note}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuItem asChild>
          {/* target=_blank keeps the dashboard mounted so the PDF
              loads in a background tab — the user doesn't sit on a
              spinner while react-pdf renders. rel=noopener avoids
              giving the PDF tab a window.opener handle back. */}
          <a
            href={baseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer"
            onClick={intercept(baseUrl)}
          >
            <ImageIcon className="mr-2 h-4 w-4" />
            <span className="flex-1">{labels?.withImages ?? 'With images'}</span>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href={noPhotosUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer"
            onClick={intercept(noPhotosUrl)}
          >
            <FileX2 className="mr-2 h-4 w-4" />
            <div className="flex-1">
              <div>{labels?.withoutImages ?? 'Without images'}</div>
              <div className="text-muted-foreground text-[11px]">
                Faster · smaller file
              </div>
            </div>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
