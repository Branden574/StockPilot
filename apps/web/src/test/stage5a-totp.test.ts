import { describe, expect, it } from 'vitest';

import { base32Decode, hotp, msLeftInStep, totp } from '../../tests/e2e/appearance/stage5a-totp';

/**
 * The TOTP codes the stage 5 MFA sign-in types (plan 8.2 case 6), against
 * RFC 4226 appendix D and RFC 6238 appendix B (SHA-1). The seed is the RFCs'
 * published test key, not a secret.
 */

const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_KEY_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('stage 5 TOTP (RFC 6238)', () => {
  it('decodes base32 as the enrolment QR code carries it (case, spaces and padding ignored)', () => {
    expect(base32Decode(RFC_KEY_BASE32).equals(RFC_KEY)).toBe(true);
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq==').equals(RFC_KEY)).toBe(true);
    expect(() => base32Decode('GEZ1')).toThrow(/outside A-Z and 2-7/u);
    expect(() => base32Decode('')).toThrow(/empty/u);
  });

  it('HOTP matches RFC 4226 appendix D', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expect(expected.map((_, i) => hotp(RFC_KEY, i))).toEqual(expected);
    // A wrong counter gives another code (the check can fail).
    expect(hotp(RFC_KEY, 1)).not.toBe('755224');
  });

  it('TOTP matches RFC 6238 appendix B (SHA-1, 8 digits) and its 6-digit form', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(totp(RFC_KEY_BASE32, seconds * 1000, 8), String(seconds)).toBe(code);
      expect(totp(RFC_KEY_BASE32, seconds * 1000), String(seconds)).toBe(code.slice(-6));
    }
  });

  it('says how long the current code has left', () => {
    expect(msLeftInStep(0)).toBe(30_000);
    expect(msLeftInStep(29_000)).toBe(1000);
    expect(msLeftInStep(30_500)).toBe(29_500);
  });
});
