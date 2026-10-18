import { render, screen, within } from '@testing-library/react';
import { Truck } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { DeltaText, Timeline, TimelineEntry, TimelineLabel, TimelineRow } from './timeline';

describe('Timeline (rail)', () => {
  it('is an ordered list of entries with their title, meta, details and figure', () => {
    render(
      <Timeline aria-label="Order history">
        <TimelineEntry title="Order submitted" meta="Ana Ruiz · Oct 14, 4:12 PM">
          <p>2 lines requested.</p>
        </TimelineEntry>
        <TimelineEntry
          title="In transit"
          meta="Jordan Lee"
          tone="accent"
          icon={<Truck />}
          aside={<DeltaText value={-36}>−36</DeltaText>}
        />
      </Timeline>,
    );
    const list = screen.getByRole('list', { name: 'Order history' });
    expect(list.tagName).toBe('OL');
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Order submitted');
    expect(entries[0]).toHaveTextContent('Ana Ruiz · Oct 14, 4:12 PM');
    expect(entries[0]).toHaveTextContent('2 lines requested.');
    expect(entries[1]).toHaveTextContent('−36');
  });

  it('draws the marker as decoration: a tone dot, or the icon in a tone circle', () => {
    const { container } = render(
      <Timeline>
        <TimelineEntry title="Approved" tone="warning" />
        <TimelineEntry title="Delivered" tone="accent" icon={<Truck data-testid="icon" />} />
      </Timeline>,
    );
    const markers = container.querySelectorAll('[data-slot="timeline-marker"]');
    expect(markers).toHaveLength(2);
    for (const m of markers) expect(m).toHaveAttribute('aria-hidden');
    expect(markers[0]!.querySelector('.bg-warning')).not.toBeNull();
    expect(markers[1]).toHaveClass('bg-success-wash');
    expect(within(markers[1] as HTMLElement).getByTestId('icon')).toBeInTheDocument();
  });

  it('joins entries with a rail that stops at the first and last markers and hides on a lone entry', () => {
    const { container } = render(
      <Timeline>
        <TimelineEntry title="Only event" />
      </Timeline>,
    );
    const rail = container.querySelector('[data-slot="timeline-rail"]')!;
    expect(rail).toHaveAttribute('aria-hidden');
    expect(rail.className).toContain('group-first/entry:top-3.5');
    expect(rail.className).toContain('group-last/entry:h-3.5');
    expect(rail.className).toContain('group-only/entry:hidden');
  });
});

describe('Timeline (rows)', () => {
  it('renders activity rows: the text left, the figure right', () => {
    render(
      <Timeline variant="rows" aria-label="Recent activity">
        <TimelineRow
          title={
            <>
              <TimelineLabel tone="accent">Receive</TimelineLabel> · L4L Polo — Men’s
            </>
          }
          meta="Jordan Lee · Today, 3:40 PM"
          aside={<DeltaText value={120}>+120</DeltaText>}
        />
      </Timeline>,
    );
    const list = screen.getByRole('list', { name: 'Recent activity' });
    expect(list).toHaveAttribute('data-variant', 'rows');
    const row = within(list).getByRole('listitem');
    expect(row).toHaveTextContent('Receive · L4L Polo — Men’s');
    expect(row).toHaveTextContent('Jordan Lee · Today, 3:40 PM');
    expect(screen.getByText('Receive')).toHaveClass('font-medium', 'text-accent');
  });
});

describe('DeltaText', () => {
  it('picks the tone from the sign: accent up, ink 2 down (or destructive), muted at zero', () => {
    const { rerender } = render(<DeltaText value={2}>+2</DeltaText>);
    expect(screen.getByText('+2')).toHaveClass('text-accent', 'font-mono');
    rerender(<DeltaText value={-3}>−3</DeltaText>);
    expect(screen.getByText('−3').className).toContain('text-[var(--ed-ink-2)]');
    rerender(
      <DeltaText value={-3} negativeTone="destructive">
        −3
      </DeltaText>,
    );
    expect(screen.getByText('−3')).toHaveClass('text-destructive');
    rerender(<DeltaText value={0}>0</DeltaText>);
    expect(screen.getByText('0')).toHaveClass('text-muted-foreground');
  });
});
