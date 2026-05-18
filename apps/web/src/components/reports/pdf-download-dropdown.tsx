'use client';

import { FileText, Image as ImageIcon, FileX2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
 */
export function PdfDownloadDropdown({ baseUrl }: { baseUrl: string }) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const noPhotosUrl = `${baseUrl}${sep}photos=0`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <FileText className="h-4 w-4" /> PDF
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
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
            <span className="flex-1">With images</span>
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
              <div>Without images</div>
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
