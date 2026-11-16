import { describe, expect, it } from 'vitest';

import { editedOptionalText } from './edited-optional-text';

describe('editedOptionalText', () => {
  it('sends text as it is', () => {
    expect(editedOptionalText('Dana', 'Kim')).toBe('Dana');
    expect(editedOptionalText('Dana', null)).toBe('Dana');
    expect(editedOptionalText('Dana', undefined)).toBe('Dana');
  });

  it('sends an emptied field that had text as cleared', () => {
    expect(editedOptionalText('', 'Kim')).toBe('');
  });

  it('leaves out a field that had no text and is still empty', () => {
    expect(editedOptionalText('', null)).toBeUndefined();
    expect(editedOptionalText('', '')).toBeUndefined();
    expect(editedOptionalText(undefined, null)).toBeUndefined();
  });

  it('on a new record (nothing before) leaves out an empty field', () => {
    expect(editedOptionalText('', undefined)).toBeUndefined();
  });
});
