import { DetailSection } from '@/components/patterns/detail-section';
import { liquidGlassRollout } from '@/components/theme/appearance-flag';

/**
 * The requester's note in the side column, where Liquid Glass draws it
 * (Order-Detail.dc.html: the aside holds Dates, Details and the requester
 * note). The plan's slot-frame rule for a stateless block (plan 4.6): the
 * note is words only (no link, button or field), so glass may show it in the
 * drawn place as a glass-only copy, while the main column's note carries
 * data-classic-only and is hidden in glass. Exactly one of the two is shown
 * in either design, so the page holds the note, and its heading, once.
 *
 * Rendered only when the page renders the main column's note (the same
 * `notes` truthiness), never under the `off` rollout. It sits between Dates
 * and Details in the DOM, a <div> among sections, so no Classic element
 * changes its place among its siblings; order-detail.css draws it after
 * Details. Listed in tests/e2e/appearance/glass-only-allowlist.json
 * ("moved block (no action)").
 */
export function OrderRequesterNoteAside({ notes }: { notes: string | null | undefined }) {
  if (liquidGlassRollout() === 'off' || !notes) return null;
  return (
    <div data-glass-only="" data-glass="order-requester-note-aside">
      <DetailSection title="Requester note" data-glass-role="order-requester-note">
        <p className="whitespace-pre-wrap text-[13.5px]">{notes}</p>
      </DetailSection>
    </div>
  );
}
