import { NeedsAttentionHero } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Morning briefing — the LEAD. The greeting + action buttons already painted
 * in the page shell; this carries the data-driven briefing sentence (in the
 * reference's subline place, right under the header when this widget comes
 * first) + the "where should I click right now" attention card.
 */
export function NeedsAttentionWidget({ attentionItems, briefingSentence }: DashboardWidgetProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <p className="text-muted-foreground text-[13.5px] leading-5">{briefingSentence}</p>
      <NeedsAttentionHero items={attentionItems} />
    </section>
  );
}
