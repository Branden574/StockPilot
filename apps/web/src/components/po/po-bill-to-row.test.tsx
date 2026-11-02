import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KeyValueList } from '@/components/patterns/key-value-row';

import { PoBillToRow } from './po-bill-to-row';

/**
 * B56: the PO page's Summary names the charter the purchase order is billed
 * to, with the PDF's own line ("North Campus (NC)") under its label, Bill to.
 * A charter archived since keeps its name and says so in a quiet mark. A read
 * that failed says so; a purchase order billed to no charter has no row, as
 * the PDF prints none.
 */
const C = '0b000000-0000-4000-8000-0000000000c1';
const found = (over: Record<string, unknown> = {}) => ({
  state: 'found' as const,
  charter: { id: C, name: 'North Campus', code: 'NC', status: 'active', ...over },
});

function renderRow(read: Parameters<typeof PoBillToRow>[0]['read']) {
  return render(
    <KeyValueList>
      <PoBillToRow read={read} />
    </KeyValueList>,
  );
}

function pair(container: HTMLElement) {
  const dts = container.querySelectorAll('dt');
  expect(dts).toHaveLength(1);
  return [dts[0]!.textContent, dts[0]!.nextElementSibling?.textContent];
}

describe('PoBillToRow', () => {
  it('names an active charter as the PDF does', () => {
    const { container } = renderRow(found());
    expect(pair(container)).toEqual(['Bill to', 'North Campus (NC)']);
  });

  it('marks an archived charter, the mark in its own muted span', () => {
    const { container } = renderRow(found({ status: 'archived' }));
    expect(pair(container)).toEqual(['Bill to', 'North Campus (NC) (archived)']);
    const mark = screen.getByText('(archived)');
    expect(mark.tagName).toBe('SPAN');
    expect(mark).toHaveClass('text-muted-foreground');
  });

  it('marks an inactive charter, and prints the name alone with no code', () => {
    const inactive = renderRow(found({ status: 'inactive' }));
    expect(pair(inactive.container)).toEqual(['Bill to', 'North Campus (NC) (inactive)']);
    inactive.unmount();
    const noCode = renderRow(found({ code: null }));
    expect(pair(noCode.container)).toEqual(['Bill to', 'North Campus']);
  });

  it('says a read that failed, muted', () => {
    const { container } = renderRow({ state: 'unreadable', charterId: C });
    expect(pair(container)).toEqual(['Bill to', 'Could not be loaded']);
    expect(screen.getByText('Could not be loaded')).toHaveClass('text-muted-foreground');
  });

  it('renders nothing for a purchase order billed to no charter, or no read', () => {
    for (const read of [{ state: 'none' as const }, null]) {
      const { container, unmount } = renderRow(read);
      expect(container.querySelectorAll('dt')).toHaveLength(0);
      expect(container.querySelector('dl')?.textContent).toBe('');
      unmount();
    }
  });
});
