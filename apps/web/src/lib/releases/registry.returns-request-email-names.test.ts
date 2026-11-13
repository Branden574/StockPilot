import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  RETURN_REQUEST_COPY,
  RETURN_REQUEST_SENDABLE_STATUSES,
  RETURNS_COPY,
  canSendReturnRequest,
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
 * Added by docs/whatsnew-returns-1112 (2026-11-12): the release for two web
 * changes live on production since 2026-11-12, published at the top, below the
 * Liquid Glass draft and above the Add all release:
 *
 *  - #498: "Send return request" on a member's own order and on the return
 *    page, a prefilled email draft the person sends themselves. The phone's
 *    half is merged but reaches phones only with the next phone update, so the
 *    words say "on the website" and that the mobile app gets the button with
 *    its next update.
 *  - #499: the Returns list and the return page name the person the order was
 *    for, and Returns search finds returns by that person's name or email. The
 *    phone's list and return screen already show the server's name (since
 *    #322), so the phone is named for these.
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin the release's id, status, revision, date and order,
 * who each entry reaches, and the code its words rest on.
 */
const ID = 'returns-request-email-names-2026-11';
const OWN_ORDER = 'returns-send-request-own-order';
const RETURN_PAGE = 'returns-send-request-return-page';
const NAMES = 'returns-requester-names';
const ADD_ALL_ID = 'order-add-all-2026-11';
// Added by docs/whatsnew-phone-1112 (2026-11-12): the phone appearance and returns release, published
// later, at the top, directly above this one. It reaches every member (its Appearance entry has no audience).
const PHONE_APPEARANCE_ID = 'phone-appearance-returns-2026-11';
// Added by docs/whats-new-2026-11-13 (2026-11-13): the Release count, AI Assistant and not found
// releases, published later, at the top, read or seen. Each reaches an owner with every permission
// and module or nobody here, so a test that expects an older notice reads or sees them first, and
// the notice it checks is the one it checked before.
const NEWER_IDS_1113 = [
  // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
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
/** Someone who manages returns, where Returns is on. */
const returnsManager: ReleaseViewer = {
  role: 'manager',
  permissions: ['returns:manage', 'orders:request'],
  enabledModules: ['orders', 'returns'],
};
/** Someone who reads returns, where Returns is off. */
const returnsReaderModuleOff: ReleaseViewer = {
  role: 'staff',
  permissions: ['returns:read', 'returns:manage'],
  enabledModules: ['orders'],
};

/** A source file under apps/web/src, as written. */
const source = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');
/** A source file under apps/mobile/src, as written. */
const mobile = (rel: string) =>
  readFileSync(resolve(__dirname, '../../../../mobile/src', rel), 'utf8');

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

describe('the returns request and names release: order, status and date', () => {
  // Renamed by docs/whatsnew-phone-1112 (2026-11-12; was: "is published once, as revision 1, directly below the Liquid Glass draft at the top, above the Add all release, and no draft but the Liquid Glass release is left"): the phone appearance and returns release is published later, between the Liquid Glass draft and this one. Claim kept: published once, at revision 1, above the Add all release, and no other draft is left.
  it('is published once, as revision 1, below the Liquid Glass draft and the phone appearance and returns release at the top, above the Add all release, and no draft but the Liquid Glass release is left', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    expect(release().withdrawnNote).toBeUndefined();
    expect(RELEASES[0]?.id).toBe('liquid-glass-2026-11');
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher, and this release the newest published): the phone appearance and returns release is published later, at the top, below the Liquid Glass draft and directly above this one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[5]?.id).toBe(PHONE_APPEARANCE_ID);
    expect(RELEASES[6]?.id).toBe(ID);
    expect(RELEASES[7]?.id).toBe(ADD_ALL_ID);
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: the phone appearance and returns release): the Release count release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: the Release count release): the emailed links release is published after it, at the top, the newest published release.
      'emailed-links-name-their-account-2026-11',
    );
    expect(RELEASES.filter((r) => r.status === 'draft').map((r) => r.id)).toEqual([
      'liquid-glass-2026-11',
    ]);
    // Permanent, unused anywhere else, and ends in the month it went out.
    expect(ID).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-2026-11$/);
    for (const e of [OWN_ORDER, RETURN_PAGE, NAMES]) {
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

  it('is dated in the past on a whole minute, at or after both changes went live, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    // #498 went live at 08:38Z and #499 at 08:42Z.
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-12T08:38:00Z'));
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-12T08:42:00Z'));
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(7)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
    // Added by docs/whatsnew-phone-1112 (2026-11-12): the release above it is dated later.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(Date.parse(RELEASES[5]!.publishedAt)).toBeGreaterThan(at);
  });

  it('keeps the Liquid Glass draft above it no older than it, so dates never increase going down', () => {
    const draft = RELEASES[0]!;
    expect(Date.parse(draft.publishedAt)).toBeGreaterThanOrEqual(Date.parse(release().publishedAt));
  });

  it('is in the fingerprint, so publishing it changes what clients observe', () => {
    expect(registryFingerprint(RELEASES)).toContain(`${ID}@1:published`);
  });
});

describe('the returns request and names release: what it says', () => {
  it('has three entries that answer the four questions, with the links the returns pages open for, and no draft words', () => {
    expect(release().entries.map((e) => e.id)).toEqual([OWN_ORDER, RETURN_PAGE, NAMES]);
    expect(release().audience).toBeUndefined();
    expect([entry(OWN_ORDER).category, entry(OWN_ORDER).area]).toEqual(['new', 'Orders']);
    expect([entry(RETURN_PAGE).category, entry(RETURN_PAGE).area]).toEqual(['new', 'Returns']);
    expect([entry(NAMES).category, entry(NAMES).area]).toEqual(['improved', 'Returns']);
    // The button on one order has no list page to link to.
    expect(entry(OWN_ORDER).link).toBeUndefined();
    for (const id of [RETURN_PAGE, NAMES]) {
      expect(entry(id).link, id).toEqual({ href: '/dashboard/returns', label: 'Open Returns' });
    }
    for (const e of release().entries) {
      for (const answer of [e.whatChanged, e.whyItMatters, e.howItAffectsYou]) {
        expect(answer.length, e.id).toBeGreaterThan(0);
      }
      expect(e.whatToDo, e.id).toBe('No action needed.');
    }
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/\bbook(ed)?\b/i);
    expect(text).not.toMatch(/!|%|guarantee|verified|instantly|faster|seamless|one click/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/react|aria-|#\d+|\bbug\b|F14|B117|requesterName/i);
    // Never a claim StockPilot cannot observe: it opens a draft, the person sends it.
    expect(text).not.toMatch(
      /email sent|was sent|we sent|is sent to|notif(y|ied)|ticket (is )?created/i,
    );
    expect(text).not.toMatch(/\bnever\b|\balways\b/i);
  });

  it('says nothing is sent for the reader: the email opens in their own email app and they press Send', () => {
    expect(release().summary).toContain(
      'It opens a prefilled email in Outlook or your email app; StockPilot does not send it, you press Send yourself.',
    );
    expect(entry(OWN_ORDER).howItAffectsYou).toMatch(
      /^Nothing is sent for you: the email opens in Outlook or your email app, you check it and press Send yourself, and StockPilot does not create a ticket\./,
    );
    expect(entry(RETURN_PAGE).howItAffectsYou).toMatch(
      /^Nothing is sent for you: the email opens in Outlook or your email app, and you press Send yourself\./,
    );
  });

  it('says where the button is: on the website now, in the mobile app with its next update', () => {
    const summary = release().summary;
    // Old phone builds show only the title and the summary, so the summary
    // itself says the phone does not have the button yet.
    expect(summary).toMatch(
      /^On the website, an open return now has a Send return request button, /,
    );
    expect(summary).toContain('The mobile app gets the button with its next update.');
    for (const id of [OWN_ORDER, RETURN_PAGE]) {
      expect(entry(id).whatChanged, id).toMatch(/^On the website, /);
      expect(entry(id).howItAffectsYou, id).toMatch(
        /The mobile app gets the button with its next update\.$/,
      );
    }
    // Nothing tells a phone to restart for it: no phone update carries the button yet.
    expect(readerText(release()).join(' ')).not.toMatch(/Restart now|Update ready|close the app/i);
  });

  it('names the phone only for the names and the search, which its live screens already show', () => {
    expect(entry(NAMES).howItAffectsYou).toMatch(
      /^The Returns list and return screen in the mobile app show the same names, and its search finds the same returns\./,
    );
    // The new words for a return with no name are website code only.
    expect(entry(NAMES).howItAffectsYou).toContain(
      'On the website, a return with no name or email to show now says Opened by staff or Opened by the requester.',
    );
  });
});

describe('the returns request and names release: who is told', () => {
  it('tells each reader only the entries they can use', () => {
    expect(entry(OWN_ORDER).audience).toEqual({
      anyPermission: ['orders:request'],
      modules: ['returns'],
    });
    for (const id of [RETURN_PAGE, NAMES]) {
      expect(entry(id).audience, id).toEqual({
        anyPermission: ['returns:read', 'returns:manage'],
        modules: ['returns'],
      });
    }
    expect(told(everyone)).toEqual([OWN_ORDER, RETURN_PAGE, NAMES]);
    expect(told(returnsManager)).toEqual([OWN_ORDER, RETURN_PAGE, NAMES]);
    expect(told(requester)).toEqual([OWN_ORDER]);
    expect(told(returnsReader)).toEqual([RETURN_PAGE, NAMES]);
    for (const [name, v] of [
      ['member', member],
      ['requesterReturnsOff', requesterReturnsOff],
      ['returnsReaderModuleOff', returnsReaderModuleOff],
    ] as const) {
      expect(told(v), name).toBeUndefined();
    }
  });

  // Renamed by docs/whatsnew-phone-1112 (2026-11-12; was: "is the first notice for whoever it reaches, and a member it does not reach keeps their notice"): the phone appearance and returns release is published later, at the top, and reaches every member, so it is read or seen first. Claim kept: once that newer release is read, this is the first notice for whoever it reaches, and a member it does not reach is not told it.
  it('is the first notice for whoever it reaches once the phone appearance and returns release is read, and a member it does not reach keeps their notice', () => {
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top; an owner with every permission and module reads or sees them first (NEWER_READS, NEWER_SEEN), and every notice this test checks is the one it checked before.
    // Added by docs/whatsnew-phone-1112 (2026-11-12): the newer release, read or seen.
    const phoneRead = {
      release_id: PHONE_APPEARANCE_ID,
      revision: 1,
      dismissed_at: null,
      opened_at: '2026-11-12T19:30:00Z',
      read_at: '2026-11-12T19:30:00Z',
    };
    const phoneSeen = { [PHONE_APPEARANCE_ID]: true };
    for (const v of [everyone, requester, returnsReader, returnsManager, member]) {
      expect(buildReleaseList(RELEASES, v, NEWER_READS, null).latestUnread?.id, v.role).toBe(
        PHONE_APPEARANCE_ID,
      );
    }
    for (const v of [everyone, requester, returnsReader, returnsManager]) {
      expect(
        buildReleaseList(RELEASES, v, [...NEWER_READS, phoneRead], null).latestUnread?.id,
        v.role,
      ).toBe(ID);
    }
    // An old phone build shows the title and the summary, with the first link
    // the reader is told about.
    for (const v of [everyone, returnsReader]) {
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...phoneSeen, ...NEWER_SEEN })[0],
        v.role,
      ).toEqual({
        id: ID,
        date: '2026-11-12',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/returns', label: 'Open Returns' },
      });
    }
    expect(legacyAnnouncementsFor(RELEASES, requester, { ...phoneSeen, ...NEWER_SEEN })[0]).toEqual(
      {
        id: ID,
        date: '2026-11-12',
        title: release().title,
        body: release().summary,
      },
    );
    for (const v of [member, requesterReturnsOff, returnsReaderModuleOff]) {
      expect(
        buildReleaseList(RELEASES, v, [...NEWER_READS, phoneRead], null).latestUnread?.id,
        v.role,
      ).not.toBe(ID);
      expect(
        legacyAnnouncementsFor(RELEASES, v, {}).map((a) => a.id),
        v.role,
      ).not.toContain(ID);
    }
  });
});

describe('the returns request and names release: the code its words rest on', () => {
  it('names the button, the dialog buttons and the section as the pages show them', () => {
    expect(RETURN_REQUEST_COPY.title).toBe('Send return request');
    expect(RETURN_REQUEST_COPY.copy).toBe('Copy details');
    expect(RETURNS_COPY.requesterYourRequests).toBe('Your requests on this order');
    expect(entry(OWN_ORDER).whatChanged).toContain(
      'each open request under Your requests on this order now has a Send return request button',
    );
    const action = source('components/returns/return-request-action.tsx');
    expect(action).toContain("opened = window.open(prepared.outlookUrl, '_blank');");
    expect(action).toContain('window.location.assign(prepared.mailtoUrl);');
    expect(action).toContain('{RETURN_REQUEST_COPY.copy}');
  });

  it('opens a draft and sends nothing, in the words the dialog itself shows', () => {
    expect(RETURN_REQUEST_COPY.honesty).toBe(
      'This opens a draft email. StockPilot does not send it and does not create a ticket. Review the message and press Send in your mail app.',
    );
  });

  it('offers the button only while the return is open and numbered, and only with saved mailboxes', () => {
    expect([...RETURN_REQUEST_SENDABLE_STATUSES]).toEqual(['requested', 'approved', 'received']);
    expect(canSendReturnRequest('approved', 'RMA-1')).toBe(true);
    for (const status of ['closed', 'denied', 'cancelled']) {
      expect(canSendReturnRequest(status, 'RMA-1'), status).toBe(false);
    }
    expect(canSendReturnRequest('approved', null)).toBe(false);
    const button = source('components/returns/send-return-request-button.tsx');
    expect(button).toContain('if (!content || !recipients) return null;');
    expect(button).toContain(
      'if (!canSendReturnRequest(content.status, content.returnNumber)) return null;',
    );
    expect(source('server/services/return-request-email.ts')).toContain(
      "if (routing.state !== 'valid') return null;",
    );
  });

  it('puts the button on the requester’s own order, and leaves those who manage returns to the return page', () => {
    const page = source('app/(dashboard)/dashboard/orders/[id]/page.tsx');
    expect(page).toContain(
      "const returnRequestGate = isOwnRequest && !can(ctx, 'returns:manage') && returnsModuleGate;",
    );
    expect(page).toContain('requesterTrackingEligible && returnRequestSendable && returnRequestRecipients');
    expect(source('components/returns/requester-tracking.tsx')).toContain(
      '<SendReturnRequestButton',
    );
  });

  it('puts Send return request and Report a problem on the return page, and the mailbox note for who can change settings', () => {
    const page = source('app/(dashboard)/dashboard/returns/[id]/page.tsx');
    expect(page).toContain("if (!can(ctx, 'returns:read') && !can(ctx, 'returns:manage')) {");
    expect(page).toContain("showRoutingHint: can(ctx, 'organization:update'),");
    expect(page).toContain("const maintenanceGate = can(ctx, 'maintenance_requests:submit');");
    const workbench = source('components/returns/return-workbench.tsx');
    expect(workbench).toContain('actions={headerActions}');
    expect(workbench).toContain(
      'subject: r.returnNumber ? `Return ${r.returnNumber}: ` : undefined,',
    );
    expect(workbench).toContain('orderRequestId: r.orderRequestId,');
    expect(workbench).toContain('href="/dashboard/settings/email-routing"');
    expect(entry(RETURN_PAGE).howItAffectsYou).toContain('a link to Settings, Email routing');
  });

  it('names the person the order was for, else their email, and says how a return was opened when there is neither', () => {
    const svc = source('server/services/returns-workbench.ts');
    expect(svc).toContain('const name = r.full_name?.trim() || r.email;');
    expect(svc.split('requesterName: requesterLabelOf({').length - 1).toBe(2);
    const list = source('app/(dashboard)/dashboard/returns/page.tsx');
    expect(list).toContain('<TableHead>Requester</TableHead>');
    expect(list).toContain('{r.requesterName ?? r.requesterEmail ?? (');
    expect(list).toContain(
      "{r.source === 'requester' ? 'Opened by the requester' : 'Opened by staff'}",
    );
    expect(source('components/returns/return-workbench.tsx')).toContain(
      '<> · {r.requesterName ?? r.requesterEmail}</>',
    );
  });

  it('searches people by name or email beside RMA and SO numbers, and says when too many people match', () => {
    const svc = source('server/services/returns-workbench.ts');
    expect(svc).toContain(
      ".or(`full_name.ilike.%${q}%,email.ilike.%${q}%`, { referencedTable: 'user_profiles' })",
    );
    expect(svc).toContain('export const RETURN_SEARCH_MAX_MEMBERS = 500;');
    expect(RETURNS_COPY.listSearchPlaceholder).toBe('Search RMA, SO number or requester');
    expect(RETURNS_COPY.listSearchTooManyPeople).toContain('Type more of the name');
    expect(source('app/(dashboard)/dashboard/returns/page.tsx')).toContain(
      "page.requesterSearch === 'too_many'",
    );
  });

  it('the phone’s live returns screens show the server’s name and search through the same list', () => {
    expect(mobile('lib/returns-view.ts')).toContain('row.requesterName ?? row.requesterEmail ??');
    expect(mobile('components/return-workbench-view.tsx')).toContain(
      '[r.requesterName ?? r.requesterEmail, r.warehouseName,',
    );
    expect(mobile('lib/returns-api.ts')).toContain(
      'if (query.q && query.q.trim()) params.push(`q=${encodeURIComponent(query.q.trim())}`);',
    );
    expect(source('app/api/v1/returns/route.ts')).toContain("q: url.searchParams.get('q'),");
  });

  it('the phone’s button is in the same merge, so the next phone update carries it', () => {
    expect(mobile('components/return-request-section.tsx')).toContain(
      '{RETURN_REQUEST_COPY.primary}',
    );
    expect(mobile('components/return-workbench-view.tsx')).toContain('<ReturnRequestSection');
    expect(
      readFileSync(resolve(__dirname, '../../../../mobile/app/order/[id].tsx'), 'utf8'),
    ).toContain('<ReturnRequestSection');
  });
});
