import * as path from 'node:path';
import * as vm from 'node:vm';

import { ACCOUNT_DISABLED_MESSAGE, ACCOUNT_DISABLED_TITLE } from '@stockpilot/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import {
  TOUCHABLE_TAG,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { TYPE_CEILING, capTo, palette, type Palette } from './theme';

/**
 * THE PHONE'S SIGNED-OUT AND GATE SCREENS, READ AS SOURCE (redesign package
 * P5.4: the auth group's layout, Welcome and Sign in, the account-disabled,
 * MFA and biometric-lock gates, and the Face ID opt-in sheet).
 *
 * They took the reference look on the per-mode palette: the flat auth ground
 * (no mint wash), the shared Checkbox for "Keep me signed in", the shared
 * buttons, the refusal colour per mode for errors, the muted ink for words
 * that were in ink4, real 44pt targets, and a pulse that rests under Reduce
 * Motion. These pin what had to survive: every word and its order, every
 * auth path (password, Forgot?, Face ID, the opt-in, MFA, the lock, the
 * disabled account), the copy from core, the automation's "Sign in" label,
 * and the "Keep me signed in" state, which still does nothing (an owner
 * decision, CONFLICTS section B).
 *
 * No React Native renderer here (the scanner-structure.test.ts method): the
 * screens are read with the TypeScript parser, and the lock's pulse hooks
 * are compiled from the repository's own source and run with stand-ins.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const AUTH_LAYOUT = 'app/(auth)/_layout.tsx';
const WELCOME = 'app/(auth)/welcome.tsx';
const SIGN_IN = 'app/(auth)/sign-in.tsx';
const SHELL = 'src/components/auth/auth-shell.tsx';
const DISABLED = 'src/components/account-disabled-screen.tsx';
const MFA = 'src/components/mfa-challenge-screen.tsx';
const LOCK = 'src/components/biometric-lock-screen.tsx';
const OPT_IN = 'src/components/biometric-optin-sheet.tsx';

const LIGHT = palette('light');
const DARK = palette('dark');
const MODES: [string, Palette][] = [
  ['light', LIGHT],
  ['dark', DARK],
];

function sourceOf(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file));
}

function treeOf(file: string): ts.SourceFile {
  return parseTsx(sourceOf(file), file);
}

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** One space per run of whitespace, so a reflow never breaks a pin. */
function flat(src: string): string {
  return src.replace(/\s+/g, ' ');
}

/** A file's code, comments dropped and whitespace flattened. */
function code(file: string): string {
  return flat(codeOnly(sourceOf(file)));
}

/** A `name: {...}` entry of a file's StyleSheet.create (2-space indent). */
function styleBlock(file: string, name: string): string {
  return flat(new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(sourceOf(file))?.[1] ?? '');
}

/** Every element of a file that matches. */
function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = treeOf(file);
  const els: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(sf, (el, ancestors) => {
    if (match(el, sf)) els.push({ el, ancestors: [...ancestors] });
  });
  return { sf, els };
}

/** The words an element shows: its JSX text, children joined. */
function textOf(el: JsxNode, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).replace(/\s+/g, ' ').trim());
    ts.forEachChild(n, visit);
  };
  visit(el);
  return parts.filter(Boolean).join(' ');
}

/** Every piece of text a person can read or hear in a file, in source order. */
function wordsOf(file: string): string[] {
  const sf = treeOf(file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const t = n.getText(sf).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
    } else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** True when `words` holds every one of `expected`, in that order. */
function inOrder(words: string[], expected: string[]): boolean {
  let at = 0;
  for (const w of words) if (w === expected[at]) at += 1;
  return at === expected.length;
}

// ── The auth group ────────────────────────────────────────────────────────

it('the auth group is still the headerless stack named (auth), on the page colour', () => {
  expect(code(AUTH_LAYOUT)).toContain(
    '<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.paper }, }} />',
  );
  // RootGate tells the signed-out screens apart by this folder name.
  expect(sourceOf('app/_layout.tsx')).toContain("const inAuthGroup = segments[0] === '(auth)';");
});

describe('the auth shell: the brand on a flat ground', () => {
  it('the mint wash is gone (MintWash painted nothing), the lockup and gutters stay', () => {
    const shell = code(SHELL);
    expect(shell).not.toContain('MintWash');
    expect(shell).not.toContain('mint-wash');
    expect(shell).toContain('<BrandLockup size={26} />');
    expect(shell).toContain(
      'paddingTop: Math.max(insets.top, 24) + 16, paddingHorizontal: 24, paddingBottom: 12,',
    );
    expect(shell).toContain('<View style={[styles.root, { backgroundColor: c.paper }]}>');
    expect(shell).toContain(
      '<View style={[styles.content, { paddingBottom: insets.bottom }, contentStyle]}>',
    );
  });
});

describe('Welcome: every word, the way in, the muted words readable', () => {
  const words = wordsOf(WELCOME);

  // Source order: the feature cards and the stats are module constants
  // above the screen, then the screen top to bottom.
  it('says exactly what it said, in the same order', () => {
    expect(
      inOrder(words, [
        'Items that mean something',
        'Movements you can trust',
        'Purchase orders, end to end',
        'Live delivery tracking',
        'AI insights briefing',
        'Built for the floor',
        '240ms',
        'real-time sync',
        '6',
        'live integrations',
        '100%',
        'changes audited',
        'Multi',
        'tenant + RLS',
        'StockPilot',
        'Sign in',
        'INVENTORY + ORDER OPS',
        'Inventory software',
        'quiet enough',
        'to actually use.',
        'BUILT FOR OPERATIONS',
        'Get your stock',
        'under control.',
        'Sign in',
        'New here? Your organization admin can invite you.',
      ]),
    ).toBe(true);
    expect(words).toContain(
      'Lots, par levels, sell prices, costs — all first-class. Cycle counts that survive an audit.',
    );
    expect(words).toContain(
      'Draft → approve → in transit → received, three-way matched against your counts.',
    );
  });

  it('both ways to Sign in still open the sign-in screen; the top one is a button in a 44pt frame', () => {
    const welcome = code(WELCOME);
    expect((welcome.match(/router\.push\('\/\(auth\)\/sign-in'\)/g) ?? []).length).toBe(2);
    const { sf, els } = elements(WELCOME, (el, s) => tagOf(el, s) === 'Pressable');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!.el, 'hitSlop', sf)).toBeUndefined();
    expect(attrText(els[0]!.el, 'style', sf)).toBe('styles.signInFrame');
    expect(styleBlock(WELCOME, 'signInFrame')).toContain('minHeight: 44,');
    expect(welcome).toContain("<Button block onPress={() => router.push('/(auth)/sign-in')}");
  });

  it('the stat labels and the invite line read in the muted ink (ink4 was under AA)', () => {
    const welcome = code(WELCOME);
    expect(welcome).toContain(
      '<Mono size={9.5} tracking={0.04} color={c.ink3} style={{ marginTop: 4 }}> {s.label}',
    );
    expect(welcome).toContain(
      "<Body size={13} color={c.ink3} style={{ textAlign: 'center', marginTop: 4 }}> New here?",
    );
    expect(welcome).not.toContain('c.ink4');
    // The labels stay uncapped content (the Dynamic Type policy).
    expect(welcome).not.toMatch(/\{s\.label\}[\s\S]{0,40}maxFontSizeMultiplier/);
  });
});

// ── Sign in ───────────────────────────────────────────────────────────────

describe('Sign in: every control, word and path', () => {
  const src = sourceOf(SIGN_IN);
  const signIn = code(SIGN_IN);

  it('says exactly what it said, in the same order', () => {
    expect(
      inOrder(wordsOf(SIGN_IN), [
        'Sign in with your password first, then enable Face ID in Settings.',
        'Enable Face ID for this account in Settings · Security first.',
        'Enter your email above first, then tap “Forgot?”.',
        'Could not request a reset right now. Try again shortly.',
        'Could not request a reset right now. Check your connection.',
        'Check your email',
        'WELCOME BACK',
        'Sign in to',
        'StockPilot',
        'EMAIL',
        'ops@stockpilot.app',
        'PASSWORD',
        'Keep me signed in',
        'Forgot?',
        'Sign in',
        'or',
        'New to StockPilot? Your organization admin can invite you.',
      ]),
    ).toBe(true);
    expect(signIn).toContain(
      'Pick up where you left off. Counts, cycle audits, and pending POs sync as soon as you&apos;re back online.',
    );
    expect(signIn).toContain('{`Sign in with ${bioLabel}`}');
  });

  // The automation signs in with the button named exactly "Sign in".
  it('the password button is still the shared ink button named exactly "Sign in", with its spinner', () => {
    const { sf, els } = elements(
      SIGN_IN,
      (el, s) => tagOf(el, s) === 'Button' && textOf(el, s) === 'Sign in',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'onPress', sf)).toBe('submit');
    expect(attrText(els[0]!.el, 'disabled', sf)).toBe('busy');
    expect(attrText(els[0]!.el, 'variant', sf)).toBeUndefined();
    expect(signIn).toContain('<ActivityIndicator size="small" color={c.paper} />');
    expect(signIn).toContain('const res = await signIn(email.trim(), password);');
  });

  // P2.5b hand-off: the box was a hand-drawn 18pt square in a Pressable with
  // hitSlop and no checkbox role or state.
  it('"Keep me signed in" is the shared Checkbox: same words, same toggle, same state, still not passed to signIn', () => {
    const { sf, els } = elements(SIGN_IN, (el, s) => tagOf(el, s) === 'Checkbox');
    expect(els).toHaveLength(1);
    const box = els[0]!;
    expect(attrText(box.el, 'checked', sf)).toBe('keepIn');
    expect(attrText(box.el, 'onChange', sf)).toBe('() => setKeepIn((v) => !v)');
    expect(attrText(box.el, 'label', sf)).toBe('Keep me signed in');
    // Never inside a touchable (iOS would fold it into the row's element).
    expect(box.ancestors.some((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toBe(false);
    expect(signIn).toContain('const [keepIn, setKeepIn] = React.useState(true);');
    expect(src).toContain("import { Checkbox } from '@/components/ui/checkbox';");
    // The old hand-drawn box is gone, and keepIn still goes nowhere.
    expect(signIn).not.toContain('styles.checkbox');
    // keepIn is declared and shown, and read nowhere else (not by submit).
    expect(signIn.match(/(?<![.\w])keepIn(?![:\w])/g)).toEqual(['keepIn', 'keepIn']);
  });

  it('Forgot? still posts to the web reset endpoint, as a button in a real 44pt frame', () => {
    expect(signIn).toContain('await fetch(`${API_BASE}/api/v1/auth/password-reset`, {');
    expect(signIn).toContain('body: JSON.stringify({ email: target }),');
    expect(signIn).not.toContain('resetPasswordForEmail(');
    const { sf, els } = elements(
      SIGN_IN,
      (el, s) => tagOf(el, s) === 'Pressable' && textOf(el, s) === 'Forgot?',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'onPress', sf)).toBe('forgotPassword');
    expect(attrText(els[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!.el, 'hitSlop', sf)).toBeUndefined();
    expect(styleBlock(SIGN_IN, 'forgotFrame')).toContain('minHeight: 44,');
  });

  it('the password eye is a named button ("Show password" / "Hide password", the web field\'s names) in a 44pt frame', () => {
    const { sf, els } = elements(
      SIGN_IN,
      (el, s) =>
        tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === '() => setShowPw((p) => !p)',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!.el, 'accessibilityLabel', sf)).toBe(
      "showPw ? 'Hide password' : 'Show password'",
    );
    expect(attrText(els[0]!.el, 'hitSlop', sf)).toBeUndefined();
    const frame = styleBlock(SIGN_IN, 'eyeFrame');
    expect(frame).toContain('width: 44,');
    expect(frame).toContain('height: 44,');
    // The icon keeps its place at the frame's right edge.
    expect(frame).toContain("alignItems: 'flex-end',");
    expect(signIn).toContain('secureTextEntry={!showPw}');
  });

  it('errors read in the refusal colour of the mode (the fixed red was 3.09:1 on the dark card) and are said aloud', () => {
    expect(signIn).toContain('<Body size={13} color={c.critText}> {error} </Body>');
    expect(src).not.toContain('#b03a3a');
    expect(signIn).toContain('if (error) AccessibilityInfo.announceForAccessibility(error);');
  });

  it('Face ID sign-in, the opt-in sheet, autofill and the keyboard behaviour are unchanged', () => {
    expect(signIn).toContain('{bioCapable ? (');
    expect(signIn).toContain('<Button block variant="outline" onPress={signInWithBiometric}');
    expect(signIn).toContain(
      '<BiometricOptInSheet visible={showOptIn} onDismiss={() => setShowOptIn(false)} />',
    );
    expect(signIn).toContain(
      'if (uid && !(await isBiometricEnabledForUser(uid))) { setShowOptIn(true); }',
    );
    expect(signIn).toContain('textContentType="username"');
    expect(signIn).toContain('textContentType="password"');
    expect(signIn).toContain('autoComplete="current-password"');
    expect(signIn).toContain("behavior={Platform.OS === 'ios' ? 'padding' : undefined}");
    expect(signIn).toContain('keyboardShouldPersistTaps="handled"');
  });

  it('the invite line and the divider word read in the muted ink', () => {
    expect(signIn).toContain('<Mono size={10.5} tracking={0.18} upper color={c.ink3}> or </Mono>');
    expect(signIn).toContain(
      "<Body size={13} color={c.ink3} style={{ textAlign: 'center' }}> New to StockPilot?",
    );
  });
});

// ── The gates ─────────────────────────────────────────────────────────────

describe('the account-disabled gate', () => {
  it('the copy comes from core, unchanged, and Sign out is the shared outline button (dimmed while it runs)', () => {
    const screen = code(DISABLED);
    expect(screen).toContain('{ACCOUNT_DISABLED_TITLE}');
    expect(screen).toContain('{ACCOUNT_DISABLED_MESSAGE}');
    expect(screen).not.toContain(ACCOUNT_DISABLED_TITLE);
    expect(screen).not.toContain(ACCOUNT_DISABLED_MESSAGE);
    expect(screen).toContain('<Display size={28} accessibilityRole="header">');
    expect(screen).toContain(
      '<Button block variant="outline" onPress={() => void onSignOut()} disabled={busy}> Sign out </Button>',
    );
    expect(screen).toContain('const ended = await signOutToFallback();');
    expect(screen).toContain('<View style={[styles.iconRing, { borderColor: c.hair2 }]}>');
  });
});

describe('the MFA gate', () => {
  const mfa = code(MFA);

  it('says exactly what it said, in the same order', () => {
    expect(
      inOrder(wordsOf(MFA), [
        'TWO-FACTOR AUTHENTICATION',
        'Enter your',
        'code.',
        'Open your authenticator app (Google Authenticator, 1Password, etc.) and enter the 6-digit code for StockPilot.',
        '123456',
        'Verify',
        'Use a different account',
      ]),
    ).toBe(true);
  });

  it('still auto-submits at six digits and refuses Verify until there are six', () => {
    expect(mfa).toContain("const digits = next.replace(/[^0-9]/g, '').slice(0, 6);");
    expect(mfa).toContain('if (digits.length === 6) void submit(digits);');
    expect(mfa).toContain('textContentType="oneTimeCode"');
    expect(mfa).toContain('autoComplete="one-time-code"');
    expect(mfa).toContain('maxLength={6}');
  });

  it('Verify is the shared ink button and keeps its word beside the spinner; the way out is the borderless one', () => {
    expect(mfa).toContain(
      '<Button block onPress={() => void submit(code)} disabled={busy || code.length !== 6} trailing={busy ? <ActivityIndicator color={c.paper} /> : undefined} > Verify </Button>',
    );
    expect(mfa).toContain(
      '<Button block variant="ghost" onPress={() => void signOutToFallback()} disabled={busy}> Use a different account </Button>',
    );
  });

  it('the code box: named for VoiceOver, placeholder in the muted ink, the stronger border, the refusal colour after a wrong code, the input ceiling', () => {
    expect(mfa).toContain('accessibilityLabel="6-digit code"');
    expect(mfa).toContain('placeholderTextColor={c.ink3}');
    expect(mfa).toContain('borderColor: error ? c.critText : c.hair2');
    expect(mfa).toContain('maxFontSizeMultiplier={CODE_CAP}');
    expect(mfa).toContain('const CODE_CAP = capTo(26, TYPE_CEILING.input);');
    expect(capTo(26, TYPE_CEILING.input)).toBe(1);
    expect(mfa).toContain(
      '<Body size={13} color={c.critText} style={{ marginTop: 10 }}> {error} </Body>',
    );
    expect(mfa).toContain('if (error) AccessibilityInfo.announceForAccessibility(error);');
    expect(mfa).not.toContain('ACCENT');
  });
});

describe('the biometric lock', () => {
  const lock = code(LOCK);

  it('says exactly what it said', () => {
    const words = wordsOf(LOCK);
    for (const w of [
      'UNLOCK STOCKPILOT',
      'Signed in as',
      'StockPilot',
      'That didn&apos;t verify.',
      'Try again.',
      'Use your',
      'password',
      'to continue.',
      'Look at your screen to',
      'unlock.',
      'Unlock with',
      'Use password instead',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  it('the Face ID prompt still waits for the splash, and fires once', () => {
    expect(lock).toContain('if (splashActive) return;');
    expect(lock).toContain('if (attempted) return;');
    expect(lock).toContain('void tryUnlock();');
    expect(lock).toContain(
      '<Button block variant="ghost" onPress={signOutToFallback}> Use password instead </Button>',
    );
  });

  it('the pulse is a hook that listens for Reduce Motion; the pip is the accent; the ring the stronger line', () => {
    expect(lock).toContain('const pulse = useLockPulse();');
    expect(lock).toContain("AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => {");
    expect(lock).toContain('if (reduceMotion !== false) { pulse.setValue(0); return; }');
    expect(lock).toContain('return () => loop.stop();');
    expect(lock).toContain('<View style={[styles.pip, { backgroundColor: c.accent }]} />');
    expect(lock).toContain('borderColor: c.hair2,');
    expect(lock).not.toContain('ACCENT');
  });

  // The defect: the ring pulsed forever, under Reduce Motion too, and the
  // loop was never stopped. Run the screen's own hooks with stand-ins.
  describe('the pulse, run', () => {
    type Loop = { started: number; stopped: number };
    function harness(reduce: boolean) {
      const loops: Loop[] = [];
      const listeners: ((on: boolean) => void)[] = [];
      let removed = 0;
      const value = {
        v: 0,
        setValue(x: number) {
          this.v = x;
        },
      };
      let compiled: { useLockPulse: () => typeof value };
      const host: HookHost<typeof value> = new HookHost(() => compiled.useLockPulse());
      compiled = compileTopLevel(LOCK, ['useReduceMotion', 'useLockPulse'], {
        React: host.React,
        AccessibilityInfo: {
          isReduceMotionEnabled: () => Promise.resolve(reduce),
          addEventListener: (_: string, fn: (on: boolean) => void) => {
            listeners.push(fn);
            return { remove: () => (removed += 1) };
          },
        },
        Animated: {
          timing: () => ({}),
          loop: () => {
            const loop: Loop = { started: 0, stopped: 0 };
            loops.push(loop);
            return { start: () => (loop.started += 1), stop: () => (loop.stopped += 1) };
          },
        },
        Easing: { bezier: () => 'ease' },
        useAnimatedValue: () => value,
      }) as typeof compiled;
      return { host, loops, listeners, value, removed: () => removed };
    }
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

    it('Reduce Motion on: the ring never moves', async () => {
      const h = harness(true);
      h.host.render();
      await settle();
      expect(h.loops).toEqual([]);
      expect(h.value.v).toBe(0);
    });

    it('until iOS answers, the ring rests', () => {
      const h = harness(false);
      h.host.render();
      expect(h.loops).toEqual([]);
    });

    it('Reduce Motion off: one loop; turned on, it stops and stays still; off again, it moves; gone, it stops and stops listening', async () => {
      const h = harness(false);
      h.host.render();
      await settle();
      expect(h.loops).toEqual([{ started: 1, stopped: 0 }]);
      h.listeners[0]!(true);
      expect(h.loops).toEqual([{ started: 1, stopped: 1 }]);
      expect(h.value.v).toBe(0);
      h.listeners[0]!(false);
      expect(h.loops).toEqual([
        { started: 1, stopped: 1 },
        { started: 1, stopped: 0 },
      ]);
      h.host.unmount();
      expect(h.loops[1]).toEqual({ started: 1, stopped: 1 });
      expect(h.removed()).toBe(1);
    });
  });
});

describe('the Face ID opt-in sheet', () => {
  const sheet = code(OPT_IN);

  it('says exactly what it said', () => {
    const words = wordsOf(OPT_IN);
    for (const w of [
      'ONE-TAP SIGN-IN',
      'Use',
      'next time?',
      'Settings · Security',
      'Enable',
      'Not now',
      'Close',
    ]) {
      expect(words, w).toContain(w);
    }
    expect(sheet).toContain(
      "Unlock StockPilot faster and skip typing your password on this device. You can turn it off any time in{' '}",
    );
  });

  it('the grabber is the faint ink token, the pip the accent, the settings path in the body face', () => {
    expect(sheet).toContain('<View style={[styles.grabber, { backgroundColor: c.ink5 }]} />');
    expect(sheet).toContain('<View style={[styles.pip, { backgroundColor: c.accent }]} />');
    expect(sheet).toContain(
      '<Body color={c.ink} style={{ fontFamily: FONT.display }}> Settings · Security </Body>',
    );
    expect(sheet).not.toContain('ACCENT');
    expect(sheet).not.toMatch(/rgba\(250,250,247/);
  });

  it('Enable and Not now are unchanged', () => {
    expect(sheet).toContain('<Button block disabled={busy} onPress={handleEnable}');
    expect(sheet).toContain('<Button block variant="ghost" onPress={onDismiss}> Not now </Button>');
    expect(sheet).toContain('await enableBiometric();');
  });
});

// ── Contrast of every pair this package changed, both modes ──────────────

describe('contrast (WCAG 2.x): every word at 4.5:1, every mark at 3:1, in both modes', () => {
  // [what, fg token, bg token, minimum]
  const PAIRS: [string, keyof Palette, keyof Palette, number][] = [
    ['Sign in: the invite line and "or"', 'ink3', 'paper', AA_TEXT],
    ['Sign in: an error, on the card', 'critText', 'card', AA_TEXT],
    ['Sign in: Keep me signed in', 'ink', 'card', AA_TEXT],
    ['Sign in: Forgot?', 'ink2', 'card', AA_TEXT],
    ['Sign in: the password eye', 'ink4', 'card', AA_UI],
    ['Welcome: the stat labels and the invite line', 'ink3', 'paper', AA_TEXT],
    ['MFA: the placeholder', 'ink3', 'card', AA_TEXT],
    ['MFA: an error, on the page', 'critText', 'paper', AA_TEXT],
    ['MFA: the code box edge after a wrong code', 'critText', 'paper', AA_UI],
    ['MFA: Verify', 'paper', 'ink', AA_TEXT],
    ['MFA: Use a different account', 'ink', 'paper', AA_TEXT],
    ['Disabled: Sign out', 'ink', 'card', AA_TEXT],
    ['Lock: the pip', 'accent', 'paper', AA_UI],
    ['Opt-in: the pip', 'accent', 'card', AA_UI],
    ['Opt-in: Settings · Security', 'ink', 'card', AA_TEXT],
  ];

  it.each(MODES)('%s', (_mode, c) => {
    const failing = PAIRS.filter(([, fg, bg, min]) => contrast(c[fg], c[bg]) < min).map(
      ([what, fg, bg]) => `${what}: ${fg} on ${bg} = ${contrast(c[fg], c[bg]).toFixed(2)}`,
    );
    expect(failing).toEqual([]);
  });

  it('the old values that failed: the fixed red on the dark card, ink4 words', () => {
    expect(contrast('#b03a3a', DARK.card)).toBeLessThan(AA_TEXT);
    expect(contrast(LIGHT.ink4, LIGHT.paper)).toBeLessThan(AA_TEXT);
    expect(contrast(DARK.ink4, DARK.paper)).toBeLessThan(AA_TEXT);
  });
});

// ── Test-only helpers: compile a file's own functions, run one hook ──────

/**
 * Top-level functions and constants of a file, compiled from the repository's
 * own source (never from input) and run in a context holding only what the
 * caller hands in.
 */
function compileTopLevel(
  file: string,
  names: string[],
  context: Record<string, unknown>,
): Record<string, unknown> {
  const sf = treeOf(file);
  const parts: string[] = [];
  const found = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && names.includes(st.name.text)) {
      parts.push(st.getText(sf));
      found.add(st.name.text);
    }
  }
  expect([...found].sort(), `${names.join(', ')} in ${file}`).toEqual([...names].sort());
  const js = ts.transpileModule(`${parts.join('\n')}\n({ ${names.join(', ')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext({ ...context }) as Record<string, unknown>;
}

/**
 * Just enough of React's hooks to run one custom hook outside a renderer
 * (the same stand-in as phone-shell-structure.test.ts).
 */
class HookHost<T> {
  private states: unknown[] = [];
  private effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  private queue: (() => void)[] = [];
  private stateIndex = 0;
  private effectIndex = 0;
  private dirty = false;
  private rendering = false;
  value!: T;

  constructor(private readonly hook: () => T) {}

  readonly React = {
    useState: <S>(init: S | (() => S)): readonly [S, (next: S | ((prev: S) => S)) => void] => {
      const i = this.stateIndex++;
      if (i >= this.states.length) {
        this.states.push(typeof init === 'function' ? (init as () => S)() : init);
      }
      const set = (next: S | ((prev: S) => S)) => {
        const prev = this.states[i] as S;
        const value = typeof next === 'function' ? (next as (p: S) => S)(prev) : next;
        if (Object.is(value, prev)) return;
        this.states[i] = value;
        if (this.rendering) this.dirty = true;
        else this.render();
      };
      return [this.states[i] as S, set] as const;
    },
    useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => {
      const i = this.effectIndex++;
      const prev = this.effects[i];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, k) => !Object.is(d, prev.deps![k]));
      if (!changed) return;
      this.queue.push(() => {
        prev?.cleanup?.();
        const cleanup = fn();
        this.effects[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    },
  };

  render(): T {
    this.rendering = true;
    do {
      this.dirty = false;
      this.stateIndex = 0;
      this.effectIndex = 0;
      this.value = this.hook();
      for (const run of this.queue.splice(0)) run();
    } while (this.dirty);
    this.rendering = false;
    return this.value;
  }

  unmount(): void {
    for (const e of this.effects) e?.cleanup?.();
  }
}
