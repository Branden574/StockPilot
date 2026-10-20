import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KeyValueList, KeyValueRow } from './key-value-row';

describe('KeyValueList / KeyValueRow', () => {
  it('is a description list: each label a term, each value its definition', () => {
    render(
      <KeyValueList>
        <KeyValueRow label="Reorder point">60 units</KeyValueRow>
        <KeyValueRow label="Unit cost">$8.75</KeyValueRow>
      </KeyValueList>,
    );
    const terms = screen.getAllByRole('term');
    const definitions = screen.getAllByRole('definition');
    expect(terms.map((t) => t.textContent)).toEqual(['Reorder point', 'Unit cost']);
    expect(definitions.map((d) => d.textContent)).toEqual(['60 units', '$8.75']);
    // Each pair shares one row wrapper inside the <dl>.
    const row = terms[0]!.parentElement!;
    expect(row.parentElement!.tagName).toBe('DL');
    expect(within(row).getByRole('definition')).toHaveTextContent('60 units');
  });

  it('puts the label quiet on the left and the value in ink on the right', () => {
    render(
      <KeyValueList>
        <KeyValueRow label="Lead time" valueClassName="font-mono">
          9 days
        </KeyValueRow>
      </KeyValueList>,
    );
    expect(screen.getByRole('term')).toHaveClass('text-muted-foreground');
    expect(screen.getByRole('definition')).toHaveClass(
      'text-foreground',
      'text-right',
      'font-mono',
    );
  });
});
