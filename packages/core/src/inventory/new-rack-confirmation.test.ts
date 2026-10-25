import { describe, expect, it } from 'vitest';

import {
  bulkCreateSizedVariantsSchema,
  createItemSchema,
  updateItemSchema,
} from '../schemas/inventory';
import { duplicateItemSchema } from '../schemas/duplicate-item';
import {
  bodyAnswersNewRack,
  NEW_RACK_REQUIRES_CONFIRMATION,
  newRackConfirmationDetail,
  parseNewRackConfirmationDetail,
} from './new-rack-confirmation';

/** DC4's racks, as the phone guard's own test has them (create-rack-check.test.ts). */
const DC4 = ['17-B', '18-B', '20-A', '22-A', '35', '35-A', '36-A'];

describe('newRackConfirmationDetail', () => {
  it('words the 2026-09-24 incident exactly as the phone does, near-matches first', () => {
    const detail = newRackConfirmationDetail({
      label: '1-B',
      warehouseName: 'DC4',
      quantity: 130,
      existingLabels: DC4,
    });
    expect(detail).toEqual({
      reason: NEW_RACK_REQUIRES_CONFIRMATION,
      label: '1-B',
      title: 'Create new rack 1-B?',
      message:
        '1-B does not exist in DC4 yet. Continuing creates it and moves 130 units into it. Did you mean 17-B or 18-B?',
      suggestions: ['17-B', '18-B'],
    });
  });

  it('says "1 unit", and leaves the warehouse out when its name is unknown', () => {
    const detail = newRackConfirmationDetail({
      label: '77-A',
      warehouseName: null,
      quantity: 1,
      existingLabels: [],
    });
    expect(detail?.message).toBe(
      '77-A does not exist yet. Continuing creates it and moves 1 unit into it.',
    );
    expect(detail?.suggestions).toEqual([]);
  });

  it('asks nothing when the rack is among the labels after all (case and spaces do not matter)', () => {
    expect(
      newRackConfirmationDetail({
        label: '17-b ',
        warehouseName: 'DC4',
        quantity: 5,
        existingLabels: DC4,
      }),
    ).toBeNull();
  });
});

describe('parseNewRackConfirmationDetail', () => {
  const detail = newRackConfirmationDetail({
    label: '1-B',
    warehouseName: 'DC4',
    quantity: 130,
    existingLabels: DC4,
  })!;

  it('reads back what the server sends, including over JSON', () => {
    expect(parseNewRackConfirmationDetail(detail)).toEqual(detail);
    expect(parseNewRackConfirmationDetail(JSON.parse(JSON.stringify(detail)))).toEqual(detail);
  });

  it('refuses anything that is not exactly the refusal, so no empty question can open', () => {
    expect(parseNewRackConfirmationDetail(null)).toBeNull();
    expect(parseNewRackConfirmationDetail('NEW_RACK_REQUIRES_CONFIRMATION')).toBeNull();
    expect(
      parseNewRackConfirmationDetail({
        ...detail,
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
      }),
    ).toBeNull();
    expect(parseNewRackConfirmationDetail({ ...detail, title: '' })).toBeNull();
    expect(parseNewRackConfirmationDetail({ ...detail, message: undefined })).toBeNull();
    expect(parseNewRackConfirmationDetail({ ...detail, label: 42 })).toBeNull();
  });

  it('keeps only real suggestions', () => {
    expect(
      parseNewRackConfirmationDetail({ ...detail, suggestions: ['17-B', '', 7, null] })
        ?.suggestions,
    ).toEqual(['17-B']);
    expect(parseNewRackConfirmationDetail({ ...detail, suggestions: 'x' })?.suggestions).toEqual(
      [],
    );
  });
});

describe('bodyAnswersNewRack (the key, not its value, says the client can be asked)', () => {
  it('a body without the key is a client from before the question', () => {
    expect(bodyAnswersNewRack({ name: 'Spiral notebook', binLocation: '1-B' })).toBe(false);
    expect(bodyAnswersNewRack(null)).toBe(false);
    expect(bodyAnswersNewRack('confirmNewRack')).toBe(false);
    expect(bodyAnswersNewRack([{ confirmNewRack: true }])).toBe(false);
  });

  it('a body with the key answers, whether yes or no', () => {
    expect(bodyAnswersNewRack({ confirmNewRack: true })).toBe(true);
    expect(bodyAnswersNewRack({ confirmNewRack: false })).toBe(true);
    expect(bodyAnswersNewRack(JSON.parse('{"confirmNewRack":false}'))).toBe(true);
  });
});

describe('the answer on the request schemas', () => {
  const ITEM = { name: 'Spiral notebook', quantityOnHand: 130, binLocation: '1-B' };

  it('a create carries it through, and leaves it out when it was not sent', () => {
    expect(createItemSchema.parse({ ...ITEM, confirmNewRack: true }).confirmNewRack).toBe(true);
    expect(createItemSchema.parse({ ...ITEM, confirmNewRack: false }).confirmNewRack).toBe(false);
    expect(createItemSchema.parse(ITEM)).not.toHaveProperty('confirmNewRack');
    expect(createItemSchema.safeParse({ ...ITEM, confirmNewRack: 'yes' }).success).toBe(false);
  });

  it('an edit never carries it (an edit is not a create)', () => {
    expect(updateItemSchema.parse({ binLocation: '1-B', confirmNewRack: true })).not.toHaveProperty(
      'confirmNewRack',
    );
  });

  it('a size run and a duplicated product carry it too', () => {
    const run = bulkCreateSizedVariantsSchema.parse({
      baseName: 'Team Shirt',
      baseSku: null,
      baseBarcode: null,
      description: null,
      categoryId: '11111111-1111-4111-8111-111111111111',
      supplierId: null,
      warehouseId: '22222222-2222-4222-8222-222222222222',
      charterId: null,
      primaryLocationId: null,
      binLocation: '1-B',
      retailPrice: 0,
      unitCost: 0,
      reorderPoint: 0,
      reorderQuantity: 0,
      variants: [{ size: 'M', quantity: 4 }],
      confirmNewRack: true,
    });
    expect(run.confirmNewRack).toBe(true);
    const dup = duplicateItemSchema.parse({
      originalId: '33333333-3333-4333-8333-333333333333',
      itemType: 'product',
      rackNumber: '1',
      rackRow: 'B',
      quantity: 4,
      confirmNewRack: true,
    });
    expect(dup).toMatchObject({ confirmNewRack: true });
  });
});
