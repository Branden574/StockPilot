import { describe, expect, it } from 'vitest';

import { offline, outOfDate, signInRedirect } from '@/test/rejected-request';

import {
  isActionOutOfDate,
  requestFailedMessage,
  requestUnconfirmedMessage,
} from './request-failure';

describe('request failure copy (B40)', () => {
  it('says what did not happen and to try again, for a request that is safe to resend', () => {
    expect(requestFailedMessage(offline(), 'save the view')).toBe(
      "We couldn't save the view. Check your connection and try again.",
    );
  });

  it('says to look before trying again, for a write that would happen twice', () => {
    expect(
      requestUnconfirmedMessage(offline(), 'the kits were assembled', "the bundle's stock"),
    ).toBe(
      "We couldn't confirm that the kits were assembled. Check the bundle's stock before trying again.",
    );
  });

  // A page built by an older deploy calls a Server Action the server no longer
  // has. Every retry from that page fails the same way until it reloads, so
  // "check your connection" sent people round in circles.
  it('says to reload a page older than the server, for a request that is safe to resend', () => {
    expect(requestFailedMessage(outOfDate(), 'save the view')).toBe(
      "StockPilot was updated since this page was opened, so we couldn't save the view. Reload the page, then try again.",
    );
  });

  it('says nothing was changed on a page older than the server, for a write that would happen twice', () => {
    // The action is not on the server, so it never ran: that is certain, and
    // there is nothing to check.
    expect(
      requestUnconfirmedMessage(outOfDate(), 'the kits were assembled', "the bundle's stock"),
    ).toBe(
      'StockPilot was updated since this page was opened, so nothing was changed. Reload the page, then try again.',
    );
  });

  it('knows an out-of-date page by the error name or by either of Next’s messages', () => {
    expect(isActionOutOfDate(outOfDate())).toBe(true);
    expect(
      isActionOutOfDate(
        new Error(
          'Failed to find Server Action "ab12". This request might be from an older or newer deployment.',
        ),
      ),
    ).toBe(true);
    expect(
      isActionOutOfDate(Object.assign(new Error('x'), { name: 'UnrecognizedActionError' })),
    ).toBe(true);
    for (const other of [
      offline(),
      signInRedirect(),
      new Error('An unexpected response was received from the server.'),
      'was not found on the server',
      null,
      undefined,
    ]) {
      expect(isActionOutOfDate(other)).toBe(false);
    }
  });
});
