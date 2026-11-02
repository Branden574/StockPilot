import { ASSISTANT_ISBN_LIMIT } from '@/lib/books/import-limits';

/**
 * The words the web AI Assistant uses for an attached file's ISBNs (docket
 * B76), kept out of the panel so they are tested without rendering it. A
 * plain module: no React, nothing client-only.
 */

/**
 * The chat message an attached file's ISBNs are sent as. The system prompt
 * (lib/ai/chat.ts, Bulk ISBN imports step 0) tells the model to look for its
 * first line and to preview the list at once, so it stays exactly as it was.
 */
export function buildUploadMessage(
  fileName: string,
  isbns: readonly string[],
  notes: string | undefined,
): string {
  return [
    `[Uploaded ${fileName} — extracted ${isbns.length} ISBN${isbns.length === 1 ? '' : 's'}${
      notes ? ` (${notes})` : ''
    }]`,
    '',
    ...isbns,
    '',
    'Please preview the bulk import for these ISBNs and tell me which warehouse + charter you need.',
  ].join('\n');
}

/**
 * The note when a file has more ISBNs than the assistant adds at a time:
 * nothing is sent, so it says where such a list goes instead. Bulk ISBN
 * import only for someone who can open it (the Books module and
 * items:import); anyone else is asked for a smaller file.
 */
export function tooManyIsbnsNote(count: number, canOpenBulkIsbnImport: boolean): string {
  const found = `Found ${count.toLocaleString('en-US')} ISBNs in this file. The assistant adds up to ${ASSISTANT_ISBN_LIMIT} at a time, so`;
  return canOpenBulkIsbnImport
    ? `${found} use Bulk ISBN import for this list.`
    : `${found} attach a file with ${ASSISTANT_ISBN_LIMIT} or fewer.`;
}
