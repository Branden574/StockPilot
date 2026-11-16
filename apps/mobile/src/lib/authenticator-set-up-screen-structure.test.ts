import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
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
  it('the title, the body for each state, and the action labels are core constants', () => {
    expect(flat).toContain('<Display size={28}>{AUTHENTICATOR_SET_UP_TITLE}</Display>');
    expect(flat).toContain("if (state === 'unknown') return CONTEXT_UNAVAILABLE_COPY;");
    expect(flat).toContain(
      '? authenticatorSetUpHoldBody(details.name, details.policy) : AUTHENTICATOR_SET_UP_OWED_COPY;',
    );
    for (const key of Object.keys(AUTHENTICATOR_SET_UP_HOLD_COPY)) {
      if (key === 'setUpOnWebsiteHint') continue;
      expect(flat, key).toContain(`{AUTHENTICATOR_SET_UP_HOLD_COPY.${key}}`);
    }
    expect(flat).toContain('accessibilityHint={AUTHENTICATOR_SET_UP_HOLD_COPY.setUpOnWebsiteHint}');
    expect(AUTHENTICATOR_SET_UP_TITLE).toBe('Set up an authenticator to continue');
  });

  it('no sentence is typed into the screen, and no older second-factor words', () => {
    // Every string literal in the code is a style or a variant, never words.
    const literals = [...code.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]);
    for (const s of literals) expect(s, s).not.toMatch(/\s\w+\s/);
    expect(raw).not.toMatch(/\bMFA\b|2FA|two-factor|multi-factor/i);
  });

  it('the line about queued work says how many are waiting, from the sync badge tally', () => {
    expect(flat).toContain('void totalPendingCount().then(');
    expect(flat).toContain('const queued = setUpHoldQueuedLine(state, waiting);');
    expect(flat).toContain('{queued ? (');
  });
});

describe('the actions', () => {
  const buttons = elements('Button');

  it('five named buttons at the shared 52pt size (none small), each with its own label', () => {
    expect(buttons).toHaveLength(5);
    for (const b of buttons) {
      expect(b.attrs, b.text).not.toMatch(/size=/);
      expect(b.attrs, b.text).toContain('onPress=');
      expect(b.text).toMatch(/^\{AUTHENTICATOR_SET_UP_HOLD_COPY\.\w+\}$/);
    }
  });

  it('Set up on the website opens the set-up address through webLink, only while set-up is owed', () => {
    expect(flat).toContain(
      'Linking.openURL(webLink(AUTHENTICATOR_SET_UP_URL)).catch(() => undefined);',
    );
    expect(flat).toContain("{state === 'owed' ? ( <Button block wrap onPress={openWebsite}");
    expect(AUTHENTICATOR_SET_UP_URL).toBe('/dashboard/settings/security?enroll=1');
  });

  it("Check again reads at once (not the queue's ask), then says what it found while still held", () => {
    const fn = flat.slice(
      flat.indexOf('async function checkAgain()'),
      flat.indexOf('async function onSignOut()'),
    );
    expect(fn).toContain('if (checking) return; setChecking(true);');
    expect(fn).toContain('await readSetUpInputsForHold(userId);');
    expect(fn).toContain(
      'if (!mounted.current) return; const found = setUpHoldDetails(session?.user); if (found.hold) AccessibilityInfo.announceForAccessibility(holdBody(found.hold, found));',
    );
    expect(flat).not.toMatch(
      /requestSetUpInputsRead|noteKeptRefusal|setUpAnswerAfterRefusal|askForSetUpRead/,
    );
  });

  it('Switch workspace only with more than one workspace, through the switcher sheet as it is', () => {
    expect(flat).toContain('const { orgs } = useWorkspace();');
    expect(flat.match(/orgs\.length > 1/g)).toHaveLength(2);
    expect(flat).toContain(
      '<WorkspaceSwitcherSheet visible={switching} onDismiss={() => setSwitching(false)} />',
    );
    expect(flat).toContain('onPress={() => setSwitching(true)}');
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
  it('the title is a header and takes focus when the screen replaces the app', () => {
    expect(flat).toContain('<View ref={title} accessible accessibilityRole="header">');
    expect(flat).toContain("if (node) AccessibilityInfo.sendAccessibilityEvent(node, 'focus');");
  });

  it('the content scrolls (the largest text on a 320pt phone), with the safe area kept', () => {
    expect(flat).toContain('<ScrollView');
    expect(flat).toContain('paddingBottom: insets.bottom + 24');
  });

  it('Classic look only: no Liquid Glass hook or part', () => {
    expect(raw).not.toMatch(/useGlass|\/glass\/|GLASS_|\blg\b/);
  });
});
