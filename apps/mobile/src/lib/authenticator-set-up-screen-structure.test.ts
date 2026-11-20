import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATOR_CHECK_RESULT_COPY,
  AUTHENTICATOR_CHECK_UNAVAILABLE_COPY,
  AUTHENTICATOR_SET_UP_HOLD_COPY,
  AUTHENTICATOR_SET_UP_TITLE,
  AUTHENTICATOR_SET_UP_URL,
} from '@stockpilot/core';

/**
 * The authenticator set-up screen, read as source (the suite has no React
 * Native renderer: sheet-a11y-structure.test.ts). Its decision is executed
 * in set-up-hold.test.ts and its place in RootGate is pinned in
 * code-gate-wiring.test.ts section 7; the simulator rows prove the screen.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SCREEN = 'src/components/authenticator-set-up-screen.tsx';
const raw = readFileSync(path.join(MOBILE_ROOT, SCREEN), 'utf8');
const code = raw
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const flat = code.replace(/\s+/g, ' ');

/** Every JSX element named `tag`, with its attributes as written (whitespace flattened). */
function elements(tag: string): { attrs: string; text: string }[] {
  const sf = ts.createSourceFile(SCREEN, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { attrs: string; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === tag) {
      out.push({
        attrs: node.openingElement.attributes.getText(sf).replace(/\s+/g, ' '),
        text: node.children
          .map((c) => c.getText(sf))
          .join('')
          .replace(/\s+/g, ' ')
          .trim(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('words: every sentence from core, none of its own', () => {
  it('one heading and one body per state, each from core', () => {
    // One heading element, drawn from the state.
    expect(elements('Display')).toEqual([{ attrs: 'size={28}', text: '{holdTitle(state)}' }]);
    expect(flat).toContain(
      "function holdTitle(state: 'owed' | 'unknown'): string { return state === 'unknown' ? AUTHENTICATOR_CHECK_UNAVAILABLE_COPY.title : AUTHENTICATOR_SET_UP_TITLE; }",
    );
    // One body element, drawn from the state.
    const bodies = elements('Body').filter((b) => b.text === '{body}');
    expect(bodies).toHaveLength(1);
    expect(flat).toContain('holdBody(state, setUpHoldDetails(session?.user))');
    expect(flat).toContain(
      "if (state === 'unknown') return AUTHENTICATOR_CHECK_UNAVAILABLE_COPY.body; return details.policy ? authenticatorSetUpHoldBody(details.name, details.policy) : AUTHENTICATOR_SET_UP_OWED_COPY; }",
    );
    // The could-not-check words are their own, never the save sentence.
    expect(flat).not.toContain('CONTEXT_UNAVAILABLE_COPY');
    expect(AUTHENTICATOR_SET_UP_TITLE).toBe('Set up an authenticator to continue');
    expect(AUTHENTICATOR_CHECK_UNAVAILABLE_COPY.title).toBe('Your access could not be checked');
    expect(AUTHENTICATOR_CHECK_UNAVAILABLE_COPY.body).toBe(
      'Your access could not be checked just now. Try again in a moment.',
    );
  });

  it('the action labels are core constants', () => {
    for (const key of Object.keys(AUTHENTICATOR_SET_UP_HOLD_COPY)) {
      if (key === 'setUpOnWebsiteHint') continue;
      expect(flat, key).toContain(`AUTHENTICATOR_SET_UP_HOLD_COPY.${key}}`);
    }
    expect(flat).toContain('accessibilityHint={AUTHENTICATOR_SET_UP_HOLD_COPY.setUpOnWebsiteHint}');
  });

  it('no sentence is typed into the screen, and no older second-factor words', () => {
    // Every string literal in the code is a style or a variant, never words.
    const literals = [...code.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]);
    for (const s of literals) expect(s, s).not.toMatch(/\s\w+\s/);
    expect(raw).not.toMatch(/\bMFA\b|2FA|two-factor|multi-factor/i);
  });

  it("the line about queued work counts this account's rows of the HELD workspace, read again on the foreground and after each count-engine pass", () => {
    expect(flat).toContain('void pendingCountInWorkspace(heldOrgId).then(');
    expect(flat).not.toContain('totalPendingCount');
    expect(flat).toContain(
      'const heldOrgId = React.useSyncExternalStore( subscribeSetUpHold, () => setUpHoldDetails(session?.user).orgId, );',
    );
    expect(flat).toContain('const stopEngine = cycleCountSync.subscribe(() => countWaiting());');
    expect(flat).toContain("if (next === 'active') countWaiting();");
    expect(flat).toContain('const queued = setUpHoldQueuedLine(state, waiting);');
    expect(flat).toContain('{queued ? (');
  });
});

describe('the actions', () => {
  const buttons = elements('Button');

  it('five named buttons and one per organization, all at the shared 52pt size (none small)', () => {
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect(b.attrs, b.text).not.toMatch(/size=/);
      expect(b.attrs, b.text).toContain('onPress=');
    }
    expect(
      buttons.filter((b) => /^\{AUTHENTICATOR_SET_UP_HOLD_COPY\.\w+\}$/.test(b.text)),
    ).toHaveLength(5);
    expect(buttons.map((b) => b.text)).toContain(
      '{w.name ?? AUTHENTICATOR_SET_UP_HOLD_COPY.unnamedWorkspace}',
    );
  });

  it('Set up on the website opens the set-up address through webLink, only while set-up is owed', () => {
    expect(flat).toContain(
      'Linking.openURL(webLink(AUTHENTICATOR_SET_UP_URL)).catch(() => undefined);',
    );
    expect(flat).toContain("{state === 'owed' ? ( <Button block wrap onPress={openWebsite}");
    expect(AUTHENTICATOR_SET_UP_URL).toBe('/dashboard/settings/security?enroll=1');
  });

  it("Check again reads at once (not the queue's ask), then shows and says what happened while still held", () => {
    const fn = flat.slice(
      flat.indexOf('async function checkAgain()'),
      flat.indexOf('async function switchTo('),
    );
    expect(fn).toContain('if (checking) return; setChecking(true); setResult(null);');
    expect(fn).toContain('await readSetUpInputsForHold(userId);');
    expect(fn).toContain(
      'if (!mounted.current) return; const found = setUpHoldDetails(session?.user); if (!found.hold) return; const answered = setUpCheckAnswered(session?.user); const line = answered ? AUTHENTICATOR_CHECK_RESULT_COPY.checked : AUTHENTICATOR_CHECK_RESULT_COPY.noAnswer; setResult(line);',
    );
    // Spoken too; with no answer only the line, never the organization sentence as if confirmed.
    expect(fn).toContain(
      'AccessibilityInfo.announceForAccessibility( answered ? `${line} ${holdBody(found.hold, found)}` : line, );',
    );
    // The line is drawn under the body.
    const resultLine = elements('Body').find((b) => b.text === '{result}');
    expect(resultLine?.attrs).toContain('accessibilityLiveRegion="polite"');
    expect(flat.indexOf('{result ? (')).toBeGreaterThan(flat.indexOf('{body}'));
    expect(AUTHENTICATOR_CHECK_RESULT_COPY).toEqual({
      checked: 'Checked just now.',
      noAnswer: 'Could not check. Try again.',
    });
    expect(flat).not.toMatch(
      /requestSetUpInputsRead|noteKeptRefusal|setUpAnswerAfterRefusal|askForSetUpRead/,
    );
  });

  it('Sign out stays usable while a check runs; only its own sign-out dims it', () => {
    const signOut = buttons.find((b) => b.text === '{AUTHENTICATOR_SET_UP_HOLD_COPY.signOut}');
    expect(signOut?.attrs).toContain('disabled={signingOut}');
    const check = buttons.find((b) => b.text === '{AUTHENTICATOR_SET_UP_HOLD_COPY.checkAgain}');
    expect(check?.attrs).toContain('disabled={busy}');
  });

  it('organizations only: its own list from the kept organizations, calling the workspace switch', () => {
    expect(flat).toContain(
      'const workspaces = React.useSyncExternalStore(subscribeSetUpHold, () => setUpHoldWorkspaces(session?.user), );',
    );
    expect(flat).toContain('const others = workspaces.filter((w) => w.orgId !== heldOrgId);');
    expect(flat.match(/others\.length > 0/g)).toHaveLength(2);
    expect(flat).toContain('await setActiveOrg(orgId);');
    expect(flat).toContain('onPress={() => void switchTo(w.orgId)}');
  });

  it('no workspace load, no switcher sheet, no warehouse name or section', () => {
    expect(flat).not.toMatch(/useWorkspace\s*\(/);
    expect(raw).not.toMatch(/WorkspaceSwitcherSheet|workspace-switcher/);
    expect(code).not.toMatch(/warehouse/i);
    expect(raw).toContain("import { setActiveOrg } from '@/lib/use-workspace';");
  });

  it('Sign out is the deliberate sign-out (it asks about unsent work first)', () => {
    expect(flat).toContain('const { session, signOut } = useAuth();');
    expect(flat).toContain('await signOut();');
    expect(flat).not.toMatch(/signOutToFallback|afterAccountDeleted/);
  });

  it('Delete my account opens the delete sheet, which the screen renders once', () => {
    expect(flat.match(/useDeleteAccountConfirm\(/g)).toHaveLength(1);
    expect(flat).toContain('const deleteAccount = useDeleteAccountConfirm({ signOut });');
    expect(flat).toContain('onPress={deleteAccount.open}');
    expect(flat.match(/\{deleteAccount\.sheet\}/g)).toHaveLength(1);
    // The screen itself never posts a deletion.
    expect(flat).not.toMatch(/account\/delete|api\(/);
  });
});

describe('accessibility and layout', () => {
  it("the state's heading is a header and takes focus when the screen replaces the app and when the state changes", () => {
    expect(flat).toContain('<View ref={title} accessible accessibilityRole="header">');
    expect(flat).toContain(
      "if (node) AccessibilityInfo.sendAccessibilityEvent(node, 'focus'); }, [state]);",
    );
  });

  it('the content scrolls (the largest text on a 320pt phone), with the safe area kept', () => {
    expect(flat).toContain('<ScrollView');
    expect(flat).toContain('paddingBottom: insets.bottom + 24');
  });

  it('Classic look only: no Liquid Glass hook or part', () => {
    expect(raw).not.toMatch(/useGlass|\/glass\/|GLASS_|\blg\b/);
  });
});
