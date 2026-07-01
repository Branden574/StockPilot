import { describe, expect, it } from 'vitest';
import { composeBookCustomFields } from './book-custom-fields';

const base = {
  existing: {} as Record<string, unknown> | null | undefined,
  customFieldDefKeys: [] as string[],
  customFieldValues: {} as Record<string, unknown>,
  author: '',
  rackNumber: '',
  rackRow: '',
  crateColor: '',
  crateNumber: '',
  grade: '',
};

describe('composeBookCustomFields', () => {
  it('sets crate color + number when both provided', () => {
    const cf = composeBookCustomFields({
      ...base,
      crateColor: 'red',
      crateNumber: '6',
    });
    expect(cf.book_crate_color).toBe('red');
    expect(cf.book_crate_number).toBe('6');
  });

  // The reported bug: switching the crate color back to "No crate" (empty)
  // must REMOVE the stored color, not leave the old one behind.
  it('clears the crate color when set back to none, keeping the number', () => {
    const cf = composeBookCustomFields({
      ...base,
      existing: { book_crate_color: 'red', book_crate_number: '6' },
      crateColor: '',
      crateNumber: '6',
    });
    expect('book_crate_color' in cf).toBe(false);
    expect(cf.book_crate_number).toBe('6');
  });

  it('clears the whole crate when both color and number are emptied', () => {
    const cf = composeBookCustomFields({
      ...base,
      existing: { book_crate_color: 'red', book_crate_number: '6' },
    });
    expect('book_crate_color' in cf).toBe(false);
    expect('book_crate_number' in cf).toBe(false);
  });

  it('clears rack, grade, and author when their inputs are emptied', () => {
    const cf = composeBookCustomFields({
      ...base,
      existing: {
        book_rack_number: '39',
        book_rack_row: 'B',
        book_grade: '11',
        author: 'Old Author',
      },
    });
    expect('book_rack_number' in cf).toBe(false);
    expect('book_rack_row' in cf).toBe(false);
    expect('book_grade' in cf).toBe(false);
    expect('author' in cf).toBe(false);
  });

  it('preserves keys the form does not own (e.g. isbn, size)', () => {
    const cf = composeBookCustomFields({
      ...base,
      existing: { isbn: '9780000000001', size: 'L', book_crate_color: 'red' },
      crateColor: '',
    });
    expect(cf.isbn).toBe('9780000000001');
    expect(cf.size).toBe('L');
    expect('book_crate_color' in cf).toBe(false);
  });

  it('drops a generic custom-field def key when it has no current value', () => {
    const cf = composeBookCustomFields({
      ...base,
      existing: { color_swatch: 'blue' },
      customFieldDefKeys: ['color_swatch'],
      customFieldValues: {},
    });
    expect('color_swatch' in cf).toBe(false);
  });

  it('re-adds a generic custom-field value from the current form state', () => {
    const cf = composeBookCustomFields({
      ...base,
      existing: { color_swatch: 'blue' },
      customFieldDefKeys: ['color_swatch'],
      customFieldValues: { color_swatch: 'green' },
    });
    expect(cf.color_swatch).toBe('green');
  });

  it('uppercases the rack row and trims whitespace', () => {
    const cf = composeBookCustomFields({
      ...base,
      rackNumber: ' 39 ',
      rackRow: ' b ',
      author: '  Jane  ',
      crateNumber: ' 6 ',
    });
    expect(cf.book_rack_number).toBe('39');
    expect(cf.book_rack_row).toBe('B');
    expect(cf.author).toBe('Jane');
    expect(cf.book_crate_number).toBe('6');
  });
});
