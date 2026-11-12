import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Linking from 'expo-linking';

import {
  DRAFT_URL_LIMIT,
  deliveryRequestRecipients,
  prepareReturnRequestEmail,
  returnRequestContentFromTracking,
  returnRequestContentFromWorkbench,
  type RequesterTrackingReturn,
  type ReturnRequestEmailContent,
} from '@stockpilot/core';

import {
  RETURN_REQUEST_COPY,
  anyReturnRequestSendable,
  getReturnRequestEmailForOrder,
  openReturnRequestDraft,
  prepareMobileReturnRequest,
  recordReturnRequestDrafted,
  returnProblemLaunchParams,
  returnRequestBlockedHeadline,
  returnRequestContentForTracking,
  returnRequestContentForWorkbench,
  returnRequestEmailFromOrderAnswer,
  returnRequestEmailFromWorkbench,
  returnRequestRecipientsText,
  returnRequestSuccessMessage,
  shouldConfirmBeforeOpening,
  shouldShowReturnRequestBlocked,
  shouldShowReturnRequestCondensed,
  shouldWarnReturnRequestDuplicate,
} from './return-request-actions';

// './api' pulls expo-constants and the Supabase client at import time, and
// expo-linking is a native module: both are replaced here. Nothing in this
// file reaches a network, a mail app or a real mailbox (reserved test
// domains only).
const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => apiMock);
vi.mock('expo-linking', () => ({ openURL: vi.fn(async () => undefined), canOpenURL: vi.fn(async () => true) }));

const PAIR = { to: 'intake@warehouse.test', cc: 'copy@warehouse.test' };
const RECIPIENTS = deliveryRequestRecipients(PAIR);
const ORDER = 'b3f1c2d4-1111-4222-8333-444455556666';

const CONTENT: ReturnRequestEmailContent = {
  returnNumber: 'RMA-20261110-AB12CD',
  orderNumber: 'SO-000085',
  status: 'requested',
  reasonCode: null,
  requestedBy: 'Sample Requester',
  requesterEmail: 'requester@school.test',
  site: null,
  warehouseName: 'Main Warehouse',
  items: [{ text: 'Staff Polo, M ×2', sku: null, replacement: null }],
  link: `https://app.example.test/dashboard/orders/${ORDER}#your-requests`,
};

const TRACKING: RequesterTrackingReturn = {
  returnNumber: 'RMA-20261110-AB12CD',
  createdAt: '2026-11-10T10:00:00.000Z',
  returnStatus: 'requested',
  exchangeStatus: 'none',
  sentences: ['Requested.'],
  replacementOrderNumber: null,
  lines: [{ returning: { name: 'Staff Polo', sizeLabel: 'M', quantity: 2 }, exchange: null }],
};

const ORDER_FACTS = {
  orderNumber: 'SO-000085',
  requestedBy: 'Sample Requester',
  requesterEmail: 'requester@school.test',
  site: null,
  warehouseName: 'Main Warehouse',
  link: `https://app.example.test/dashboard/orders/${ORDER}#your-requests`,
};

const WORKBENCH = {
  return: {
    returnNumber: 'RMA-20261110-AB12CD',
    status: 'approved',
    reasonCode: 'damaged',
    orderNumber: 85,
    warehouseName: 'Main Warehouse',
    requesterName: 'Sample Requester',
    requesterEmail: 'requester@school.test',
    notes: 'STAFF NOTE',
    denialReason: 'DENIAL TEXT',
  },
  lines: [{ id: 'l1', quantity: 2, item: { name: 'Staff Polo', sku: 'POLO-M', variant: 'Size M' } }],
  exchange: { lines: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Linking.openURL).mockImplementation(async () => true);
});

describe('the server answers, read defensively', () => {
  it('the return screen: a valid pair is branded, with the link', () => {
    const e = returnRequestEmailFromWorkbench({ recipients: { ...PAIR, toName: 'Intake' }, link: 'https://app.example.test/r' });
    expect(e.recipients).toMatchObject({ ...PAIR, toName: 'Intake' });
    expect(e.link).toBe('https://app.example.test/r');
  });

  it('no field (an older server), null, junk or a pair the factory refuses: no mailboxes, never a compiled pair', () => {
    for (const raw of [
      undefined,
      null,
      'x',
      [],
      {},
      { recipients: null },
      { recipients: { to: 'intake@warehouse.test' } },
      { recipients: { to: 'not-an-address', cc: 'copy@warehouse.test' } },
      { recipients: { to: 'intake@warehouse.test\nBcc: x@evil.test', cc: 'copy@warehouse.test' } },
    ]) {
      expect(returnRequestEmailFromWorkbench(raw).recipients, JSON.stringify(raw)).toBeNull();
      expect(returnRequestEmailFromOrderAnswer(raw).recipients, JSON.stringify(raw)).toBeNull();
    }
  });

  it('the order screen: the facts are read field by field, junk becomes null', () => {
    const e = returnRequestEmailFromOrderAnswer({
      recipients: PAIR,
      order: {
        ...ORDER_FACTS,
        site: { id: 's1', name: 'North Campus', code: 'NC', address: { line1: '1 Example Way' } },
        warehouseName: 42,
        notes: 'never read',
      },
    });
    expect(e.order).toEqual({
      ...ORDER_FACTS,
      site: { id: 's1', name: 'North Campus', code: 'NC', address: { line1: '1 Example Way' } },
      warehouseName: null,
    });
    expect(returnRequestEmailFromOrderAnswer({ recipients: PAIR }).order).toEqual({
      orderNumber: null,
      requestedBy: null,
      requesterEmail: null,
      site: null,
      warehouseName: null,
      link: null,
    });
  });

  it('getReturnRequestEmailForOrder reads the member route, and a refusal is nothing to show', async () => {
    apiMock.api.mockResolvedValueOnce({ recipients: PAIR, order: ORDER_FACTS });
    const got = await getReturnRequestEmailForOrder(ORDER);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/return-request-email`);
    expect(got?.recipients).toMatchObject(PAIR);
    apiMock.api.mockRejectedValueOnce(new Error('404'));
    expect(await getReturnRequestEmailForOrder(ORDER)).toBeNull();
  });
});

describe('the gate, per screen', () => {
  it('the order screen asks for the mailboxes only when a request is open and numbered', () => {
    expect(anyReturnRequestSendable([TRACKING])).toBe(true);
    expect(anyReturnRequestSendable([{ ...TRACKING, returnStatus: 'closed' }])).toBe(false);
    expect(anyReturnRequestSendable([{ ...TRACKING, returnNumber: null }])).toBe(false);
    expect(anyReturnRequestSendable([])).toBe(false);
    expect(anyReturnRequestSendable(null)).toBe(false);
  });

  it('the gate matrix for a tracking card: mailboxes and an open, numbered request, or nothing', () => {
    const email = { recipients: RECIPIENTS, order: ORDER_FACTS };
    for (const status of ['requested', 'approved', 'received'] as const) {
      expect(returnRequestContentForTracking({ ...TRACKING, returnStatus: status }, email), status).not.toBeNull();
    }
    for (const status of ['closed', 'denied', 'cancelled'] as const) {
      expect(returnRequestContentForTracking({ ...TRACKING, returnStatus: status }, email), status).toBeNull();
    }
    expect(returnRequestContentForTracking({ ...TRACKING, returnNumber: null }, email)).toBeNull();
    expect(returnRequestContentForTracking(TRACKING, { recipients: null, order: ORDER_FACTS })).toBeNull();
    expect(returnRequestContentForTracking(TRACKING, null)).toBeNull();
  });

  it('the gate matrix for the return screen', () => {
    const email = { recipients: RECIPIENTS, link: 'https://app.example.test/r' };
    for (const [status, shown] of [
      ['requested', true],
      ['approved', true],
      ['received', true],
      ['closed', false],
      ['denied', false],
      ['cancelled', false],
    ] as const) {
      const got = returnRequestContentForWorkbench({ ...WORKBENCH, return: { ...WORKBENCH.return, status } }, email);
      expect(got !== null, status).toBe(shown);
    }
    expect(returnRequestContentForWorkbench(WORKBENCH, { recipients: null, link: null })).toBeNull();
    expect(
      returnRequestContentForWorkbench({ ...WORKBENCH, return: { ...WORKBENCH.return, returnNumber: null } }, email),
    ).toBeNull();
  });
});

describe('parity: the phone and the website build one draft from one return', () => {
  it("the requester's request: the phone's content is core's mapping, the website's too", () => {
    const phone = returnRequestContentForTracking(TRACKING, { recipients: RECIPIENTS, order: ORDER_FACTS })!;
    // The website: requester-tracking.tsx calls this same core function with
    // the order page's facts (page.returns.test.tsx section (i) pins them).
    const web = returnRequestContentFromTracking(TRACKING, ORDER_FACTS)!;
    expect(phone).toEqual(web);
    const a = prepareMobileReturnRequest(phone, RECIPIENTS, null);
    const b = prepareReturnRequestEmail({ ...web, recipients: RECIPIENTS });
    // Field by field: with no native Outlook proven, the phone's draft is
    // the website's draft, byte for byte, on every transport.
    expect(a.draft).toEqual(b.draft);
    expect(a.outlookUrl).toBe(b.outlookUrl);
    expect(a.outlookMobileUrl).toBe(b.outlookMobileUrl);
    expect(a.mailtoUrl).toBe(b.mailtoUrl);
    expect(a.clipboardText).toBe(b.clipboardText);
  });

  it('the return screen: the same, from the workbench, and never the notes', () => {
    const email = { recipients: RECIPIENTS, link: 'https://app.example.test/dashboard/returns/r1' };
    const phone = returnRequestContentForWorkbench(WORKBENCH, email)!;
    const web = returnRequestContentFromWorkbench(WORKBENCH, { link: email.link })!;
    expect(phone).toEqual(web);
    const p = prepareMobileReturnRequest(phone, RECIPIENTS, true);
    expect(p.clipboardText).toContain('Reason: Damaged');
    expect(p.clipboardText).toContain('(SKU POLO-M)');
    expect(p.clipboardText).not.toContain('STAFF NOTE');
    expect(p.clipboardText).not.toContain('DENIAL TEXT');
  });
});

describe('prepare and open', () => {
  it('is measured against the link the probe says will open', () => {
    expect(prepareMobileReturnRequest(CONTENT, RECIPIENTS, null).transport).toBe('outlook-web');
    expect(prepareMobileReturnRequest(CONTENT, RECIPIENTS, false).transport).toBe('outlook-web');
    const native = prepareMobileReturnRequest(CONTENT, RECIPIENTS, true);
    expect(native.transport).toBe('outlook-native');
    expect(native.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
  });

  it('opens the link that was measured, with the copy address on it, and counts only a real open', async () => {
    const onOpened = vi.fn();
    const web = prepareMobileReturnRequest(CONTENT, RECIPIENTS, false);
    const res = await openReturnRequestDraft(web, 'ios', onOpened);
    expect(res).toEqual({ outcome: 'opened', used: 'outlook-web' });
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    expect(Linking.openURL).toHaveBeenCalledWith(web.outlookUrl);
    expect(decodeURIComponent(decodeURIComponent(web.outlookUrl))).toContain('copy@warehouse.test');
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it('a blocked open counts nothing and names what was tried', async () => {
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    const onOpened = vi.fn();
    const res = await openReturnRequestDraft(prepareMobileReturnRequest(CONTENT, RECIPIENTS, false), 'ios', onOpened);
    expect(res).toEqual({ outcome: 'blocked', used: null, attempted: 'outlook-web' });
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('a draft too long for any link opens nothing', async () => {
    const big = prepareMobileReturnRequest({ ...CONTENT, requestedBy: 'N'.repeat(2500) }, RECIPIENTS, false);
    expect(big.linkFits).toBe(false);
    const onOpened = vi.fn();
    const res = await openReturnRequestDraft(big, 'ios', onOpened);
    expect(res.outcome).toBe('blocked');
    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
    expect(big.clipboardText).toContain('N'.repeat(2500));
  });
});

describe('the record', () => {
  it('posts the three fields to the order route, and nothing else', async () => {
    apiMock.api.mockResolvedValueOnce({ recorded: true });
    await recordReturnRequestDrafted({ orderId: ORDER, returnNumber: 'RMA-1', isCondensed: true, surface: 'return' });
    expect(apiMock.api).toHaveBeenCalledTimes(1);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/return-request-drafted`, {
      method: 'POST',
      body: { returnNumber: 'RMA-1', isCondensed: true, surface: 'return' },
    });
  });

  it('never rejects', async () => {
    apiMock.api.mockRejectedValueOnce(new Error('offline'));
    await expect(
      recordReturnRequestDrafted({ orderId: ORDER, returnNumber: 'RMA-1', isCondensed: false, surface: 'order' }),
    ).resolves.toBeUndefined();
  });
});

describe('what the section says', () => {
  it('the strings by name', () => {
    expect(RETURN_REQUEST_COPY.eyebrow).toBe('RETURN REQUEST');
    expect(RETURN_REQUEST_COPY.primary).toBe('Email return request');
    expect(RETURN_REQUEST_COPY.copy).toBe('Copy details');
    expect(RETURN_REQUEST_COPY.honesty).toBe(
      'This opens a draft email. StockPilot does not send it and does not create a ticket. Review the message and press Send in your mail app.',
    );
    expect(RETURN_REQUEST_COPY.duplicate).toBe(
      'You have already opened a draft for this return. Sending more than one creates duplicate requests for the warehouse.',
    );
    expect(returnRequestRecipientsText(PAIR)).toBe(
      'This request will be emailed to intake@warehouse.test. A copy will also be sent to copy@warehouse.test.',
    );
  });

  it('the success and blocked words follow what actually opened or was tried', () => {
    expect(returnRequestSuccessMessage('outlook-native')).toBe(RETURN_REQUEST_COPY.success);
    expect(returnRequestSuccessMessage('outlook-web')).toBe(RETURN_REQUEST_COPY.success);
    expect(returnRequestSuccessMessage('default-mail')).toBe(RETURN_REQUEST_COPY.mailAppSuccess);
    expect(returnRequestSuccessMessage('default-mail')).not.toContain('Outlook');
    expect(returnRequestBlockedHeadline('default-mail')).toBe(RETURN_REQUEST_COPY.mailAppBlocked);
    expect(returnRequestBlockedHeadline('outlook-web')).toBe(RETURN_REQUEST_COPY.blocked);
    expect(returnRequestBlockedHeadline(null)).toBe(RETURN_REQUEST_COPY.blocked);
  });

  it('blocked, condensed and duplicate notices', () => {
    const fits = prepareMobileReturnRequest(CONTENT, RECIPIENTS, false);
    const big = prepareMobileReturnRequest({ ...CONTENT, requestedBy: 'N'.repeat(2500) }, RECIPIENTS, false);
    const blocked = { outcome: 'blocked', used: null, attempted: 'outlook-web' } as const;
    expect(shouldShowReturnRequestBlocked(fits, blocked)).toBe(true);
    expect(shouldShowReturnRequestBlocked(fits, null)).toBe(false);
    expect(shouldShowReturnRequestBlocked(fits, { outcome: 'opened', used: 'outlook-web' })).toBe(false);
    // Too long is its own failure: the retry advice would be useless.
    expect(shouldShowReturnRequestBlocked(big, { outcome: 'blocked', used: null, attempted: null })).toBe(false);
    expect(shouldShowReturnRequestCondensed(fits)).toBe(false);
    const long = prepareMobileReturnRequest(
      { ...CONTENT, items: Array.from({ length: 60 }, (_, i) => ({ text: `Uniform piece number ${i}, XL ×3`, sku: null, replacement: null })) },
      RECIPIENTS,
      false,
    );
    expect(shouldShowReturnRequestCondensed(long)).toBe(true);
    expect(shouldWarnReturnRequestDuplicate(0)).toBe(false);
    expect(shouldWarnReturnRequestDuplicate(1)).toBe(true);
    expect(shouldConfirmBeforeOpening(0)).toBe(false);
    expect(shouldConfirmBeforeOpening(1)).toBe(true);
  });

  it('Report a problem from a return attaches the order and names the return', () => {
    expect(returnProblemLaunchParams({ orderRequestId: ORDER, returnNumber: 'RMA-1' })).toEqual({
      orderRequestId: ORDER,
      subject: 'Return RMA-1: ',
    });
    expect(returnProblemLaunchParams({ orderRequestId: ORDER, returnNumber: null })).toEqual({ orderRequestId: ORDER });
  });
});
