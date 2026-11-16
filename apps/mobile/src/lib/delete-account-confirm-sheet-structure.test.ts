import * as path from 'node:path';

import { DELETE_ACCOUNT_CONFIRM_COPY as CORE_DELETE_CONFIRM_WORDS } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import {
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';

/**
 * Security invariant: the delete-account sheet takes the password with
 * secure entry and the emailed code with the one-time-code field, shows only
 * core's words for them, and neither it nor its module logs, stores or
 * reports what is typed; the sign-out that discards queued work runs on the
 * delete route's "gone" answer only.
 *
 * STRUCTURE PINS in the suite's own style: the mobile suite has no React
 * Native renderer (sheet-a11y-structure.test.ts), so this reads the element
 * tree the sheet declares. The screen itself is proved by the simulator rows.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SHEET = 'src/components/delete-account-confirm-sheet.tsx';
const MODULE = 'src/lib/account-delete.ts';

const sheetSource = readSource(path.join(MOBILE_ROOT, SHEET));
const moduleSource = readSource(path.join(MOBILE_ROOT, MODULE));
const sf = parseTsx(sheetSource, SHEET);

const elements: JsxNode[] = [];
walkJsx(sf, (el) => elements.push(el));
const named = (tag: string) => elements.filter((el) => tagOf(el, sf) === tag);
const a = (el: JsxNode, name: string) => attrText(el, name, sf);

/** Code only: comments dropped, so a word in a comment proves nothing. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the fields', () => {
  const inputs = named('TextInput');

  it('three fields: the typed word, the password, the code', () => {
    expect(inputs.map((el) => a(el, 'accessibilityLabel'))).toEqual([
      'Type DELETE to confirm',
      'CORE_DELETE_CONFIRM_WORDS.passwordLabel',
      'CORE_DELETE_CONFIRM_WORDS.codeLabel',
    ]);
  });

  it('the password uses secure entry and the current-password autofill, and only it', () => {
    const password = inputs[1]!;
    expect(a(password, 'secureTextEntry')).toBe('true');
    expect(a(password, 'textContentType')).toBe('password');
    expect(a(password, 'autoComplete')).toBe('current-password');
    expect(a(password, 'autoCapitalize')).toBe('none');
    expect(a(password, 'autoCorrect')).toBe('false');
    for (const other of [inputs[0]!, inputs[2]!])
      expect(a(other, 'secureTextEntry')).toBeUndefined();
  });

  it('the code is a six-digit number pad with the one-time-code autofill', () => {
    const code = inputs[2]!;
    expect(a(code, 'keyboardType')).toBe('number-pad');
    expect(a(code, 'textContentType')).toBe('oneTimeCode');
    expect(a(code, 'autoComplete')).toBe('one-time-code');
    // No maxLength: it would cut a pasted "123 456" before the spaces go;
    // the flow keeps six digits (account-delete.test.ts).
    expect(a(code, 'maxLength')).toBeUndefined();
    expect(moduleSource).toContain(".replace(/[^0-9]/g, '').slice(0, 6)");
  });

  it('each hint is read once: the visible text, no accessibilityHint repeating it', () => {
    for (const input of inputs) expect(a(input, 'accessibilityHint')).toBeUndefined();
  });

  it('every field is read-only while a request is under way', () => {
    for (const input of inputs) expect(a(input, 'editable')).toBe('!busy');
  });
});

describe("the words are core's", () => {
  it("core's field words are imported under their own name beside the phone's warning", () => {
    expect(sheetSource).toContain(
      "import { DELETE_ACCOUNT_CONFIRM_COPY as CORE_DELETE_CONFIRM_WORDS } from '@stockpilot/core';",
    );
    expect(sheetSource).toContain(
      "import { DELETE_ACCOUNT_CONFIRM_COPY } from '@/lib/deleted-user-labels';",
    );
  });

  it('labels, hints and the three choices', () => {
    const code = codeOnly(sheetSource);
    for (const key of Object.keys(CORE_DELETE_CONFIRM_WORDS)) {
      expect(code, key).toContain(`CORE_DELETE_CONFIRM_WORDS.${key}`);
    }
    expect(CORE_DELETE_CONFIRM_WORDS).toMatchObject({
      emailCode: 'Email me a code instead',
      sendAgain: 'Send a new code',
      usePassword: 'Use my password instead',
    });
  });

  it("the answer line shows the flow's sentence (core's), as an alert", () => {
    const [notice] = named('Text').filter((el) => a(el, 'accessibilityRole') === 'alert');
    expect(notice).toBeDefined();
    expect(notice!.getText(sf)).toContain('{s.notice}');
    // Never an error's own message.
    expect(codeOnly(sheetSource)).not.toMatch(/\.message\b/);
    expect(codeOnly(moduleSource)).not.toMatch(/\.message\b/);
  });

  it('each answer is also spoken when it appears, as the code screen does', () => {
    expect(sheetSource).toContain('import {\n  AccessibilityInfo,');
    expect(codeOnly(sheetSource)).toContain(
      'if (s.notice) AccessibilityInfo.announceForAccessibility(s.notice);\n  }, [s.notice]);',
    );
  });
});

describe('one flow per open, closed only through the flow', () => {
  it('a new content, and so a new flow, per open', () => {
    expect(sheetSource).toContain('key={String(visible)}');
  });

  it('the content forgets what was typed when it goes', () => {
    expect(sheetSource).toContain('React.useEffect(() => () => void flow.cancel(), [flow]);');
  });

  it('the system back goes through the close the flow can refuse', () => {
    expect(sheetSource).toContain('onRequestClose={() => (closeRef.current ?? onClose)()}');
    expect(sheetSource).toContain('closeRef.current = close;');
  });

  it("every request is sent as the session's own account", () => {
    expect(sheetSource).toContain('userId: session?.user?.id ?? null,');
    expect(moduleSource).toContain("asUserId: opts.userId ?? '',");
  });

  it('the hook: one opener, the sheet closes it only through onClose', () => {
    const hook = sheetSource.slice(
      sheetSource.indexOf('export function useDeleteAccountConfirm('),
      sheetSource.indexOf('export function DeleteAccountConfirmSheet('),
    );
    expect(hook).toContain('const [opener] = React.useState(createAccountDeleteOpener);');
    expect(hook).toContain('React.useSyncExternalStore(opener.subscribe, opener.isOpen)');
    expect(hook).toContain('open: opener.open,');
    expect(hook).toContain('onClose={opener.closed}');
    expect(hook.match(/opener\.closed/g)).toHaveLength(1);
  });

  it('an ended flow offers Close once nothing is under way (also after a deletion whose sign-out could not finish)', () => {
    expect(sheetSource).toContain(') : !busy ? (');
    expect(sheetSource).not.toContain("s.ended !== 'done' ? (");
  });
});

describe('roles and the sheet', () => {
  it("the Modal is the app wrapper (it holds the update pop-up), never react-native's", () => {
    expect(sheetSource).toContain("import { Modal } from '@/components/ui/modal';");
    expect(sheetSource).not.toMatch(/import \{[^}]*\bModal\b[^}]*\} from 'react-native'/);
  });

  it('the title is a header; the container is modal; the backdrop is a Close button', () => {
    const header = named('Text').filter((el) => a(el, 'accessibilityRole') === 'header');
    expect(header).toHaveLength(1);
    expect(header[0]!.getText(sf)).toContain('Delete your account?');
    const container = named('View').find((el) => a(el, 'accessibilityViewIsModal') === 'true');
    expect(container && a(container, 'onAccessibilityEscape')).toBe('close');
    const [backdrop] = named('Pressable');
    expect(a(backdrop!, 'accessibilityLabel')).toBe('Close');
    expect(a(backdrop!, 'onPress')).toBe('close');
    expect(a(backdrop!, 'onAccessibilityTap')).toBe('close');
  });

  it('every control is a button', () => {
    const pressables = named('Pressable');
    expect(pressables.length).toBeGreaterThanOrEqual(7);
    for (const p of pressables) expect(a(p, 'accessibilityRole')).toBe('button');
  });

  it('Cancel is refused while a delete is under way; Delete only when ready', () => {
    const labelled = (word: string) =>
      named('Pressable').find((p) => p.getText(sf).includes(`>${word}</Text>`));
    expect(a(labelled('Cancel')!, 'disabled')).toBe('deleting');
    expect(a(labelled('Cancel')!, 'onPress')).toBe('close');
    expect(a(labelled('Delete account')!, 'disabled')).toBe('!s.ready');
    expect(sheetSource).toContain('if (flow.cancel()) onClose();');
  });

  it('Classic look: no glass', () => {
    expect(codeOnly(sheetSource)).not.toMatch(/glass|Glass/);
  });
});

describe('nothing typed leaves the flow', () => {
  it('no console, storage, reporting or navigation in the sheet or its module', () => {
    for (const src of [sheetSource, moduleSource]) {
      const code = codeOnly(src);
      expect(code).not.toMatch(/\bconsole\./);
      expect(code).not.toMatch(
        /AsyncStorage|SecureStore|expo-secure-store|sqlite|Sentry|captureException|reportError/,
      );
      expect(code).not.toMatch(/\brouter\b|Linking/);
    }
  });

  it('the sign-out that discards queued work runs once, on the "done" answer only', () => {
    const code = codeOnly(moduleSource);
    expect(code.match(/deps\.signOutAfterDeleted\(/g)).toHaveLength(1);
    const done = code.indexOf("case 'done': {");
    const signOut = code.indexOf('deps.signOutAfterDeleted(');
    const nextCase = code.indexOf("case 'sign_in':");
    expect(done).toBeGreaterThan(-1);
    expect(signOut).toBeGreaterThan(done);
    expect(signOut).toBeLessThan(nextCase);
    expect(code).toContain(
      'signOutAfterDeleted: () => opts.signOut({ afterAccountDeleted: true }),',
    );
  });

  it("every answer is read through core's accountDeleteAnswer", () => {
    const code = codeOnly(moduleSource);
    expect(
      code.match(/accountDeleteAnswer\(\{ route: '(delete|code)', \.\.\.input \}\)/g),
    ).toHaveLength(2);
  });
});
