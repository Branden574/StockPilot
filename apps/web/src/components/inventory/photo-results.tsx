'use client';

import { CircleAlert, CloudOff } from 'lucide-react';

/**
 * WHAT BECAME OF EACH PHOTO OF A PICK, IN THE PAGE (lab walk 6, W6-F2).
 *
 * The item photo uploader and the new-item form used to tell each photo that
 * was not added in a toast of its own, and then the batch's summary in
 * another: the summary was drawn on top, and the refused photo's sentence
 * showed only when the toast stack was hovered or tapped. Each photo not
 * added is now listed in the page, under the uploader, with its own plain
 * sentence, in a polite status region; the toast only counts, and points
 * here.
 *
 * The new-item form goes on to the new item's page after it saves, so it
 * hands its results to that page's uploader (handPhotoResultsTo), which shows
 * them once when it opens. Kept in this module, in memory: the form moves to
 * the page within the app, so nothing is written anywhere, and a reload or a
 * second visit shows nothing old.
 */

/** One photo of a pick: added, refused (by the server or its limits), or not sent. */
export type PhotoResult =
  | { name: string; outcome: 'added' }
  | { name: string; outcome: 'refused' | 'unsent'; sentence: string };

interface PhotoCounts {
  added: number;
  refused: number;
  unsent: number;
}

function countsOf(results: readonly PhotoResult[]): PhotoCounts {
  const count = (o: PhotoResult['outcome']) => results.filter((r) => r.outcome === o).length;
  return { added: count('added'), refused: count('refused'), unsent: count('unsent') };
}

const photos = (n: number) => `${n} ${n === 1 ? 'photo' : 'photos'}`;

/** True when some photo of the pick was not added: only then is anything put in the page. */
function somePhotoNotAdded(results: readonly PhotoResult[]): boolean {
  return results.some((r) => r.outcome !== 'added');
}

/**
 * The toast's short last word: counts only, never a photo's sentence (that is
 * in the page). `where` names the place the list is, from the toast's page.
 */
export function photoResultsToast(
  results: readonly PhotoResult[],
  where = 'below',
): { tone: 'success' | 'warning' | 'error'; text: string } {
  const { added, refused, unsent } = countsOf(results);
  if (refused === 0 && unsent === 0) return { tone: 'success', text: `${photos(added)} added.` };
  const notAdded = [refused > 0 ? `${refused} refused` : null, unsent > 0 ? `${unsent} not sent` : null]
    .filter((part): part is string => part !== null)
    .join(', ');
  if (added === 0) return { tone: 'error', text: `No photos added. ${notAdded}: see ${where}.` };
  return { tone: 'warning', text: `${photos(added)} added, ${notAdded}: see ${where}.` };
}

/** The list's first line: how many were added, refused and not sent. */
function countsLine({ added, refused, unsent }: PhotoCounts): string {
  return [
    added > 0 ? `${photos(added)} added.` : 'No photos added.',
    refused > 0 ? `${refused} refused.` : null,
    unsent > 0 ? `${unsent} not sent.` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
}

/**
 * The status region, always in the page so a screen reader hears it fill,
 * and empty unless some photo was not added (an all-added pick moves nothing
 * on the page). In the flow, under the uploader: nothing in it or around it is
 * positioned, so nothing can be drawn over it, at any width.
 */
export function PhotoResultsList({ results }: { results: readonly PhotoResult[] }) {
  const shown = somePhotoNotAdded(results);
  return (
    <div role="status" aria-live="polite" data-slot="photo-results" className="min-w-0">
      {shown ? (
        <div className="border-border bg-card rounded-lg border text-[12.5px] leading-[18px]">
          <p className="px-3 pt-2.5 pb-1.5 font-medium">{countsLine(countsOf(results))}</p>
          <ul className="divide-border border-border divide-y border-t">
            {results.map((r, i) =>
              r.outcome === 'added' ? null : (
                <li key={`${i}:${r.name}`} data-outcome={r.outcome} className="flex items-start gap-2 px-3 py-2">
                  {r.outcome === 'refused' ? (
                    <CircleAlert aria-hidden className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <CloudOff aria-hidden className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="break-words">
                      <span className="font-medium">{r.name}</span>
                      <span className="text-muted-foreground">
                        {' · '}
                        {r.outcome === 'refused' ? 'Refused' : 'Not sent'}
                      </span>
                    </p>
                    <p className="text-foreground break-words">{r.sentence}</p>
                  </div>
                </li>
              ),
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Results the new-item form hands to the new item's page, by item id. */
const handedOver = new Map<string, PhotoResult[]>();

/** The new-item form: what became of this item's photos, for its page to show once. */
export function handPhotoResultsTo(itemId: string, results: readonly PhotoResult[]): void {
  if (typeof window === 'undefined') return;
  handedOver.set(itemId, [...results]);
}

/** The item page's uploader, as it opens: what the form handed it, if anything. */
export function photoResultsHandedTo(itemId: string): PhotoResult[] {
  if (typeof window === 'undefined') return [];
  return handedOver.get(itemId) ?? [];
}

/** Once shown, never again. */
export function forgetPhotoResultsHandedTo(itemId: string): void {
  handedOver.delete(itemId);
}
