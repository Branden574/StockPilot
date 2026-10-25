import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanSignOutSites, type ScanFile, type SignOutSite } from '@/test/sign-out-purge-scan';

/**
 * RECURRENCE GUARD: every way the web app ends the session in this tab on
 * purpose removes what an interrupted run kept here first.
 *
 * lib/interrupted-run.ts keeps a small record in the tab's sessionStorage while
 * a long flow runs (a new procedure's id, a Sage 50 import's summary with up to
 * 50 rows of its errors), so that a session that EXPIRES partway through still
 * leads back to the work after signing in. A person who signs out on purpose is
 * done with it, so every sign-out control must call purgeInterruptedRuns()
 * before its request leaves: the account menu, the MFA screen's Cancel and sign
 * out, the account-disabled screen, "Sign out and back in" on both error
 * pages, Delete my account, setting a new password from a reset link, and the
 * forced sign-out when this session is revoked. sessionStorage is the
 * browser's, so only client code can do it. The server's own redirect to
 * /auth/session-ended (an expired session) is not one of them, and keeps the
 * record. See src/test/sign-out-purge-scan.ts for exactly what is found and
 * what counts as first.
 */

const WEB_SRC = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      // The test helpers (this guard's own scanner among them) are not the app.
      if (full === path.join(WEB_SRC, 'test')) continue;
      walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function describeSite(s: SignOutSite, root: string): string {
  return `${path.relative(root, s.file)}:${s.line} ${s.fn} (${s.how} ${s.what})${s.problem ? `: ${s.problem}` : ''}`;
}

/* ─────────────────────────────── self-test ─────────────────────────────── */

const V = '/virtual/src';
const PLANTED: ScanFile[] = [
  {
    path: `${V}/lib/auth/session-ended.ts`,
    text: [
      `import { redirect } from 'next/navigation';`,
      `export const SESSION_ENDED_PATH = '/auth/session-ended';`,
      // The expired-session redirect: server code, keeps the record.
      `export async function orSessionEnded<T>(read: Promise<T>) { try { return await read; } catch { redirect(SESSION_ENDED_PATH); } }`,
    ].join('\n'),
  },
  {
    path: `${V}/server/actions/auth.ts`,
    text: [
      `'use server';`,
      `declare const supabase: { auth: { signOut(o: unknown): Promise<void> } };`,
      `export async function signOutAction() { await supabase.auth.signOut({ scope: 'global' }); }`,
      `export async function completePasswordResetAction(v: unknown) { await supabase.auth.signOut({ scope: 'global' }); return v; }`,
      `export async function otherAction() { return signOutAction(); }`,
    ].join('\n'),
  },
  {
    path: `${V}/components/planted-client.tsx`,
    text: [
      `'use client';`,
      `import { purgeInterruptedRuns } from '@/lib/interrupted-run';`,
      `import { SESSION_ENDED_PATH } from '@/lib/auth/session-ended';`,
      `import { signOutAction, signOutAction as leave } from '@/server/actions/auth';`,
      `import * as authActions from '@/server/actions/auth';`,
      `import { deleteOwnAccountAction } from '@/server/actions/profile';`,
      `declare const supabase: { auth: { signOut(o: unknown): Promise<void> } };`,
      `declare const router: { push(p: string): void };`,
      `declare const flag: boolean;`,
      `const LOCAL_ROUTE = '/auth/session-ended';`,
      ``,
      `export async function purgesFirst() { purgeInterruptedRuns(); await signOutAction(); }`,
      `export async function purgesFirstInTry() { try { purgeInterruptedRuns(); await signOutAction(); } catch { /* */ } }`,
      `export async function purgesInOuterBlock() { purgeInterruptedRuns(); if (flag) { await deleteOwnAccountAction({ confirm: 'DELETE' }); } }`,
      `export async function noPurge() { await signOutAction(); }`,
      `export async function purgesAfter() { await signOutAction(); purgeInterruptedRuns(); }`,
      `export async function purgesInBranch() { if (flag) purgeInterruptedRuns(); await signOutAction(); }`,
      `export async function purgesInCallback() { [1].forEach(() => { purgeInterruptedRuns(); }); await signOutAction(); }`,
      `export async function aliased() { await leave(); }`,
      `export async function viaNamespace() { await authActions.signOutAction(); }`,
      `export async function deletes() { await deleteOwnAccountAction({ confirm: 'DELETE' }); }`,
      `export const asValue = { run: signOutAction };`,
      `export async function localSignOutPurged() { purgeInterruptedRuns(); await supabase.auth.signOut({ scope: 'local' }); }`,
      `export async function localSignOut() { await supabase!.auth.signOut({ scope: 'local' }).catch(() => {}); }`,
      `export function navigates() { router.push(SESSION_ENDED_PATH); }`,
      `export function navigatesPurged() { purgeInterruptedRuns(); window.location.href = LOCAL_ROUTE; }`,
      `export function Links() {`,
      `  return (`,
      `    <div>`,
      `      <a href={SESSION_ENDED_PATH}>bare</a>`,
      `      <a href="/auth/session-ended" onClick={() => purgeInterruptedRuns()}>purged</a>`,
      `      <a href={LOCAL_ROUTE} onClick={purgeInterruptedRuns}>purged by reference</a>`,
      `      <a href="/auth/session-ended?next=1" onClick={async () => { await Promise.resolve(); purgeInterruptedRuns(); }}>purged too late</a>`,
      `      <a href="/signin">not the route</a>`,
      `      <form action={signOutAction}><button type="submit">bare form</button></form>`,
      `      <form action={signOutAction} onSubmit={() => purgeInterruptedRuns()}><button type="submit">purged form</button></form>`,
      `    </div>`,
      `  );`,
      `}`,
    ].join('\n'),
  },
  {
    // A server component cannot attach a handler: its sign-out form and link
    // are reported, and the expired-session redirect above is not a site.
    path: `${V}/app/disabled/page.tsx`,
    text: [
      `import { signOutAction } from '@/server/actions/auth';`,
      `import { SESSION_ENDED_PATH } from '@/lib/auth/session-ended';`,
      `export default function Page() {`,
      `  return (<div><form action={signOutAction}><button type="submit">Sign out</button></form><a href={SESSION_ENDED_PATH}>Sign out and back in</a></div>);`,
      `}`,
    ].join('\n'),
  },
  {
    // No 'use client': a server-side local sign-out (a route handler, a
    // side-channel client) and a navigation there are not this tab's controls.
    path: `${V}/app/auth/session-ended/route.ts`,
    text: [
      `declare const supabase: { auth: { signOut(o: unknown): Promise<void> } };`,
      `declare function redirectTo(p: string): void;`,
      `export async function GET() { await supabase.auth.signOut({ scope: 'local' }); redirectTo('/auth/session-ended'); }`,
    ].join('\n'),
  },
];

describe('sign-out purge guard: self-test on planted code', () => {
  const { sites, findings } = scanSignOutSites(PLANTED);
  const at = (list: SignOutSite[]) =>
    list.map((s) => `${path.basename(s.file)} ${s.fn} ${s.how} ${s.what}`);

  it('finds every kind of sign-out site, and only those', () => {
    expect(at(sites)).toEqual([
      'page.tsx Page form-action signOutAction',
      'page.tsx Page link /auth/session-ended',
      'planted-client.tsx purgesFirst call signOutAction',
      'planted-client.tsx purgesFirstInTry call signOutAction',
      'planted-client.tsx purgesInOuterBlock call deleteOwnAccountAction',
      'planted-client.tsx noPurge call signOutAction',
      'planted-client.tsx purgesAfter call signOutAction',
      'planted-client.tsx purgesInBranch call signOutAction',
      'planted-client.tsx purgesInCallback call signOutAction',
      'planted-client.tsx aliased call signOutAction',
      'planted-client.tsx viaNamespace call signOutAction',
      'planted-client.tsx deletes call deleteOwnAccountAction',
      'planted-client.tsx (top level) value signOutAction',
      'planted-client.tsx localSignOutPurged call auth.signOut',
      'planted-client.tsx localSignOut call auth.signOut',
      'planted-client.tsx navigates navigation /auth/session-ended',
      'planted-client.tsx navigatesPurged navigation /auth/session-ended',
      'planted-client.tsx Links link /auth/session-ended',
      'planted-client.tsx Links link /auth/session-ended',
      'planted-client.tsx Links link /auth/session-ended',
      'planted-client.tsx Links link /auth/session-ended',
      'planted-client.tsx Links form-action signOutAction',
      'planted-client.tsx Links form-action signOutAction',
    ]);
  });

  it('reports each site that does not purge first, and passes each that does', () => {
    expect(at(findings)).toEqual([
      'page.tsx Page form-action signOutAction',
      'page.tsx Page link /auth/session-ended',
      'planted-client.tsx noPurge call signOutAction',
      'planted-client.tsx purgesAfter call signOutAction',
      'planted-client.tsx purgesInBranch call signOutAction',
      'planted-client.tsx purgesInCallback call signOutAction',
      'planted-client.tsx aliased call signOutAction',
      'planted-client.tsx viaNamespace call signOutAction',
      'planted-client.tsx deletes call deleteOwnAccountAction',
      'planted-client.tsx (top level) value signOutAction',
      'planted-client.tsx localSignOut call auth.signOut',
      'planted-client.tsx navigates navigation /auth/session-ended',
      // <a href={SESSION_ENDED_PATH}>bare</a>, and the one that purges after an await.
      'planted-client.tsx Links link /auth/session-ended',
      'planted-client.tsx Links link /auth/session-ended',
      'planted-client.tsx Links form-action signOutAction',
    ]);
    for (const f of findings) expect(f.problem).toMatch(/purgeInterruptedRuns|cannot follow/);
  });

  it('a link that purges only after an await is reported, the two that purge first are not', () => {
    const links = sites.filter((s) => s.how === 'link' && s.file.endsWith('planted-client.tsx'));
    expect(links.map((s) => s.problem === null)).toEqual([false, true, true, false]);
  });
});

/* ───────────────────────────── the real tree ───────────────────────────── */

describe('sign-out purge guard: apps/web/src', () => {
  const files: ScanFile[] = walk(WEB_SRC).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  const { sites, findings } = scanSignOutSites(files);
  const at = sites.map((s) => `${path.relative(WEB_SRC, s.file)} ${s.how} ${s.what}`);

  it('finds every sign-out control the app has', () => {
    // A new control is fine: it shows up here and must purge first (below).
    expect(at).toEqual(
      expect.arrayContaining([
        'app/(dashboard)/error.tsx link /auth/session-ended',
        'app/global-error.tsx link /auth/session-ended',
        'components/auth/mfa-challenge-form.tsx call signOutAction',
        'components/auth/reset-complete-form.tsx call completePasswordResetAction',
        'components/auth/sign-out-form.tsx form-action signOutAction',
        'components/dashboard/user-menu.tsx call signOutAction',
        'components/realtime/session-revocation-listener.tsx call auth.signOut',
        'components/settings/delete-account-button.tsx call deleteOwnAccountAction',
      ]),
    );
  });

  it('every one of them removes the interrupted-run records before its request leaves', () => {
    expect(findings.map((f) => describeSite(f, WEB_SRC))).toEqual([]);
  });
});
