import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { ANNOUNCEMENTS } from '@/lib/onboarding/announcements';

import {
  buildReleaseList,
  legacyAnnouncementsFor,
  registryFingerprint,
  visibleReleases,
} from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-s43a-2026-11 (2026-11-02): two releases published
 * together, directly below the B44 phone update draft, which is dated later
 * and stays a draft.
 * Re-pinned by docs/whats-new-2026-11-02 (2026-11-02; was: below the B44
 * phone update draft at RELEASES[0]): that draft is folded into
 * update-ready-and-fixes-2026-11, published at 04:21Z and so placed below the
 * lists-delivery-sites-and-fixes release, so these two are at the top and no
 * draft is left.
 *
 * - authenticator-code-requests-2026-11: S43a, #447 (squash dd7cc1458,
 *   merged 06:49:05Z; web build 2f1ae1d0e877). No phone update ships with
 *   it: every phone line is how the app already installed answers the
 *   server's new 401.
 * - integration-retries-2026-11: B49, B81 and B82, #454 (squash 472fca631,
 *   merged 15:33:44Z; web build 7a9a39fee322), a minute older, directly below.
 *
 * Its own file, so the release tests other open branches edit stay as they
 * are. These tests pin what a published release must hold (its id, status,
 * revision and date, its entries, its links and who they reach, the notice
 * and the old phone builds' list) and the code its words rest on.
 */
const AUTH_CODE_ID = 'authenticator-code-requests-2026-11';
const RETRIES_ID = 'integration-retries-2026-11';
const LISTS_ID = 'lists-delivery-sites-and-fixes-2026-11';
const byId = (id: string) => RELEASES.find((r) => r.id === id)!;

const everyone: ReleaseViewer = {
  role: 'owner',
  permissions: [...PERMISSIONS],
  enabledModules: Object.keys(MODULE_REGISTRY) as ModuleId[],
};
/** A member who holds no permission and no module. */
const member: ReleaseViewer = { role: 'viewer', permissions: [], enabledModules: [] };
/** Manages integrations where the Integrations module is on. */
const integrator: ReleaseViewer = {
  role: 'admin',
  permissions: ['integrations:manage'],
  enabledModules: ['integrations'],
};

/**
 * Added by docs/whats-new-2026-11-02d (2026-11-02): the Export items, phone
 * update, clearer web messages and QW1 releases, published later still, at
 * the top. All four reach every member (each has an entry with no
 * audience), so they are read or seen with the releases below them.
 */
const NIGHT_IDS = [
  // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: without it): the S2 release is published later, at the top, and reaches an owner, so it is read or seen with the newer releases.
  // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: without it): the count sheet release is published later, at the top, and reaches an owner with every permission and module, so it is read, seen or listed with the newer releases, and every older notice these lead to is the one each test checked before.
  // Re-pinned by feat/order-add-all (2026-11-10; was: without it): the Add all release is published later, at the top, and reaches whoever may place orders where Orders is on, an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every older notice these lead to is the one each test checked before.
  // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: without it): the returns request and names release is published later, at the top, and reaches returns readers and requesters where Returns is on, an owner with every permission and module included, so it is read, seen or listed with the newer releases, and every older notice these lead to is the one each test checked before.
  // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: without it): the phone appearance and returns release is published later, at the top, and reaches every member (its Appearance entry has no audience), so it is read, seen or listed with the newer releases, and every older notice these lead to is the one each test checked before.
  // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: without them): the Release count, AI Assistant and not found releases are published later, at the top, and reach an owner with every permission and module, so they are read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: without it): the emailed links release is published later, at the top, and reaches every member (it has no audience), so it is read, seen or listed with the newer releases, and every notice this test checks is the one it checked before.
  'emailed-links-name-their-account-2026-11',
  'cycle-count-already-released-2026-11',
  'ai-assistant-plain-words-2026-11',
  'changes-that-did-not-happen-2026-11',
  'phone-appearance-returns-2026-11',
  'returns-request-email-names-2026-11',
  'order-add-all-2026-11',
  'count-sheet-long-names-2026-11',
  'approver-controls-own-warehouses-2026-11',
  'export-items-permission-2026-11',
  'mobile-app-fixes-2026-11-02',
  'clearer-web-messages-2026-11',
  'invites-calendar-record-pages-2026-11',
];
/**
 * Added by docs/whats-new-2026-11-02c (2026-11-02): the web fixes and archived
 * charters releases, published later at the top, read or seen. They reach an
 * owner and an admin, so a test that expects this file's releases to be such a
 * reader's notice reads or sees them first (a read of a release a reader is
 * not told changes nothing).
 */
const WEB_FIXES_ID = 'web-fixes-2026-11-02';
const CHARTERS_ID = 'archived-charters-2026-11';
// Re-pinned by docs/whats-new-2026-11-02d (2026-11-02; was: WEB_FIXES_ID and CHARTERS_ID alone): the releases in NIGHT_IDS are published later, at the top.
const laterReads = () => [...NIGHT_IDS, WEB_FIXES_ID, CHARTERS_ID].map((id) => read(id));
const laterSeen = (): Record<string, boolean> => ({
  ...Object.fromEntries(NIGHT_IDS.map((id) => [id, true])),
  [WEB_FIXES_ID]: true,
  [CHARTERS_ID]: true,
});

const read = (id: string) => ({
  release_id: id,
  revision: 1,
  dismissed_at: null,
  opened_at: '2026-11-02T15:50:00Z',
  read_at: '2026-11-02T15:50:00Z',
});

/** A file in the repository, as written. */
const REPO = resolve(__dirname, '../../../../..');
const repoFile = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');
/** A source file under apps/web/src, as written. */
const source = (rel: string) => repoFile(`apps/web/src/${rel}`);
/** A file in the mobile app, as written. */
const phone = (rel: string) => repoFile(`apps/mobile/${rel}`);

/** '/dashboard/orders?x=y' -> does app/(dashboard)/dashboard/orders/page.tsx exist? */
const DASHBOARD_APP_DIR = resolve(__dirname, '../../app/(dashboard)');
function pageExistsFor(href: string): boolean {
  const path = href.split('?')[0]!.replace(/\/+$/, '');
  return existsSync(resolve(DASHBOARD_APP_DIR, `.${path}`, 'page.tsx'));
}

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

/** Each entry answers all four questions, with its own id. */
function expectFourAnswers(r: Release): void {
  expect(r.entries.length).toBeGreaterThan(0);
  expect(r.entries.length).toBeLessThanOrEqual(12);
  expect(new Set(r.entries.map((e) => e.id)).size).toBe(r.entries.length);
  for (const e of r.entries) {
    expect(e.whatChanged.length, e.id).toBeGreaterThan(0);
    expect(e.whyItMatters.length, e.id).toBeGreaterThan(0);
    expect(e.howItAffectsYou.length, e.id).toBeGreaterThan(0);
    expect(e.whatToDo.length, e.id).toBeGreaterThan(0);
  }
}

/** Every link opens a dashboard page that exists, and says who can reach it. */
function expectLinksReachable(r: Release): void {
  const known = new Set<string>(PERMISSIONS);
  for (const e of r.entries.filter((x) => x.link)) {
    expect(e.link!.href, e.id).toMatch(/^\/dashboard(\/|$)/);
    expect(pageExistsFor(e.link!.href), `${e.id} -> ${e.link!.href}`).toBe(true);
    const audience = e.audience ?? r.audience;
    expect(audience, e.id).toBeDefined();
    expect(audience?.anyPermission?.length ?? 0, e.id).toBeGreaterThan(0);
    for (const p of audience?.anyPermission ?? []) {
      expect(known.has(p), `${e.id}: ${p}`).toBe(true);
    }
    for (const m of audience?.modules ?? []) {
      expect(Object.keys(MODULE_REGISTRY), `${e.id}: ${m}`).toContain(m);
    }
  }
}

describe('the authenticator code release (S43a, release 1)', () => {
  const release = () => byId(AUTH_CODE_ID);

  // Renamed by docs/whats-new-2026-11-02 (2026-11-02; was: "is published once, as revision 1, directly below the B44 phone update draft, the newest published release, above the integration retries release", with the draft at RELEASES[0], this release at RELEASES[1] and the integration retries release at RELEASES[2]): the draft is folded into the update-ready-and-fixes release, published at 04:21Z below the lists-delivery-sites-and-fixes release, so this one is at the top. Claim kept: the newest published release, directly above the integration retries release.
  // Renamed by docs/whats-new-2026-11-02c (2026-11-02; was: "is published once, as revision 1, at the top, the newest published release, above the integration retries release", with this release at RELEASES[0] and the newest published): the web fixes and archived charters releases are published later, at the top, so this one is at 2 and the web fixes release is the newest published. Claim kept: directly above the integration retries release.
  it('is published once, as revision 1, directly below the web fixes and archived charters releases (published later), above the integration retries release', () => {
    expect(RELEASES.filter((r) => r.id === AUTH_CODE_ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-2026-11-02 (2026-11-02; was: the B44 phone update draft at 0, a draft, this release at 1 and the integration retries release at 2): each moves up one place, and the lists-delivery-sites-and-fixes release is at 2.
    // Re-pinned by docs/whats-new-2026-11-02d (2026-11-02; was: every pinned position four places higher): the Export items, phone update, clearer web messages and QW1 releases are published at the top, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: every pinned position one place higher): the S2 release is published at the top, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: every pinned position one place higher): the count sheet release is published at the top, so every position below it moves down by one.
    // Re-pinned by feat/order-add-all (2026-11-10; was: every pinned position one place higher): the Add all release is published at the top, so every position below it moves down by one.
    // Re-pinned by lg/s5-flag-home (2026-11-09; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[16]?.id).toBe(AUTH_CODE_ID);
    expect(RELEASES[16]?.status).toBe('published');
    expect(RELEASES[17]?.id).toBe(RETRIES_ID);
    expect(RELEASES[18]?.id).toBe(LISTS_ID);
    // Re-pinned by docs/whats-new-2026-11-02c (2026-11-02; was: AUTH_CODE_ID): the web fixes release is published later, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-11-02d (2026-11-02; was: WEB_FIXES_ID): the Export items release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: export-items-permission-2026-11): the S2 release is published after it, at the top, the newest published release.
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: approver-controls-own-warehouses-2026-11): the count sheet release is published after it, at the top, the newest published release.
    expect(RELEASES.find((r) => r.status === 'published')?.id).toBe(
      // Re-pinned by feat/order-add-all (2026-11-10; was: the count sheet release): the Add all release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: the Add all release): the returns request and names release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: the returns request and names release, the newest published): the phone appearance and returns release is published later, at the top, directly below the Liquid Glass draft.
      // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: the phone appearance and returns release): the Release count release is published after it, at the top, the newest published release.
      // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: the Release count release): the emailed links release is published after it, at the top, the newest published release.
      'emailed-links-name-their-account-2026-11',
    );
  });

  it('is dated in the past on a whole minute, after #447 merged and #454 went live, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    // #447 merged at 06:49:05Z; this release is written above the integration
    // retries release, which merged at 15:33:44Z.
    expect(at).toBeGreaterThan(Date.parse('2026-11-02T06:49:05Z'));
    expect(at).toBeGreaterThan(Date.parse('2026-11-02T15:33:44Z'));
    expect(at).toBeLessThanOrEqual(Date.parse('2026-11-03T00:00:00Z'));
    // Re-pinned by docs/whats-new-2026-11-02 (2026-11-02; was: dated before RELEASES[0], the B44 phone update draft, and after RELEASES.slice(2)): the draft is folded into the update-ready-and-fixes release, dated 04:21Z, so no release is dated later than this one, the newest, at 0, and every release from 1 on is dated earlier.
    // Re-pinned by docs/whats-new-2026-11-02c (2026-11-02; was: RELEASES): the two releases at 0 and 1 are published later, so the newest from 2 on.
    // Re-pinned by docs/whats-new-2026-11-02d (2026-11-02; was: every pinned position four places higher): the Export items, phone update, clearer web messages and QW1 releases are published at the top, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: every pinned position one place higher): the S2 release is published at the top, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: every pinned position one place higher): the count sheet release is published at the top, so every position below it moves down by one.
    // Re-pinned by feat/order-add-all (2026-11-10; was: every pinned position one place higher): the Add all release is published at the top, so every position below it moves down by one.
    // Re-pinned by lg/s5-flag-home (2026-11-09; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(at).toBe(Math.max(...RELEASES.slice(16).map((r) => Date.parse(r.publishedAt))));
    for (const r of RELEASES.slice(17)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('has its two entries, each with its own id and an answer to all four questions', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'phone-waiting-changes-kept-for-code',
      'phone-without-code-signs-in-again',
    ]);
    expectFourAnswers(release());
    expect(release().entries[0]!.whatToDo).toBe('No action needed.');
  });

  it('has no link and no audience, so every member is told it, and any link would open a page that exists', () => {
    expect(release().audience).toBeUndefined();
    for (const e of release().entries) {
      expect(e.link, e.id).toBeUndefined();
      expect(e.audience, e.id).toBeUndefined();
    }
    expectLinksReachable(release());
  });

  it('is the first notice for an owner and for a member with no permission, and an old phone build lists it first with its title and summary alone', () => {
    for (const v of [everyone, member, integrator]) {
      expect(
        visibleReleases(RELEASES, v)
          .find((r) => r.id === AUTH_CODE_ID)
          ?.entries.map((e) => e.id),
        v.role,
      ).toEqual(release().entries.map((e) => e.id));
      // Re-pinned by docs/whats-new-2026-11-02c (2026-11-02; was: nothing read or seen): the web fixes and archived charters releases are published later and reach an owner and an admin, so they are read or seen first.
      expect(buildReleaseList(RELEASES, v, laterReads(), null).latestUnread?.id, v.role).toBe(
        AUTH_CODE_ID,
      );
      expect(legacyAnnouncementsFor(RELEASES, v, laterSeen())[0], v.role).toEqual({
        id: AUTH_CODE_ID,
        date: '2026-11-02',
        title: release().title,
        body: release().summary,
      });
    }
  });

  it('is in every feed and in the fingerprint, so publishing it changes what clients observe', () => {
    expect(buildReleaseList(RELEASES, member, [], null).releases.map((r) => r.id)).toContain(
      AUTH_CODE_ID,
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(AUTH_CODE_ID);
    expect(registryFingerprint(RELEASES)).toContain(`${AUTH_CODE_ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== AUTH_CODE_ID)),
    );
  });

  it('promises no phone update and never says an account or its data is now safe', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(
      /App Store|TestFlight|update the (mobile )?app|after the latest update|update your app/i,
    );
    // No line may claim more than the entries describe (see #447's What's
    // New note).
    expect(text).not.toMatch(
      /\bsafe|\bsecur|protect|harmless|stolen|password alone|cannot read|can no longer read/i,
    );
    expect(release().summary).toMatch(/^If you use an authenticator app, /);
    expect(release().summary).toContain('Nothing changes if you do not use an authenticator app.');
  });

  it('rests on the server refusing a session that still owes its code with the 401 the installed phone tries again', () => {
    const ctx = source('lib/auth/api-context.ts');
    // Both paths refuse with null (each route's 401), before anything is read.
    expect(ctx).toContain(
      "if (!opts?.allowStepUpPending && stepUpOwed(userRes.user.factors, bearerAal)) {\n      logStepUpRefused(req, 'bearer');\n      return null;",
    );
    expect(ctx).toContain(
      "if (!opts?.allowStepUpPending && (await owesStepUp(user.factors, level))) {\n    logStepUpRefused(req, 'cookie');\n    return null;",
    );
    expect(repoFile('packages/core/src/auth/step-up.ts')).toContain(
      "return enrolled && aal !== 'aal2';",
    );
    // The installed phone: a 401 on a live account is tried again; a 403 went
    // to Unsent work. A queued stock adjustment answered 401 is tried again too.
    const drain = phone('src/lib/drain-failure.ts');
    expect(drain).toContain(
      "if (status === 401) return opts.accountDisabled ? 'rejected' : 'failed';",
    );
    expect(drain).toContain(
      'const DEFINITIVE_REFUSALS: ReadonlySet<number> = new Set([400, 403, 409, 422]);',
    );
    expect(phone('src/lib/adjust-outbox.ts')).toContain(
      "if (status === 401 || status === 429 || status === 404) return 'failed';",
    );
    // Queued count lines are tried at a sync every 60 s, each once its own
    // backoff (at most 5 minutes) has passed, so a line goes at a later sync,
    // not always the next one.
    const countSync = phone('src/lib/cycle-count-sync.ts');
    expect(countSync).toContain('}, 60_000);');
    expect(countSync).toContain('if (!row.due) continue;');
    expect(phone('src/lib/cycle-count-cache.ts')).toContain(
      'const delay = Math.min(2 ** attempts * 1000, 5 * 60 * 1000);',
    );
    expect(release().entries[0]!.whatChanged).toContain(
      'It sends them at a later sync after you enter your 6-digit code.',
    );
    expect(readerText(release()).join(' ')).not.toMatch(/next sync|a moment after/);
    expect(phone('app/(drawer)/settings.tsx')).toContain('title="Unsent work"');
  });

  it("quotes the phone's own words, and the phone goes in without the code only when it could not check", () => {
    const text = readerText(release()).join(' ');
    expect(text).toContain('Unsent work');
    expect(text).toContain('your session has ended or expired');
    expect(phone('src/lib/item-adjust.ts')).toContain(
      "'Your session has ended. Sign in again, then retry. Nothing was changed.'",
    );
    expect(phone('src/components/edit-order-line.ts')).toContain(
      "'Your session has expired. Sign in again to change this order.'",
    );
    expect(text).toContain('not available on this version of the app');
    expect(phone('src/lib/api-error-body.ts')).toContain(
      "'That is not available on this version of the app. Update the app and try again.'",
    );
    // The alert's first sentence, as the app shows it.
    expect(text).toContain('“That is not available on this version of the app”');
    // The signature hand-over answers every refusal with its one 404.
    const sign = source('app/api/orders/sign/route.ts');
    expect(sign).toContain('return NextResponse.json(NOT_FOUND_BODY, { status: 404 });');
    // Before #447 the phone's changes, a signature included, were already
    // refused (a 403): the hand-over's own gate and assertPermission's. So the
    // entry says the sync is refused as well, and the changes already were.
    expect(sign).toContain('if (ctx.mfaRequired && !ctx.mfaSatisfied) {');
    expect(source('server/services/context.ts')).toContain(
      'if (ctx.mfaRequired && !ctx.mfaSatisfied) {\n    throw mfaGateError(ctx);',
    );
    const signsInAgain = release().entries[1]!;
    expect(signsInAgain.whatChanged).toContain(
      "now also refuses that phone's sync until you sign in again with the code, as it already refused its changes, such as collecting a signature.",
    );
    // A failed check for an authenticator lets the app in without the code,
    // at sign-in and when the app opens with a saved session.
    const auth = phone('src/lib/auth-context.tsx');
    expect(auth).toContain("console.warn('[auth] MFA level check failed', e);");
    expect(auth).toContain(
      '// A restored session may still owe an AAL2 challenge if it was\n          // only ever AAL1 on disk. Check before exposing the app.\n          // (checkMfa is already internally try/caught.)\n          await checkMfa();',
    );
    expect(text).toContain(
      'could not check for your authenticator when you signed in or opened the app',
    );
    // Every member is told it, so the steps start with who they are for.
    expect(signsInAgain.whatToDo).toMatch(/^If you use an authenticator app and /);
  });
});

describe('the integration retries release (B49, B81 and B82)', () => {
  const release = () => byId(RETRIES_ID);

  it('is published once, as revision 1, directly below the authenticator code release and above the lists-delivery-sites-and-fixes release', () => {
    expect(RELEASES.filter((r) => r.id === RETRIES_ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whats-new-2026-11-02 (2026-11-02; was: RELEASES[1] to [3], below the B44 phone update draft at 0): the draft is folded into the update-ready-and-fixes release, published below the lists-delivery-sites-and-fixes release, so each moves up one place.
    // Re-pinned by docs/whats-new-2026-11-02d (2026-11-02; was: every pinned position four places higher): the Export items, phone update, clearer web messages and QW1 releases are published at the top, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: every pinned position one place higher): the S2 release is published at the top, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: every pinned position one place higher): the count sheet release is published at the top, so every position below it moves down by one.
    // Re-pinned by feat/order-add-all (2026-11-10; was: every pinned position one place higher): the Add all release is published at the top, so every position below it moves down by one.
    // Re-pinned by lg/s5-flag-home (2026-11-09; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[16]?.id).toBe(AUTH_CODE_ID);
    expect(RELEASES[17]?.id).toBe(RETRIES_ID);
    expect(RELEASES[18]?.id).toBe(LISTS_ID);
  });

  it('is dated in the past on a whole minute, a minute before the authenticator code release, after #454 merged, and after every release below it', () => {
    const at = Date.parse(release().publishedAt);
    expect(release().publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(at).toBeGreaterThan(Date.parse('2026-11-02T15:33:44Z'));
    expect(Date.parse(byId(AUTH_CODE_ID).publishedAt) - at).toBe(60_000);
    // Re-pinned by docs/whats-new-2026-11-02 (2026-11-02; was: RELEASES.slice(3)): this release is at 1 now, so every release from 2 on is below it.
    // Re-pinned by docs/whats-new-2026-11-02d (2026-11-02; was: every pinned position four places higher): the Export items, phone update, clearer web messages and QW1 releases are published at the top, so every position below them moves down by four.
    // Re-pinned by docs/whats-new-2026-11-05 (2026-11-05; was: every pinned position one place higher): the S2 release is published at the top, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-count-sheet-long-names (2026-11-10; was: every pinned position one place higher): the count sheet release is published at the top, so every position below it moves down by one.
    // Re-pinned by feat/order-add-all (2026-11-10; was: every pinned position one place higher): the Add all release is published at the top, so every position below it moves down by one.
    // Re-pinned by lg/s5-flag-home (2026-11-09; was: every pinned position one place higher, and no draft): the Liquid Glass release is held as a draft at the top until G5, so every position below it moves down by one and it is the one draft.
    // Re-pinned by docs/whatsnew-returns-1112 (2026-11-12; was: every pinned position one place higher): the returns request and names release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-1112 (2026-11-12; was: every pinned position one place higher): the phone appearance and returns release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whats-new-2026-11-13 (2026-11-13; was: every pinned position three places higher): the Release count, AI Assistant and not found releases are published at the top, below the Liquid Glass draft, so every position below it moves down by three.
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    for (const r of RELEASES.slice(18)) {
      expect(at, r.id).toBeGreaterThan(Date.parse(r.publishedAt));
    }
  });

  it('has its two entries, each with its own id and an answer to all four questions', () => {
    expect(release().entries.map((e) => e.id)).toEqual([
      'integration-export-retries-network-failure',
      'integration-alerts-retry-brief-failure',
    ]);
    expectFourAnswers(release());
  });

  it('links only to the Integrations page, which exists, and names the permission and the module that page checks', () => {
    const gate = { anyPermission: ['integrations:manage'], modules: ['integrations'] };
    expect(release().audience).toEqual(gate);
    for (const e of release().entries) {
      expect(e.link, e.id).toEqual({
        href: '/dashboard/settings/integrations',
        label: 'Open Integrations',
      });
      expect(e.audience, e.id).toEqual(gate);
    }
    expectLinksReachable(release());
    const page = source('app/(dashboard)/dashboard/settings/integrations/page.tsx');
    expect(page).toContain("checkModuleAccess('integrations'),");
    expect(page).toContain(
      "const showQbo = integrationsAccess.enabled && can(ctx, 'integrations:manage');",
    );
    expect(page).toContain(
      "const showWebhooks = integrationsAccess.enabled && can(ctx, 'integrations:manage');",
    );
  });

  it('reaches whoever manages integrations with the module on, the notice once the authenticator code release is read, and nobody else', () => {
    for (const v of [everyone, integrator]) {
      expect(
        visibleReleases(RELEASES, v).map((r) => r.id),
        v.role,
      ).toContain(RETRIES_ID);
      // Re-pinned by docs/whats-new-2026-11-02c (2026-11-02; was: nothing read or seen first): the web fixes and archived charters releases are published later and reach these readers, so they are read or seen first.
      expect(buildReleaseList(RELEASES, v, laterReads(), null).latestUnread?.id, v.role).toBe(
        AUTH_CODE_ID,
      );
      expect(
        buildReleaseList(RELEASES, v, [...laterReads(), read(AUTH_CODE_ID)], null).latestUnread?.id,
        v.role,
      ).toBe(RETRIES_ID);
      expect(
        legacyAnnouncementsFor(RELEASES, v, { ...laterSeen(), [AUTH_CODE_ID]: true })[0],
        v.role,
      ).toEqual({
        id: RETRIES_ID,
        date: '2026-11-02',
        title: release().title,
        body: release().summary,
        cta: { href: '/dashboard/settings/integrations', label: 'Open Integrations' },
      });
    }
    // Not a member with no permission, not someone with the permission whose
    // organization has the module off, and not the module without the
    // permission.
    const moduleOff: ReleaseViewer = {
      role: 'admin',
      permissions: ['integrations:manage'],
      enabledModules: [],
    };
    const noPermission: ReleaseViewer = {
      role: 'staff',
      permissions: [],
      enabledModules: ['integrations'],
    };
    for (const v of [member, moduleOff, noPermission]) {
      expect(
        visibleReleases(RELEASES, v).map((r) => r.id),
        v.role,
      ).not.toContain(RETRIES_ID);
      expect(
        legacyAnnouncementsFor(RELEASES, v, { [AUTH_CODE_ID]: true }).map((a) => a.id),
        v.role,
      ).not.toContain(RETRIES_ID);
    }
  });

  it('is in every feed it reaches and in the fingerprint, so publishing it changes what clients observe', () => {
    expect(buildReleaseList(RELEASES, integrator, [], null).releases.map((r) => r.id)).toContain(
      RETRIES_ID,
    );
    expect(ANNOUNCEMENTS.map((a) => a.id)).toContain(RETRIES_ID);
    expect(registryFingerprint(RELEASES)).toContain(`${RETRIES_ID}@1:published`);
    expect(registryFingerprint(RELEASES)).not.toBe(
      registryFingerprint(RELEASES.filter((r) => r.id !== RETRIES_ID)),
    );
  });

  it('makes no phone claim, and its numbers and quoted words are the code’s own', () => {
    const text = readerText(release()).join(' ');
    expect(text).not.toMatch(/App Store|TestFlight|update the (mobile )?app|mobile app|phone/i);
    // Eight tries and the 15-second stop.
    expect(text).toContain('up to eight tries');
    expect(source('server/connectors/drainer.ts')).toContain('export const MAX_ATTEMPTS = 8;');
    expect(text).toContain('within 15 seconds');
    expect(source('server/connectors/quickbooks/client.ts')).toContain(
      'export const QBO_REQUEST_TIMEOUT_MS = 15_000;',
    );
    const intacct = source('server/connectors/sage-intacct/client.ts');
    expect(intacct).toContain('export const INTACCT_REQUEST_TIMEOUT_MS = 15_000;');
    // The sentence an Intacct export that may have arrived stops with.
    const sentence =
      'This export may have reached Sage Intacct. Check Intacct for it before you press Replay, or it may be posted twice.';
    expect(intacct).toContain(`'${sentence}'`);
    expect(text).toContain(`“${sentence}”`);
    // A failed host lookup is not a refusal of the address.
    expect(source('lib/ssrf-guard.ts')).toContain(
      'return err instanceof SsrfBlockedError && !(err instanceof SsrfLookupFailedError);',
    );
    // Three tries to read the endpoints and queue the deliveries.
    const events = source('server/services/integration-events.ts');
    expect(events).toContain('export const DISPATCH_RETRY_DELAYS_MS = [1_000, 3_000];');
    // A host's HTTP error or timeout was already retried before #454, so the
    // summary names only the brief failure that used to drop an alert. A
    // delivery is tried up to 6 times with backoff, at the drain every 10
    // minutes, so a retried alert is said to arrive late, at a later sync.
    expect(release().summary).toContain(
      'a webhook, Slack or Teams alert is now retried after a brief failure that used to drop it.',
    );
    expect(text).not.toMatch(/some minutes|retried instead of dropped/);
    expect(text).toContain('A retried alert can arrive late, at a later sync.');
    expect(events).toContain('const MAX_ATTEMPTS = 6;');
    expect(events).toContain(
      'return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));',
    );
    expect(repoFile('apps/web/vercel.json')).toContain(
      '"path": "/api/cron/drain-outbox",\n      "schedule": "*/10 * * * *"',
    );
    // The screen's own words: Failed exports, Replay, and the Error and Dead
    // badges (the status, capitalised).
    const panel = source('components/settings/integrations-panel.tsx');
    expect(panel).toContain('title="Failed exports (dead-letter)"');
    expect(panel).toContain("{replayed ? 'Re-queued' : replaying ? 'Replaying…' : 'Replay'}");
    expect(panel).toContain('<Badge variant={map[status]} dot className="capitalize">');
    expect(text).toContain('shows Error');
    expect(text).toContain('stops at Dead');
  });
});
