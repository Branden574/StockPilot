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
 */
export function PdfDownloadDropdown({
  baseUrl,
  labels,
  note,
  disabledReason,
}: {
  baseUrl: string;
  labels?: { withImages: string; withoutImages: string };
  note?: string | null;
  disabledReason?: string | null;
}) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const noPhotosUrl = `${baseUrl}${sep}photos=0`;
  const reasonId = React.useId();
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
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
