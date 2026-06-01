import { NeedsAttentionHero } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Morning briefing — the LEAD. The greeting + action buttons already painted
 * in the page shell; this carries the data-driven briefing sentence + the
 * "where should I click right now" attention list.
 */
export function NeedsAttentionWidget({ attentionItems, briefingSentence }: DashboardWidgetProps) {
  return (
    <section className="mb-6">
      <p className="mb-4 text-[14px] text-[var(--ed-ink-3)]">{briefingSentence}</p>
      <NeedsAttentionHero items={attentionItems} />
    </section>
  );
}
