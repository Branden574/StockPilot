import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Linking from 'expo-linking';

import { DRAFT_URL_LIMIT, type MaintenanceEmailInput } from '@stockpilot/core';

import {
  BLOCKED_HEADLINE,
  BLOCKED_RETRY_MESSAGE,
  CONDENSED_NOTICE,
  COPY_HELPER_TEXT,
  DUPLICATE_WARNING,
  MAIL_APP_SUCCESS_MESSAGE,
  NATIVE_OUTLOOK_CC_TRUSTED,
  OVERSIZED_MESSAGE,
  SUCCESS_MESSAGE,
  openMaintenanceDraft,
  planOutlookOpen,
  prepareMobileMaintenanceEmail,
  shouldConfirmBeforeOpening,
  shouldShowCondensedNotice,
  successMessageFor,
  SHARE_LINK_EXISTS_NOTICE,
  SHARE_LINK_SHOW_ONCE_NOTICE,
  withShareUrl,
} from './maintenance-email-actions';
import { composeTransportForProbe, nativeOutlookAvailable } from './outlook-transport';

// expo-linking is a real, already-installed dependency (~7.1.7 —
// apps/mobile/package.json), never a new native module. vi.mock calls are
// hoisted above every import by vitest's transform regardless of their
// textual position (same reasoning maintenance-upload.test.ts documents for
// its own mocks of expo-file-system/expo-image-manipulator) — declared here,
// AFTER the imports above, purely to keep import/first lint-clean, same
// idiom Task 19's fix-wave established for this exact class of warning.
vi.mock('expo-linking', () => ({ openURL: vi.fn(async () => undefined), canOpenURL: vi.fn(async () => true) }));

const INPUT: MaintenanceEmailInput = {
  requestNumber: 'MR-2026-000123',
  subject: 'AC broken',
  description: 'Warm air.',
  category: null,
  priority: 'high',
  submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith',
  requesterEmail: null,
  requesterPhone: null,
  siteName: null,
  department: null,
  building: null,
  roomOrArea: null,
  accessInstructions: null,
  relatedItem: null,
  relatedOrder: null,
  relatedRental: null,
  photoCount: 0,
  shareUrl: null,
};

/** Fitted for a phone whose probe PROVED the native app — stamped
 *  `outlook-native`, so the opener's outlook button takes the deep link. */
const PREPARED = prepareMobileMaintenanceEmail(INPUT, true);
/** Fitted worst-case — no native app (or the probe has not answered).
 *  Stamped `outlook-web`; identical body on this small input, different
 *  stamp, different opened url. */
const PREPARED_WEB = prepareMobileMaintenanceEmail(INPUT, false);

beforeEach(() => vi.clearAllMocks());

/** The one thing every branch of this file has to prove: whatever URL we
 *  hand the OS, the mandatory CC is in it. Decodes an opaque-scheme deep link
 *  (ms-outlook:, mailto:) or the https OWA wrapper. */
function ccOf(url: string): string | undefined {
  const inner = url.includes('mailtouri=')
    ? decodeURIComponent(url.slice(url.indexOf('mailtouri=') + 'mailtouri='.length))
    : url;
  const q = inner.indexOf('?');
  if (q === -1) return undefined;
  for (const pair of inner.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq) === 'cc') return decodeURIComponent(pair.slice(eq + 1));
  }
  return undefined;
}

/** The mandatory CC, in the only two forms any transport is allowed to carry
 *  it: BARE on the native/mailto links, and as the tenant-verified OWA
 *  name-addr chip on the web one. Anything else — absent, empty, split into a
 *  second recipient — fails. */
const ACCEPTED_CC_FORMS = ['arosas@cvwest.org', 'Andrew Rosas <arosas@cvwest.org>'];

describe('mobile email actions (string assertions ONLY — never a real open in tests)', () => {
  it('THE FIX: on a native-stamped draft the outlook button opens the NATIVE ms-outlook: deep link, never an https URL a browser would take', async () => {
    await expect(openMaintenanceDraft('outlook', PREPARED, 'ios', () => {})).resolves.toEqual({
      outcome: 'opened',
      used: 'outlook-native',
    });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('ms-outlook://compose?')).toBe(true);
    expect(url.startsWith('http')).toBe(false);
    // CC GATE at the actual call site — not just in the composer:
    expect(ccOf(url)).toBe('arosas@cvwest.org');
  });

  it('CC GATE: exactly ONE openURL invocation per tap — the deep link is never auto-retried (duplicate compose screens)', async () => {
    await openMaintenanceDraft('outlook', PREPARED, 'ios', () => {});
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
  });

  it('no native Outlook installed (web-stamped draft): falls back to the tenant-verified web compose URL, CC still intact', async () => {
    await expect(openMaintenanceDraft('outlook', PREPARED_WEB, 'ios', () => {})).resolves.toEqual({
      outcome: 'opened',
      used: 'outlook-web',
    });
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=')).toBe(true);
    expect(ccOf(url)).toBe('Andrew Rosas <arosas@cvwest.org>');
  });

  it('a canOpenURL rejection is read as "not installed", so the probe can never hand this feature a false true', async () => {
    // The probe runs at the SCREEN, once, and its answer feeds the prepare
    // call — so what this feature depends on is that a throwing canOpenURL
    // resolves to `false`, never to a truthy value that would select the
    // unmeasured native budget.
    vi.mocked(Linking.canOpenURL).mockRejectedValueOnce(new Error('scheme not declared'));
    const probed = await nativeOutlookAvailable();
    expect(probed).toBe(false);
    expect(composeTransportForProbe(probed)).toBe('outlook-web');
  });

  it('mailto action opens the RFC 6068 URL with the CC intact', async () => {
    await expect(openMaintenanceDraft('mailto', PREPARED, 'ios', () => {})).resolves.toEqual({
      outcome: 'opened',
      used: 'default-mail',
    });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org')).toBe(true);
  });

  it('linkFits=false refuses to open either transport', async () => {
    const oversized = { ...PREPARED, linkFits: false };
    await expect(openMaintenanceDraft('outlook', oversized, 'ios', () => {})).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    await expect(openMaintenanceDraft('mailto', oversized, 'ios', () => {})).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it('the opener NEVER probes: canOpenURL is not called at press time, on any path — the stamp is the only transport authority', async () => {
    await openMaintenanceDraft('outlook', PREPARED, 'ios', () => {});
    await openMaintenanceDraft('outlook', PREPARED_WEB, 'android', () => {});
    await openMaintenanceDraft('mailto', PREPARED, 'ios', () => {});
    await openMaintenanceDraft('outlook', { ...PREPARED, linkFits: false }, 'ios', () => {});
    expect(Linking.canOpenURL).not.toHaveBeenCalled();
  });

  it('an openURL rejection reports blocked instead of throwing — and does NOT silently open something else', async () => {
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    await expect(openMaintenanceDraft('outlook', PREPARED, 'ios', () => {})).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
  });
});

describe('planOutlookOpen — transport decision (CC beats the Outlook brand)', () => {
  it('native Outlook present on a cc-trusted platform: the ms-outlook deep link', () => {
    for (const platform of ['ios', 'android'] as const) {
      const plan = planOutlookOpen(PREPARED, { nativeOutlookAvailable: true, platform });
      expect(plan).toEqual({ transport: 'outlook-native', url: PREPARED.outlookMobileUrl });
    }
  });

  it('native Outlook absent: the EXISTING web compose URL — never a silent switch to another mailbox', () => {
    const plan = planOutlookOpen(PREPARED, { nativeOutlookAvailable: false, platform: 'ios' });
    expect(plan).toEqual({ transport: 'outlook-web', url: PREPARED.outlookUrl });
  });

  it('a platform whose native Outlook is found to DROP cc= falls back to mailto: — the business invariant wins', () => {
    // The owner-owned device check is the only thing that can establish this;
    // flipping the entry below is the whole remediation, no redesign.
    const plan = planOutlookOpen(
      PREPARED,
      { nativeOutlookAvailable: true, platform: 'android' },
      { ios: true, android: false },
    );
    expect(plan).toEqual({ transport: 'default-mail', url: PREPARED.mailtoUrl });
  });

  it('CC GATE: every branch of the decision produces a URL that carries the cc', () => {
    const plans = [
      planOutlookOpen(PREPARED, { nativeOutlookAvailable: true, platform: 'ios' }),
      planOutlookOpen(PREPARED, { nativeOutlookAvailable: false, platform: 'ios' }),
      planOutlookOpen(PREPARED, { nativeOutlookAvailable: true, platform: 'android' }, { ios: false, android: false }),
    ];
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((p) => p.transport)).size).toBe(3);
    for (const plan of plans) {
      expect(ACCEPTED_CC_FORMS).toContain(ccOf(plan.url));
    }
  });

  it('both platforms currently ship TRUSTING the native transport (pinned so a flip is a deliberate, reviewed edit)', () => {
    expect(NATIVE_OUTLOOK_CC_TRUSTED).toEqual({ ios: true, android: true });
  });
});

describe('openMaintenanceDraft — R3 ordering (open first, record ONLY after a real open)', () => {
  it('calls onOpened exactly once, AFTER Linking.openURL resolves, on a successful outlook open', async () => {
    const order: string[] = [];
    vi.mocked(Linking.openURL).mockImplementationOnce(async () => {
      order.push('opened-url');
      return true;
    });
    const onOpened = vi.fn(() => order.push('recorded'));
    await expect(openMaintenanceDraft('outlook', PREPARED, 'ios', onOpened)).resolves.toEqual({
      outcome: 'opened',
      used: 'outlook-native',
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['opened-url', 'recorded']);
  });

  it('calls onOpened exactly once for a successful mailto open', async () => {
    const onOpened = vi.fn();
    await expect(openMaintenanceDraft('mailto', PREPARED, 'ios', onOpened)).resolves.toEqual({
      outcome: 'opened',
      used: 'default-mail',
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it('reports which transport ACTUALLY ran, so the screen never claims Outlook opened when it did not', async () => {
    const onOpened = vi.fn();
    await expect(openMaintenanceDraft('outlook', PREPARED_WEB, 'android', onOpened)).resolves.toEqual({
      outcome: 'opened',
      used: 'outlook-web',
    });
  });

  it('never calls onOpened when the open is blocked by an oversized draft', async () => {
    const oversized = { ...PREPARED, linkFits: false };
    const onOpened = vi.fn();
    await expect(openMaintenanceDraft('outlook', oversized, 'ios', onOpened)).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('never calls onOpened when Linking.openURL rejects (a failed open must not be recorded as opened)', async () => {
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    const onOpened = vi.fn();
    await expect(openMaintenanceDraft('outlook', PREPARED, 'ios', onOpened)).resolves.toEqual({
      outcome: 'blocked',
      used: null,
    });
    expect(onOpened).not.toHaveBeenCalled();
    // One tap, one invocation — no automatic second attempt down another
    // transport, which is how duplicate compose screens got created before.
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// THE BODY IS FITTED AGAINST THE URL THIS PHONE WILL OPEN — the delivery
// fix (2026-08-13), mirrored for maintenance (2026-08-16). Before this, the
// maintenance email was always condensed against the double-encoded https
// OWA url, so a phone with Outlook installed truncated long descriptions
// and dropped the category/priority/contact/location blocks while its own
// `ms-outlook://` url sat hundreds of characters under the limit.
// =========================================================================

describe('the maintenance email is fitted against the url this phone will open', () => {
  /** A realistic request whose only excess is a long (465-char) description
   *  — the class of input the native budget recovers. Same fixture the core
   *  suite measures: full-draft web url 2199 (over), native 1646 and mailto
   *  1627 (both under). */
  const REALISTIC_LONG: MaintenanceEmailInput = {
    ...INPUT,
    requestNumber: 'MR-2026-000456',
    subject: 'Hallway heater grinding and overheating near Room 118',
    description: [
      'The heating unit in the main hallway outside Room 118 has been making a loud grinding noise since Monday morning.',
      'It runs for about ten minutes, shuts off with a bang, and then restarts on its own a few minutes later.',
      'The thermostat on the wall reads 81 degrees even though it is set to 72, and the air coming out of the vent is cold.',
      'Two staff members have reported headaches from the noise, and the afternoon study group has been moved to the library as a result.',
    ].join(' '),
    category: 'Heating or air conditioning',
    requesterEmail: 'jane.smith@learn4life.org',
    requesterPhone: '(555) 555-0199',
    siteName: 'Fresno Learning Center',
    department: 'Operations',
    building: 'Main Building',
    roomOrArea: 'Room 204',
  };

  it('THE DEFECT: a phone with Outlook installed carries the FULL body where the web budget truncated it', () => {
    const web = prepareMobileMaintenanceEmail(REALISTIC_LONG, false);
    const native = prepareMobileMaintenanceEmail(REALISTIC_LONG, true);

    // Both really run the condense decision — the web one condenses, the
    // native one keeps the whole draft.
    expect(web.draft.condensed).toBe(true);
    expect(native.draft.condensed).toBe(false);
    expect(native.linkFits).toBe(true);

    // The recovered content, named: the full description and the blocks the
    // condensed shape drops.
    expect(native.draft.body).toContain(REALISTIC_LONG.description);
    expect(web.draft.body).not.toContain(REALISTIC_LONG.description);
    expect(native.draft.body).toContain('Category: Heating or air conditioning');
    expect(web.draft.body).not.toContain('Category:');
    expect(native.draft.body.length).toBeGreaterThan(web.draft.body.length);
  });

  it('THE HEADROOM, numerically: the web-fitted draft leaves the native url hundreds of characters short of the limit', () => {
    const web = prepareMobileMaintenanceEmail(REALISTIC_LONG, false);
    const wasted = DRAFT_URL_LIMIT - web.outlookMobileUrl.length;
    expect(wasted).toBeGreaterThan(400);
    const native = prepareMobileMaintenanceEmail(REALISTIC_LONG, true);
    expect(native.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(DRAFT_URL_LIMIT - native.outlookMobileUrl.length).toBeLessThan(wasted);
  });

  it('whatever the opener opens is a url that was MEASURED — across every probe answer and platform', async () => {
    for (const nativeOutlook of [true, false, null] as const) {
      for (const platform of ['ios', 'android'] as const) {
        vi.mocked(Linking.openURL).mockClear();
        const prepared = prepareMobileMaintenanceEmail(REALISTIC_LONG, nativeOutlook);
        expect(prepared.linkFits).toBe(true);
        await openMaintenanceDraft('outlook', prepared, platform, () => {});
        const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
        expect(url.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
        // ...and it is the transport the prepare pass declared it was fitting.
        expect(url).toBe(
          prepared.transport === 'outlook-native' ? prepared.outlookMobileUrl : prepared.outlookUrl,
        );
      }
    }
  });

  it('the native budget genuinely leaves the WEB url unmeasured — which is why the stamp pairing is not optional', () => {
    const native = prepareMobileMaintenanceEmail(REALISTIC_LONG, true);
    expect(native.linkFits).toBe(true);
    expect(native.transport).toBe('outlook-native');
    expect(native.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(native.outlookUrl.length).toBeGreaterThan(DRAFT_URL_LIMIT);
  });

  it("STRUCTURAL: the opener follows the DRAFT'S OWN stamp, so a mismatched pair cannot be constructed", async () => {
    for (const [nativeOutlook, expectedTransport, expectedUrlKey] of [
      [true, 'outlook-native', 'outlookMobileUrl'],
      [false, 'outlook-web', 'outlookUrl'],
      [null, 'outlook-web', 'outlookUrl'],
    ] as const) {
      vi.mocked(Linking.openURL).mockClear();
      const prepared = prepareMobileMaintenanceEmail(REALISTIC_LONG, nativeOutlook);
      expect(prepared.transport).toBe(expectedTransport);
      await openMaintenanceDraft('outlook', prepared, 'ios', () => {});
      expect(vi.mocked(Linking.openURL).mock.calls[0]![0]).toBe(prepared[expectedUrlKey]);
    }

    // And the stamp is what is read — not a probe, not a default. A draft
    // measured for the web budget opens the WEB url even on a device whose
    // native app is available, because the web url is the one that was
    // fitted. Proving that mattered: on this fixture the two urls carry
    // DIFFERENT bodies (condensed vs full), so "either would have passed"
    // is not true here.
    vi.mocked(Linking.openURL).mockClear();
    const webFitted = prepareMobileMaintenanceEmail(REALISTIC_LONG, false);
    await openMaintenanceDraft('outlook', webFitted, 'ios', () => {});
    expect(vi.mocked(Linking.openURL).mock.calls[0]![0]).toBe(webFitted.outlookUrl);
    expect(webFitted.outlookMobileUrl).not.toBe(webFitted.outlookUrl);
  });

  it('TYPE-LEVEL PIN: the opener takes no probe answer, so the screen cannot pass one that disagrees', () => {
    const call = () =>
      // @ts-expect-error `nativeOutlook` is not a parameter: the transport
      // comes from `prepared`. If this argument is ever reinstated, the
      // directive becomes unused and `pnpm typecheck` fails with TS2578 —
      // which is the point, because reinstating it reintroduces the
      // divergence between what was measured and what opens.
      openMaintenanceDraft('outlook', PREPARED, 'ios', false, () => {});
    // Never invoked: the assertion is that the line above does not typecheck.
    expect(typeof call).toBe('function');
  });

  it('the mailto reroute is safe under BOTH budgets: core measures it either way', async () => {
    // planOutlookOpen sends a cc-untrusted platform to mailto. That url is
    // not the one `transport` names, so it is only safe because core
    // measures the mailto on both rungs regardless of transport.
    const native = prepareMobileMaintenanceEmail(REALISTIC_LONG, true);
    expect(native.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    const res = await openMaintenanceDraft('outlook', native, 'ios', () => {}, {
      ios: false,
      android: true,
    });
    expect(res).toEqual({ outcome: 'opened', used: 'default-mail' });
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(ccOf(url)).toBe('arosas@cvwest.org');
  });

  it('composeTransportForProbe: only a PROVED native app selects the shorter budget', () => {
    expect(composeTransportForProbe(true)).toBe('outlook-native');
    expect(composeTransportForProbe(false)).toBe('outlook-web');
    expect(composeTransportForProbe(null)).toBe('outlook-web');
  });

  it('the prepared email records which transport it was fitted for, and the default is the WORST case', () => {
    expect(prepareMobileMaintenanceEmail(INPUT, true).transport).toBe('outlook-native');
    expect(prepareMobileMaintenanceEmail(INPUT, false).transport).toBe('outlook-web');
    expect(prepareMobileMaintenanceEmail(INPUT, null).transport).toBe('outlook-web');
    // A caller that forgets the probe answer under-fills rather than
    // truncating:
    expect(prepareMobileMaintenanceEmail(INPUT).transport).toBe('outlook-web');
  });
});

describe('successMessageFor — the copy matches the transport that actually ran', () => {
  it('names Outlook only when Outlook (native or web) is what opened', () => {
    expect(successMessageFor('outlook-native')).toBe(SUCCESS_MESSAGE);
    expect(successMessageFor('outlook-web')).toBe(SUCCESS_MESSAGE);
  });

  it('says "email app" — never "Outlook" — when the mailto fallback is what opened', () => {
    expect(successMessageFor('default-mail')).toBe(MAIL_APP_SUCCESS_MESSAGE);
    expect(MAIL_APP_SUCCESS_MESSAGE).not.toContain('Outlook');
  });

  it('a null transport (nothing opened) still never claims a send', () => {
    expect(successMessageFor(null)).toBe(SUCCESS_MESSAGE);
  });
});

describe('shouldConfirmBeforeOpening — the duplicate-draft gate (brief section 21)', () => {
  it('never confirms before the first open (openCount 0)', () => {
    expect(shouldConfirmBeforeOpening(0)).toBe(false);
  });

  it('confirms on every reopen (openCount > 0)', () => {
    expect(shouldConfirmBeforeOpening(1)).toBe(true);
    expect(shouldConfirmBeforeOpening(7)).toBe(true);
  });
});

describe('shouldShowCondensedNotice — only when a condensed draft actually opens (never alongside the oversized message)', () => {
  it('true when the draft condensed but still fits', () => {
    expect(shouldShowCondensedNotice({ ...PREPARED, draft: { ...PREPARED.draft, condensed: true }, linkFits: true })).toBe(true);
  });

  it('false when nothing condensed', () => {
    expect(shouldShowCondensedNotice({ ...PREPARED, draft: { ...PREPARED.draft, condensed: false }, linkFits: true })).toBe(false);
  });

  it('false when condensed AND still oversized — the oversized message owns that state, not the condensed notice', () => {
    expect(shouldShowCondensedNotice({ ...PREPARED, draft: { ...PREPARED.draft, condensed: true }, linkFits: false })).toBe(false);
  });
});

describe('exported copy is the literal, brief-pinned text', () => {
  it('SUCCESS_MESSAGE is Task 14 spec line 6, verbatim', () => {
    expect(SUCCESS_MESSAGE).toBe(
      'Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.',
    );
  });

  it('BLOCKED_HEADLINE matches brief section 19, verbatim', () => {
    expect(BLOCKED_HEADLINE).toBe('Outlook could not be opened automatically.');
  });

  it('BLOCKED_RETRY_MESSAGE is the fixed, direction-free wording (fast-follow, 2026-08-06)', () => {
    // Literal pin — this is the fix under test: the string used to read
    // "...or use Copy Email Details below", which was wrong on this screen
    // (the Copy Email Details button renders ABOVE the blocked-state card,
    // not below it). Fixed to drop the directional claim entirely.
    expect(BLOCKED_RETRY_MESSAGE).toBe(
      'Your request is saved — try again, or use Copy Email Details instead.',
    );
    // Belt-and-suspenders: no layout-direction word can sneak back in,
    // regardless of the exact phrasing chosen.
    expect(BLOCKED_RETRY_MESSAGE.toLowerCase()).not.toContain('below');
    expect(BLOCKED_RETRY_MESSAGE.toLowerCase()).not.toContain('above');
  });

  it('DUPLICATE_WARNING matches brief section 21, verbatim', () => {
    expect(DUPLICATE_WARNING).toBe(
      'A maintenance email draft was already opened for this request. Sending multiple copies may create duplicate Zendesk tickets.',
    );
  });

  it('OVERSIZED_MESSAGE never claims the link could open', () => {
    expect(OVERSIZED_MESSAGE).toContain('Copy Email Details');
    expect(OVERSIZED_MESSAGE.toLowerCase()).not.toContain('outlook opened');
  });

  it('CONDENSED_NOTICE discloses the shortening and points at Copy Email Details for the full text', () => {
    expect(CONDENSED_NOTICE).toBe(
      'This email will open with a shortened summary — the full request was too long for a compose link. The complete details are saved in this request, and Copy Email Details always includes everything.',
    );
  });

  it('COPY_HELPER_TEXT is the exact press-and-hold instruction (audit Q9 — no clipboard module, this IS the affordance)', () => {
    expect(COPY_HELPER_TEXT).toBe('Press and hold inside the box to select and copy.');
  });

  it('none of the exported copy uses forbidden outcome vocabulary (brief section 20)', () => {
    const FORBIDDEN = [
      'Ticket created',
      'Request submitted to Zendesk',
      'DC4 notified',
      'Andrew notified',
      'Ticket assigned',
      'Email sent',
    ];
    for (const text of [
      SUCCESS_MESSAGE,
      MAIL_APP_SUCCESS_MESSAGE,
      BLOCKED_HEADLINE,
      BLOCKED_RETRY_MESSAGE,
      DUPLICATE_WARNING,
      OVERSIZED_MESSAGE,
      CONDENSED_NOTICE,
      COPY_HELPER_TEXT,
    ]) {
      for (const banned of FORBIDDEN) {
        expect(text).not.toContain(banned);
      }
    }
  });
});

describe('withShareUrl — mig 0330 show-once merge (the ONLY way a share URL reaches a compose draft now)', () => {
  const BASE = {
    requestNumber: 'MR-2026-000123',
    subject: 'AC broken',
    shareUrl: null as string | null,
  };

  it('folds a freshly-generated URL into the email input, leaving every other field untouched', () => {
    const merged = withShareUrl(BASE, 'https://stockpilotusa.com/m/abc123');
    expect(merged.shareUrl).toBe('https://stockpilotusa.com/m/abc123');
    expect(merged.requestNumber).toBe('MR-2026-000123');
    expect(merged.subject).toBe('AC broken');
  });

  it('with no generated URL the input passes through UNTOUCHED (identity, not a null-overwriting copy) — the server always sends shareUrl null since 0330, and this must not fabricate anything', () => {
    expect(withShareUrl(BASE, null)).toBe(BASE);
  });

  it('never mutates the original input (the screen memo depends on referential honesty)', () => {
    const before = { ...BASE };
    withShareUrl(BASE, 'https://stockpilotusa.com/m/abc123');
    expect(BASE).toEqual(before);
  });

  it('the show-once notices are the literal pinned copy', () => {
    expect(SHARE_LINK_SHOW_ONCE_NOTICE).toBe(
      'Link generated — copy or share it now. For security it is shown only this once; generating again replaces it.',
    );
    expect(SHARE_LINK_EXISTS_NOTICE).toBe(
      'An active share link exists, but its URL cannot be shown again. Generate a new link to get one — the current link stops working.',
    );
  });
});
