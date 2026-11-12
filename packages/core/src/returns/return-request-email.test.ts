import { describe, expect, it } from 'vitest';

import { DRAFT_URL_LIMIT } from '../email/outlook-compose';
import { deliveryRequestRecipients } from '../orders/delivery-request';
import type { RequesterTrackingReturn } from './requester-exchange-types';
import {
  RETURN_REQUEST_CONDENSED_DISCLOSURE,
  RETURN_REQUEST_COPY,
  RETURN_REQUEST_SENDABLE_STATUSES,
  buildReturnRequestDraft,
  canSendReturnRequest,
  isReturnNumberShape,
  prepareReturnRequestEmail,
  returnRequestContentFromTracking,
  returnRequestContentFromWorkbench,
  type ReturnRequestEmailContent,
  type ReturnRequestEmailInput,
} from './return-request-email';

// Reserved test domains only: no test may hold a real mailbox.
const RECIPIENTS = deliveryRequestRecipients({
  to: 'intake@warehouse.test',
  cc: 'copy@warehouse.test',
  toName: 'Warehouse Intake',
  ccName: 'Warehouse Copy',
});

const CONTENT: ReturnRequestEmailContent = {
  returnNumber: 'RMA-20261110-AB12CD',
  orderNumber: 'SO-000085',
  status: 'requested',
  reasonCode: 'damaged',
  requestedBy: 'Sample Requester',
  requesterEmail: 'requester@school.test',
  site: {
    id: 's1',
    name: 'North Campus',
    code: 'NC',
    address: { line1: '1 Example Way', city: 'Sampletown', region: 'CA', postalCode: '90000' },
  },
  warehouseName: 'Main Warehouse',
  items: [
    { text: 'Staff Polo, M ×2', sku: 'POLO-M', replacement: 'Staff Polo, L ×2' },
    { text: 'Lanyard ×1', sku: null, replacement: null },
  ],
  link: 'https://app.example.test/dashboard/returns/00000000-0000-4000-8000-000000000001',
};

const input = (over: Partial<ReturnRequestEmailContent> = {}): ReturnRequestEmailInput => ({
  ...CONTENT,
  ...over,
  recipients: RECIPIENTS,
});

describe('buildReturnRequestDraft', () => {
  it('writes the subject and one fact per line, in order', () => {
    const d = buildReturnRequestDraft(input());
    expect(d.to).toBe('intake@warehouse.test');
    expect(d.cc).toBe('copy@warehouse.test');
    expect(d.toName).toBe('Warehouse Intake');
    expect(d.subject).toBe('Return Request — RMA-20261110-AB12CD (SO-000085)');
    expect(d.condensed).toBe(false);
    expect(d.body.split('\n')).toEqual([
      'Return request',
      '',
      'Return: RMA-20261110-AB12CD',
      'Order: SO-000085',
      'Status: Requested',
      'Reason: Damaged',
      'Requested by: Sample Requester, requester@school.test',
      'Site: North Campus (NC)',
      '1 Example Way',
      'Sampletown, CA 90000',
      'Warehouse: Main Warehouse',
      '',
      'Items coming back:',
      '- Staff Polo, M ×2 (SKU POLO-M)',
      '- Lanyard ×1',
      '',
      'Replacement:',
      '- Staff Polo, L ×2',
      '',
      'Open in StockPilot:',
      'https://app.example.test/dashboard/returns/00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('leaves out every line that has no value', () => {
    const d = buildReturnRequestDraft(
      input({
        orderNumber: null,
        reasonCode: null,
        requestedBy: null,
        requesterEmail: null,
        site: null,
        warehouseName: null,
        link: null,
        items: [{ text: 'Lanyard ×1', sku: null, replacement: null }],
      }),
    );
    expect(d.subject).toBe('Return Request — RMA-20261110-AB12CD');
    expect(d.body.split('\n')).toEqual([
      'Return request',
      '',
      'Return: RMA-20261110-AB12CD',
      'Status: Requested',
      '',
      'Items coming back:',
      '- Lanyard ×1',
    ]);
  });

  it('prints the email alone when there is no name', () => {
    const d = buildReturnRequestDraft(input({ requestedBy: null }));
    expect(d.body).toContain('Requested by: requester@school.test');
  });

  it('cannot carry notes, a denial reason or a cost: the content type has no such field', () => {
    // A staff payload passed whole must not leak: the builder reads only its
    // own named fields.
    const leaky = {
      ...input(),
      notes: 'STAFF NOTE',
      denialReason: 'DENIAL TEXT',
      unitCost: 12.34,
    } as ReturnRequestEmailInput;
    const p = prepareReturnRequestEmail(leaky);
    for (const text of [p.draft.body, p.draft.subject, p.clipboardText]) {
      expect(text).not.toContain('STAFF NOTE');
      expect(text).not.toContain('DENIAL TEXT');
      expect(text).not.toContain('12.34');
    }
  });

  it('collapses line breaks in every value, so no value can forge a line', () => {
    const d = buildReturnRequestDraft(
      input({
        returnNumber: 'RMA-1\nBcc: x@evil.test',
        requestedBy: 'A\r\nCc: y@evil.test',
        items: [{ text: 'Polo\nBcc: z@evil.test', sku: 'S\nK', replacement: 'R\nX' }],
      }),
    );
    const lines = d.body.split('\n');
    expect(lines.some((l) => /^(Bcc|Cc):/i.test(l))).toBe(false);
    expect(d.subject).not.toContain('\n');
    expect(d.body).toContain('- Polo Bcc: z@evil.test (SKU S K)');
  });

  it('refuses recipients that are not routable addresses', () => {
    expect(() =>
      buildReturnRequestDraft({
        ...CONTENT,
        recipients: { to: 'not-an-address', cc: 'copy@warehouse.test' } as never,
      }),
    ).toThrow();
  });
});

describe('prepareReturnRequestEmail', () => {
  it('a short return fits whole and every link carries the same draft', () => {
    const p = prepareReturnRequestEmail(input());
    expect(p.linkFits).toBe(true);
    expect(p.draft.condensed).toBe(false);
    expect(p.transport).toBe('outlook-web');
    expect(p.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(p.outlookUrl).toContain('outlook.cloud.microsoft');
    expect(p.outlookMobileUrl.startsWith('ms-outlook://compose?')).toBe(true);
    expect(p.mailtoUrl.startsWith('mailto:intake%40warehouse.test?') || p.mailtoUrl.startsWith('mailto:intake@warehouse.test?')).toBe(true);
    expect(decodeURIComponent(p.mailtoUrl)).toContain('cc=copy@warehouse.test');
    expect(p.clipboardText).toContain('TO: intake@warehouse.test');
    expect(p.clipboardText).toContain('CC: copy@warehouse.test');
    expect(p.clipboardText).toContain(p.draft.body);
  });

  it('a long return opens shortened, says so, and the copied text stays complete', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      text: `Uniform piece number ${i + 1}, XL ×3`,
      sku: `UNI-${i + 1}`,
      replacement: null,
    }));
    const p = prepareReturnRequestEmail(input({ items }));
    expect(p.linkFits).toBe(true);
    expect(p.draft.condensed).toBe(true);
    expect(p.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(p.draft.body).toContain(RETURN_REQUEST_CONDENSED_DISCLOSURE);
    expect(p.draft.body).toContain('Items coming back: 60');
    expect(p.draft.body).toContain('Return: RMA-20261110-AB12CD');
    expect(p.draft.body).not.toContain('Uniform piece number 60');
    expect(p.clipboardText).toContain('Uniform piece number 60, XL ×3 (SKU UNI-60)');
    expect(p.clipboardText).not.toContain(RETURN_REQUEST_CONDENSED_DISCLOSURE);
  });

  it('says the link does not fit when even the shortened draft is too long', () => {
    const p = prepareReturnRequestEmail(input({ requestedBy: 'N'.repeat(2500) }));
    expect(p.linkFits).toBe(false);
    expect(p.clipboardText).toContain('N'.repeat(2500));
  });

  it('measures the native link when the caller says it opens that one', () => {
    const p = prepareReturnRequestEmail(input(), { transport: 'outlook-native' });
    expect(p.transport).toBe('outlook-native');
    expect(p.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
  });
});

describe('canSendReturnRequest', () => {
  it('offers the draft only while the return is open and has a number', () => {
    expect([...RETURN_REQUEST_SENDABLE_STATUSES]).toEqual(['requested', 'approved', 'received']);
    for (const s of ['requested', 'approved', 'received']) {
      expect(canSendReturnRequest(s, 'RMA-1'), s).toBe(true);
    }
    for (const s of ['closed', 'denied', 'cancelled', '', null, undefined, 'other']) {
      expect(canSendReturnRequest(s, 'RMA-1'), String(s)).toBe(false);
    }
    expect(canSendReturnRequest('requested', null)).toBe(false);
    expect(canSendReturnRequest('requested', '   ')).toBe(false);
  });
});

describe('isReturnNumberShape', () => {
  it('accepts a short single-line value and nothing else', () => {
    expect(isReturnNumberShape('RMA-20261110-AB12CD')).toBe(true);
    expect(isReturnNumberShape('R-7')).toBe(true);
    expect(isReturnNumberShape('')).toBe(false);
    expect(isReturnNumberShape(' RMA-1')).toBe(false);
    expect(isReturnNumberShape('RMA-1\nX')).toBe(false);
    expect(isReturnNumberShape('R'.repeat(65))).toBe(false);
    expect(isReturnNumberShape(12)).toBe(false);
    expect(isReturnNumberShape(null)).toBe(false);
  });
});

describe('the two mappings', () => {
  const tracking: RequesterTrackingReturn = {
    returnNumber: 'RMA-20261110-AB12CD',
    createdAt: '2026-11-10T10:00:00.000Z',
    returnStatus: 'approved',
    exchangeStatus: 'requested',
    sentences: ['Approved.'],
    replacementOrderNumber: null,
    lines: [
      {
        returning: { name: 'Staff Polo', sizeLabel: 'M', quantity: 2 },
        exchange: {
          state: 'requested',
          replacement: { name: 'Staff Polo', sizeLabel: 'L', quantity: 2 },
          substituted: false,
        },
      },
      { returning: { name: 'Lanyard', sizeLabel: null, quantity: 1 }, exchange: null },
      {
        returning: { name: 'Cap', sizeLabel: null, quantity: 1 },
        exchange: { state: 'declined', replacement: { name: 'Cap', sizeLabel: 'L', quantity: 1 }, substituted: false },
      },
      {
        returning: { name: 'Jacket', sizeLabel: 'S', quantity: 1 },
        exchange: { state: 'requested', replacement: null, substituted: false },
      },
    ],
  };

  it('the requester mapping carries the card words, no reason, no SKU, and the order link', () => {
    const c = returnRequestContentFromTracking(tracking, {
      orderNumber: 'SO-000085',
      requestedBy: 'Sample Requester',
      requesterEmail: 'requester@school.test',
      site: null,
      warehouseName: 'Main Warehouse',
      link: 'https://app.example.test/dashboard/orders/o1#your-requests',
    });
    expect(c).toEqual({
      returnNumber: 'RMA-20261110-AB12CD',
      orderNumber: 'SO-000085',
      status: 'approved',
      reasonCode: null,
      requestedBy: 'Sample Requester',
      requesterEmail: 'requester@school.test',
      site: null,
      warehouseName: 'Main Warehouse',
      items: [
        { text: 'Staff Polo, M ×2', sku: null, replacement: 'Staff Polo, L ×2' },
        { text: 'Lanyard ×1', sku: null, replacement: null },
        { text: 'Cap ×1', sku: null, replacement: null },
        { text: 'Jacket, S ×1', sku: null, replacement: null },
      ],
      link: 'https://app.example.test/dashboard/orders/o1#your-requests',
    });
  });

  it('a tracking row with no number gives nothing to send', () => {
    expect(
      returnRequestContentFromTracking(
        { ...tracking, returnNumber: null },
        { orderNumber: null, requestedBy: null, requesterEmail: null, site: null, warehouseName: null, link: null },
      ),
    ).toBeNull();
  });

  it('the return page mapping reads the header and lines, with SKU and reason, and never the notes', () => {
    const c = returnRequestContentFromWorkbench(
      {
        return: {
          returnNumber: 'RMA-20261110-AB12CD',
          status: 'requested',
          reasonCode: 'wrong_item',
          orderNumber: 85,
          warehouseName: 'Main Warehouse',
          requesterName: 'Sample Requester',
          requesterEmail: 'requester@school.test',
          notes: 'STAFF NOTE',
          denialReason: 'DENIAL TEXT',
        } as never,
        lines: [
          { id: 'l1', quantity: 2, item: { name: 'Staff Polo', sku: 'POLO-M', variant: 'Size M' } },
          { id: 'l2', quantity: 1, item: { name: null, sku: null, variant: null } },
        ],
        exchange: {
          lines: [
            {
              returnLineId: 'l1',
              status: 'approved',
              requestedQuantity: 2,
              requestedItem: { name: 'Staff Polo', variant: 'Size L' },
              approvedQuantity: 1,
              approvedItem: { name: 'Staff Polo', variant: 'Size XL' },
            },
            {
              returnLineId: 'l2',
              status: 'cancelled',
              requestedQuantity: 1,
              requestedItem: { name: 'Lanyard', variant: null },
              approvedQuantity: null,
              approvedItem: null,
            },
          ],
        },
      },
      { link: 'https://app.example.test/dashboard/returns/r1' },
    );
    expect(c).toEqual({
      returnNumber: 'RMA-20261110-AB12CD',
      orderNumber: 'SO-000085',
      status: 'requested',
      reasonCode: 'wrong_item',
      requestedBy: 'Sample Requester',
      requesterEmail: 'requester@school.test',
      site: null,
      warehouseName: 'Main Warehouse',
      items: [
        { text: 'Staff Polo, M ×2', sku: 'POLO-M', replacement: 'Staff Polo, XL ×1' },
        { text: 'Item ×1', sku: null, replacement: null },
      ],
      link: 'https://app.example.test/dashboard/returns/r1',
    });
    expect(JSON.stringify(c)).not.toContain('STAFF NOTE');
    expect(JSON.stringify(c)).not.toContain('DENIAL TEXT');
  });
});

describe('RETURN_REQUEST_COPY', () => {
  it('never says StockPilot sent anything or made a ticket', () => {
    expect(RETURN_REQUEST_COPY.honesty).toBe(
      'This opens a draft email. StockPilot does not send it and does not create a ticket. Review the message and press Send in your mail app.',
    );
    const all = Object.entries(RETURN_REQUEST_COPY);
    expect(all.filter(([k, s]) => k !== 'honesty' && /ticket/i.test(s)).map(([k]) => k)).toEqual([]);
    expect(all.filter(([, s]) => /\b(was|has been|were) sent\b|\bsubmitted\b/i.test(s)).map(([k]) => k)).toEqual([]);
  });
});
