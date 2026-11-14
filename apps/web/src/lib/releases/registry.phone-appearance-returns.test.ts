import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  RETURN_REQUEST_COPY,
  RETURNS_COPY,
  defaultStyle,
  shownStyle,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whatsnew-phone-1112 (2026-11-12): the release for the phone
 * update of 2026-11-12 (runtime 1.4.0, Liquid Glass opt-in) and two web fixes
 * live the same day, published at the top, below the Liquid Glass draft and
 * above the returns request and names release:
 *
 *  - the phone's half of Send return request (#498): Email return request on
 *    the requester's own order and on the return screen, with Report a
 *    problem there; the returns release said the mobile app gets the button
 *    with its next update, and this release says it has;
 *  - Settings, Appearance in the mobile app (Design and Theme), Classic unless
 *    the person chooses Liquid Glass, saved to the account and shared with
 *    the website;
 *  - on the website, one draft per double click on Email return request
 *    (#502) and Liquid Glass toasts back in the bottom right corner (#504).
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin the release's id, status, revision, date and order,
 * who each entry reaches, and the code its words rest on.
 */
const ID = 'phone-appearance-returns-2026-11';
const OWN_ORDER = 'app-return-request-own-order';
const RETURN_SCREEN = 'app-return-request-return-screen';
const APPEARANCE = 'app-appearance-design-theme';
const ONE_DRAFT = 'web-return-request-one-draft';
const TOASTS = 'web-glass-messages-bottom-right';
const RETURNS_REQUEST_ID = 'returns-request-email-names-2026-11';
// Added by docs/whats-new-2026-11-13 (2026-11-13): the Release count, AI Assistant and not found
// releases, published later, at the top, read or seen. Each reaches an owner with every permission
// and module or nobody here, so a test that expects an older notice reads or sees them first, and
// the notice it checks is the one it checked before.
const NEWER_IDS_1113 = [
  // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: without them): the phone authenticator code and access check releases are published later, at the top; the authenticator code release reaches every member and the access check release reaches whoever can adjust stock, check out rentals or escalate exceptions, an owner with every permission and module included, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  'phone-authenticator-code-2026-11',
  'phone-access-check-retry-2026-11',
  'emailed-links-name-their-account-2026-11',
  'cycle-count-already-released-2026-11',
  'ai-assistant-plain-words-2026-11',
  'changes-that-did-not-happen-2026-11',
];
const NEWER_READS = NEWER_IDS_1113.map((id) => ({
  release_id: id,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-13T08:18:00Z',
  read_at: '2026-11-13T08:18:00Z',
}));
const NEWER_SEEN: Record<string, boolean> = Object.fromEntries(
  NEWER_IDS_1113.map((id) => [id, true]),
);
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** Staff who place orders, where Returns is on. */
const requester: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:request'],
  enabledModules: ['orders', 'returns'],
};
/** Staff who place orders, where Returns is off. */
const requesterReturnsOff: ReleaseViewer = {
  role: 'staff',
  permissions: ['orders:request'],
  enabledModules: ['orders'],
};
/** Someone who reads returns and places no orders, where Returns is on. */
const returnsReader: ReleaseViewer = {
  role: 'staff',
  permissions: ['returns:read'],
  enabledModules: ['returns'],
};
/** Someone who reads returns, where Returns is off. */
const returnsReaderModuleOff: ReleaseViewer = {
  role: 'staff',
  permissions: ['returns:read', 'returns:manage'],
  enabledModules: ['orders'],
};

/** A source file under apps/web/src, as written. */
const source = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');
/** A file under apps/mobile, as written. */
const mobile = (rel: string) => readFileSync(resolve(__dirname, '../../../../mobile', rel), 'utf8');

/** Every string a reader can see in a release. */
function readerText(r: Release): string[] {
  return [
    r.title,
    r.summary,
    ...r.entries.flatMap((e) => [
      e.title,
      e.area ?? '',
      e.whatChanged,
      e.whyItMatters,
      e.howItAffectsYou,
      e.whatToDo,
      e.link?.label ?? '',
    ]),
  ];
}

const told = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id);

const UPDATE_WORDS =
  'To load the latest update, tap Restart now when the app says Update ready, or close the app completely and open it again.';

describe('the phone appearance and returns release: order, status and date', () => {
  it('is published once, as revision 1, directly below the Liquid Glass draft at the top, above the returns request and names release, and no draft but the Liquid Glass release is left', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES[0]?.id).toBe('liquid-glass-2026-11');
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    expect(RELEASES[7]?.id).toBe(ID);
    expect(RELEASES[8]?.id).toBe(RETURNS_REQUEST_ID);
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: this release, the newest published): the Release count, AI Assistant and not found releases are published later, directly above it.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: RELEASES.slice(1, 4), without it): the emailed links release is published later, directly above the Release count release.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: RELEASES.slice(1, 5), without them): the phone authenticator code and access check releases are published later, directly above the emailed links release.
    expect(RELEASES.slice(1, 7).map((r) => [r.id, r.status])).toEqual([
      ['phone-authenticator-code-2026-11', 'published'],
      ['phone-access-check-retry-2026-11', 'published'],
      ['emailed-links-name-their-account-2026-11', 'published'],
      ['cycle-count-already-released-2026-11', 'published'],
      ['ai-assistant-plain-words-2026-11', 'published'],
      ['changes-that-did-not-happen-2026-11', 'published'],
    ]);
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: the Release count release): the emailed links release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: the emailed links release): the phone authenticator code release is published after it, at the top, the newest published release.
      'phone-authenticator-code-2026-11',
    );
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'liquid-glass-2026-11',
    ]);
    // Permanent, unused anywhere else, and ends in the month it went out.
    expect(ID).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-2026-11$/);
    for (const e of [OWN_ORDER, RETURN_SCREEN, APPEARANCE, ONE_DRAFT, TOASTS]) {
      expect(
        RELEASES.flatMap((r) => r.entries).filter((x) => x.id === e),
        e,
      ).toHaveLength(1);
      expect(
        RELEASES.some((r) => r.id === e),
        e,
      ).toBe(false);
    }
  });

  it('leaves the returns request and names release as it was announced: revision 1, its words unchanged', () => {
    const returns = RELEASES.find((r) => r.id === RETURNS_REQUEST_ID)!;
    expect(returns.revision).toBe(1);
    expect(returns.summary).toContain('The mobile app gets the button with its next update.');
  });

  it('is dated in the past on a whole minute, at or after the web fixes went live and the phone update was published, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    // #502 and #504 went live at 19:18Z; the phone update was published about 19:22Z.
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-12T19:18:00Z'));
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-12T19:22:00Z'));
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    for (const r of RELEASES.slice(8)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('keeps the Liquid Glass draft above it no older than it, so dates never increase going down', () => {
    expect(Date.parse(RELEASES[0]!.publishedAt)).toBeGreaterThanOrEqual(
      Date.parse(release().publishedAt),
    );
  });

  it('is in the fingerprint, so publishing it changes what clients observe', () => {
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
  });

  it('marks the two Liquid Glass draft entries it partly announces for rewording at G5', () => {
    const text = readFileSync(resolve(__dirname, 'registry.ts'), 'utf8');
    const draft = text.slice(0, text.indexOf(`id: '${ID}'`));
    for (const id of ['liquid-glass-mobile-app', 'mobile-appearance-settings']) {
      const before = draft.slice(0, draft.indexOf(`id: '${id}'`));
      const comment = before.slice(before.lastIndexOf('RECHECK'));
      expect(comment, id).toContain(`partly announced in '${ID}' on 2026-11-12`);
    }
  });
});

describe('the phone appearance and returns release: what it says', () => {
  it('has five entries that answer the four questions, the one link the returns pages open for, and no draft words', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      OWN_ORDER,
      RETURN_SCREEN,
      APPEARANCE,
      ONE_DRAFT,
      TOASTS,
    ]);
    expect(release().audience).toBeUndefined();
    expect([entry(OWN_ORDER).category, entry(OWN_ORDER).area]).toEqual(['new', 'Mobile app']);
    expect([entry(RETURN_SCREEN).category, entry(RETURN_SCREEN).area]).toEqual([
      'new',
      'Mobile app',
    ]);
    expect([entry(APPEARANCE).category, entry(APPEARANCE).area]).toEqual(['new', 'Mobile app']);
    expect([entry(ONE_DRAFT).category, entry(ONE_DRAFT).area]).toEqual(['fixed', 'Returns']);
    expect([entry(TOASTS).category, entry(TOASTS).area]).toEqual(['fixed', 'Web app']);
    expect(entry(RETURN_SCREEN).link).toEqual({
      href: '/dashboard/returns',
      label: 'Open Returns',
    });
    for (const id of [OWN_ORDER, APPEARANCE, ONE_DRAFT, TOASTS]) {
      expect(entry(id).link, id).toBeUndefined();
    }
    for (const e of release().entries) {
      for (const answer of [e.whatChanged, e.whyItMatters, e.howItAffectsYou]) {
        expect(answer.length, e.id).toBeGreaterThan(0);
      }
    }
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(ed)?\b/i);
    expect(text).not.toMatch(/!|%|guarantee|verified|instantly|faster|seamless|one click/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/react|aria-|#\d+|\bbug\b|F14|toast|sonner|opt-in|rollout/i);
    // Never a claim StockPilot cannot observe: it opens a draft, the person sends it.
    expect(text).not.toMatch(
      /email sent|was sent|we sent|is sent to|notif(y|ied)|ticket (is )?created/i,
    );
    expect(text).not.toMatch(/\bnever\b|\balways\b/i);
    // Not shown under opt-in, so not told: the one-time card on Home.
    expect(text).not.toMatch(/Keep Liquid Glass|Use classic design|one-time card/i);
    // The footnote names Reduce Motion, but no glass code reads it.
    expect(text).not.toMatch(/Reduce Motion/);
  });

  it('starts the summary, all an old phone build shows, with the mobile app, and says how to get the update', () => {
    expect(release().summary).toMatch(/^In the mobile app, after the latest update, /);
    expect(release().summary).toContain(
      'It opens a prefilled email in Outlook or your email app; StockPilot does not send it, you press Send yourself.',
    );
    expect(release().summary).toMatch(
      /Tap Restart now when the app says Update ready, or close the app completely and open it again\.$/,
    );
    for (const id of [OWN_ORDER, RETURN_SCREEN]) {
      expect(entry(id).whatToDo, id).toBe(UPDATE_WORDS);
    }
    expect(entry(APPEARANCE).whatToDo.startsWith(UPDATE_WORDS)).toBe(true);
    for (const id of [ONE_DRAFT, TOASTS]) {
      expect(entry(id).whatToDo, id).toBe('No action needed.');
    }
  });

  it('says nothing is sent for the reader: the email opens in their own email app and they press Send', () => {
    expect(entry(OWN_ORDER).howItAffectsYou).toMatch(
      /^Nothing is sent for you: the email opens in Outlook or your email app, you check it and press Send yourself, and StockPilot does not create a ticket\./,
    );
    expect(entry(RETURN_SCREEN).howItAffectsYou).toMatch(
      /^Nothing is sent for you: the email opens in Outlook or your email app, and you press Send yourself\./,
    );
  });

  it('says plainly that a choice made on the website follows the account to the phone, and from when', () => {
    expect(entry(APPEARANCE).whatChanged).toContain(
      'The app stays in Classic unless you choose Liquid Glass, as on the website.',
    );
    expect(entry(APPEARANCE).howItAffectsYou).toContain(
      'If you chose Liquid Glass, Light or Dark on the website since 11 November, the app now uses that choice too',
    );
  });
});

describe('the phone appearance and returns release: who is told', () => {
  it('tells each reader only the entries they can use', () => {
    expect(entry(OWN_ORDER).audience).toEqual({
      anyPermission: ['orders:request'],
      modules: ['returns'],
    });
    expect(entry(RETURN_SCREEN).audience).toEqual({
      anyPermission: ['returns:read', 'returns:manage'],
      modules: ['returns'],
    });
    expect(entry(ONE_DRAFT).audience).toEqual({
      anyPermission: ['orders:request', 'returns:read', 'returns:manage'],
      modules: ['returns'],
    });
    // A personal setting every member has, and a look any member may choose.
    expect(entry(APPEARANCE).audience).toBeUndefined();
    expect(entry(TOASTS).audience).toBeUndefined();
    expect(told(everyone)).toEqual([OWN_ORDER, RETURN_SCREEN, APPEARANCE, ONE_DRAFT, TOASTS]);
    expect(told(requester)).toEqual([OWN_ORDER, APPEARANCE, ONE_DRAFT, TOASTS]);
    expect(told(returnsReader)).toEqual([RETURN_SCREEN, APPEARANCE, ONE_DRAFT, TOASTS]);
    for (const v of [member, requesterReturnsOff, returnsReaderModuleOff]) {
      expect(told(v), v.role).toEqual([APPEARANCE, TOASTS]);
    }
  });

  it('is the first notice for every member, and an old phone build lists it first with its title and summary', () => {
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top; an owner with every permission and module reads or sees them first (NEWER_READS, NEWER_SEEN), and every notice this test checks is the one it checked before.
    for (const v of [everyone, member, requester, returnsReader, requesterReturnsOff]) {
      expect(buildReleaseList(RELEASES, v, NEWER_READS, null).latestUnread?.id, v.role).toBe(ID);
    }
    // The first link the reader is told about, if any.
    for (const v of [everyone, returnsReader]) {
      expect(legacyAnnouncementsFor(RELEASES, v, NEWER_SEEN)[0], v.role).toEqual({
        id: ID,
        date: '2026-11-12',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/returns', label: 'Open Returns' },
      });
    }
    for (const v of [member, requester]) {
      expect(legacyAnnouncementsFor(RELEASES, v, NEWER_SEEN)[0], v.role).toEqual({
        id: ID,
        date: '2026-11-12',
        title: release().title,
        body: release().summary,
      });
    }
  });
});

describe('the phone appearance and returns release: the code its words rest on', () => {
  it('names the phone button and section as the screens show them, from the same words as the website', () => {
    expect(RETURN_REQUEST_COPY.primary).toBe('Email return request');
    expect(RETURN_REQUEST_COPY.title).toBe('Send return request');
    expect(RETURN_REQUEST_COPY.copy).toBe('Copy details');
    expect(RETURNS_COPY.requesterYourRequests).toBe('Your requests on this order');
    expect(RETURN_REQUEST_COPY.honesty).toContain(
      'StockPilot does not send it and does not create a ticket.',
    );
    const section = mobile('src/components/return-request-section.tsx');
    expect(section).toContain('{RETURN_REQUEST_COPY.primary}');
    expect(section).toContain('{RETURN_REQUEST_COPY.honesty}');
    expect(section).toContain('{RETURN_REQUEST_COPY.copy}');
    expect(section).toContain('value={prepared.clipboardText}');
  });

  it('puts the section under the requester’s own open requests, and on the return screen with Report a problem', () => {
    const order = mobile('app/order/[id].tsx');
    expect(order).toContain('<Eyebrow>{RETURNS_COPY.requesterYourRequests}</Eyebrow>');
    expect(order).toContain(
      'const content = returnRequestContentForTracking(t, returnRequestEmail);',
    );
    expect(order).toContain('viewerCanManageReturns: canManageReturns,');
    const workbench = mobile('src/components/return-workbench-view.tsx');
    expect(workbench).toContain('{requestContent && requestEmail.recipients ? (');
    expect(workbench).toContain(
      "enabledModules.has('maintenance_requests') && showWriteCta(permissions, 'maintenance_requests:submit');",
    );
    expect(workbench).toContain('{RETURN_PROBLEM_LABEL}');
    const actions = mobile('src/lib/return-request-actions.ts');
    expect(actions).toContain("export const RETURN_PROBLEM_LABEL = 'Report a problem';");
    expect(actions).toContain('subject: `Return ${ret.returnNumber}: `');
    expect(actions).toContain(
      'if (!canSendReturnRequest(workbench.return.status, workbench.return.returnNumber)) return null;',
    );
    expect(mobile('app/(drawer)/returns.tsx')).toContain(
      "const canRead = showWriteCta(perms, 'returns:read') || showWriteCta(perms, 'returns:manage');",
    );
  });

  it('replaces the Theme row with Appearance whenever Liquid Glass is not switched off, with the words the release uses', () => {
    const settings = mobile('app/(drawer)/settings.tsx');
    expect(settings).toContain('{appearance.glassEnabled ? (');
    expect(settings).toContain('title="Appearance"');
    expect(mobile('src/lib/appearance/controller.ts')).toContain('glassEnabled: !inert,');
    const labels = mobile('src/lib/appearance/labels.ts');
    for (const word of ["label: 'Liquid Glass'", "label: 'Classic'"]) {
      expect(labels, word).toContain(word);
    }
    expect(labels).toContain(
      "{ theme: 'light', label: 'Light', detail: 'Light, whatever your phone is set to.' }",
    );
    expect(labels).toContain(
      "{ theme: 'dark', label: 'Dark', detail: 'Dark, whatever your phone is set to.' }",
    );
    expect(labels).toContain(
      "{ theme: 'system', label: 'System', detail: 'Light or Dark, following your phone.' }",
    );
    expect(labels).toContain("return { text: 'Saved to your account.', retry: false };");
    expect(labels).toContain(
      "return { text: 'Saved on this phone. Not saved to your account yet.', retry: true };",
    );
    const screen = mobile('app/(drawer)/settings/appearance.tsx');
    expect(screen).toContain('Try again');
    expect(screen).toContain('accessibilityLabel="Design"');
    expect(screen).toContain('accessibilityLabel="Theme"');
  });

  it('shows Classic unless the person chose Liquid Glass under opt-in, and no Home card', () => {
    expect(defaultStyle('opt-in')).toBe('classic');
    expect(shownStyle(null, 'opt-in', false)).toBe('classic');
    expect(shownStyle('liquid-glass', 'opt-in', false)).toBe('liquid-glass');
    expect(mobile('src/lib/appearance/controller.ts')).toContain(
      "introVisible:\n        rollout === 'default' &&",
    );
  });

  it('saves to the account the website shares, and Reduce Transparency makes Liquid Glass solid', () => {
    const account = mobile('src/lib/appearance/account.ts');
    expect(account).toContain(".from('user_appearance')");
    expect(account).toContain(".upsert(values, { onConflict: 'user_id' })");
    expect(source('components/theme/theme-toggle.tsx')).toContain(
      "<DropdownMenuItem onClick={() => chooseTheme('dark')}>",
    );
    expect(mobile('src/lib/appearance/material.ts')).toContain(
      "if (inputs.reduceTransparency) return 'opaque';",
    );
  });

  it('opens one draft per double click on the website, and puts Liquid Glass toasts where Classic does', () => {
    const action = source('components/returns/return-request-action.tsx');
    expect(action).toContain('export const RETURN_REQUEST_PRESS_BURST_MS = 1000;');
    expect(action).toContain('if (burstRef.current) return; // The same press: one draft.');
    expect(action).toContain('disabled={!prepared.linkFits || opening}');
    const css = source('styles/liquid-glass/globals.glass.css');
    expect(css).not.toMatch(/ol\[data-sonner-toaster\][^{]*\{[^}]*left:\s*calc\(50%/);
    expect(css).toContain('The toast dock: bottom right, where Classic puts it');
  });
});
