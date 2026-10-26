import { describe, expect, it } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from './request-failure';

describe('request failure copy (B40)', () => {
  it('says what did not happen and to try again, for a request that is safe to resend', () => {
    expect(requestFailedMessage('save the view')).toBe(
      "We couldn't save the view. Check your connection and try again.",
    );
  });

  it('says to look before trying again, for a write that would happen twice', () => {
    expect(requestUnconfirmedMessage('the kits were assembled', "the bundle's stock")).toBe(
      "We couldn't confirm that the kits were assembled. Check the bundle's stock before trying again.",
    );
  });
});
