import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every native alert holds the phone update pop-up until one of its buttons is
 * pressed (alert-holds.ts, B44). React Native is replaced by a fake whose
 * Alert.alert hands every alert to Alert.prompt on iOS, as React Native's own
 * Alert.js does (pinned at the end), and whose Alert.prompt records what it
 * was given; pressing a button calls the onPress it was given, as the native
 * side does.
 */

interface ButtonLike {
  text?: string;
  style?: string;
  onPress?: (value?: string) => void;
}

interface Shown {
  title: string;
  message?: string;
  buttons: ButtonLike[];
  type?: string;
  options?: { onDismiss?: () => void };
}

type AlertHolds = typeof import('./alert-holds');
type Holds = typeof import('./update-prompt-holds');

async function load(os: 'ios' | 'android') {
  vi.resetModules();
  const shown: Shown[] = [];
  const platform = { OS: os };

  class FakeAlert {
    static alert(
      title: string,
      message?: string,
      buttons?: ButtonLike[],
      options?: { onDismiss?: () => void },
    ): void {
      if (platform.OS === 'ios') {
        FakeAlert.prompt(title, message, buttons, 'default', undefined, undefined, options);
      } else {
        shown.push({ title, message, buttons: buttons ?? [], options });
      }
    }

    static prompt(
      title: string,
      message?: string,
      callbackOrButtons?: ((text: string) => void) | ButtonLike[],
      type: string = 'plain-text',
      _defaultValue?: string,
      _keyboardType?: string,
      options?: { onDismiss?: () => void },
    ): void {
      // A callback reaches native as no buttons; record it as the one OK.
      const buttons =
        typeof callbackOrButtons === 'function'
          ? [{ text: '(callback)', onPress: callbackOrButtons as (value?: string) => void }]
          : (callbackOrButtons ?? []);
      shown.push({ title, message, buttons, type, options });
    }
  }

  vi.doMock('react-native', () => ({ Alert: FakeAlert, Platform: platform }));
  const holds: Holds = await import('./update-prompt-holds');
  const alertHolds: AlertHolds = await import('./alert-holds');
  return { Alert: FakeAlert, shown, holds, install: alertHolds.installAlertHolds };
}

/** Presses button `index` of alert `n`, as native does (a prompt passes its text). */
function press(shown: Shown[], n: number, index: number, value?: string): void {
  shown[n]!.buttons[index]!.onPress?.(value);
}

afterEach(() => {
  vi.doUnmock('react-native');
  vi.resetModules();
});

describe('on iOS', () => {
  it('installs once', async () => {
    const { Alert, install } = await load('ios');
    install();
    const once = Alert.prompt;
    install();
    expect(Alert.prompt).toBe(once);
  });

  it('holds from the moment an alert shows until a button is pressed, after its own onPress', async () => {
    const { Alert, shown, holds, install } = await load('ios');
    install();
    let heldDuringPress: boolean | null = null;
    const onRemove = vi.fn(() => {
      heldDuringPress = holds.isUpdatePromptHeld();
    });
    Alert.alert('Remove file?', 'packing-slip.pdf', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: onRemove },
    ]);
    expect(holds.isUpdatePromptHeld()).toBe(true);
    expect(holds.updatePromptHoldReasons()).toEqual(['alert']);
    expect(shown[0]!.buttons.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Remove', 'destructive'],
    ]);
    press(shown, 0, 1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(heldDuringPress).toBe(true);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('releases for a button with no onPress of its own', async () => {
    const { Alert, shown, holds, install } = await load('ios');
    install();
    Alert.alert('Saved', undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'OK' }]);
    press(shown, 0, 0);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('names the OK that iOS shows when no buttons are given, and it releases', async () => {
    const { Alert, shown, holds, install } = await load('ios');
    install();
    Alert.alert('Saved');
    expect(shown[0]!.type).toBe('default');
    expect(shown[0]!.buttons.map((b) => [b.text, b.style])).toEqual([['OK', 'cancel']]);
    press(shown, 0, 0);
    expect(holds.isUpdatePromptHeld()).toBe(false);

    Alert.prompt('Rename', 'New name');
    expect(shown[1]!.type).toBe('plain-text');
    expect(shown[1]!.buttons.map((b) => [b.text, b.style])).toEqual([
      ['OK', undefined],
      ['Cancel', 'cancel'],
    ]);
    press(shown, 1, 1);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('passes a prompt’s typed value to the button', async () => {
    const { Alert, shown, holds, install } = await load('ios');
    install();
    const onSave = vi.fn();
    Alert.prompt('Note', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Save', onPress: onSave },
    ]);
    press(shown, 0, 1, 'Two cases short');
    expect(onSave).toHaveBeenCalledWith('Two cases short');
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('turns the callback form into OK and Cancel, the callback behind OK', async () => {
    const { Alert, shown, holds, install } = await load('ios');
    install();
    const callback = vi.fn();
    Alert.prompt('Code', 'Enter the code', callback);
    expect(shown[0]!.buttons.map((b) => [b.text, b.style])).toEqual([
      ['OK', undefined],
      ['Cancel', 'cancel'],
    ]);
    expect(holds.isUpdatePromptHeld()).toBe(true);
    press(shown, 0, 0, '1234');
    expect(callback).toHaveBeenCalledWith('1234');
    expect(holds.isUpdatePromptHeld()).toBe(false);

    Alert.prompt('Code', 'Enter the code', callback);
    press(shown, 1, 1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('stays held when a button opens another alert', async () => {
    const { Alert, shown, holds, install } = await load('ios');
    install();
    Alert.alert('Start a cycle count?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Start', onPress: () => Alert.alert('Count started') },
    ]);
    press(shown, 0, 1);
    expect(shown).toHaveLength(2);
    expect(holds.isUpdatePromptHeld()).toBe(true);
    press(shown, 1, 0);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('releases even when the button’s own onPress throws', async () => {
    const { Alert, shown, holds, install } = await load('ios');
    install();
    Alert.alert('Oops', undefined, [
      {
        text: 'OK',
        onPress: () => {
          throw new Error('handler failed');
        },
      },
    ]);
    expect(() => press(shown, 0, 0)).toThrow('handler failed');
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });
});

describe('on Android', () => {
  it('wraps Alert.alert: a button releases, and so does a dismiss', async () => {
    const { Alert, shown, holds, install } = await load('android');
    install();
    const onDismiss = vi.fn();
    const onOk = vi.fn();
    Alert.alert('Saved', undefined, [{ text: 'OK', onPress: onOk }], { onDismiss });
    expect(holds.isUpdatePromptHeld()).toBe(true);
    press(shown, 0, 0);
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(holds.isUpdatePromptHeld()).toBe(false);

    Alert.alert('Saved', undefined, [{ text: 'OK' }], { onDismiss });
    expect(holds.isUpdatePromptHeld()).toBe(true);
    shown[1]!.options!.onDismiss!();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });

  it('names the OK that Android shows when no buttons are given, and it releases', async () => {
    const { Alert, shown, holds, install } = await load('android');
    install();
    Alert.alert('Saved');
    expect(shown[0]!.buttons.map((b) => b.text)).toEqual(['OK']);
    press(shown, 0, 0);
    expect(holds.isUpdatePromptHeld()).toBe(false);
  });
});

describe('React Native', () => {
  it('still hands every iOS alert to Alert.prompt (what this wrapping relies on)', () => {
    const file = path.resolve(
      __dirname,
      '../../node_modules/react-native/Libraries/Alert/Alert.js',
    );
    const source = readFileSync(file, 'utf8');
    const alertBody = source.slice(
      source.indexOf('static alert('),
      source.indexOf('static prompt('),
    );
    expect(alertBody).toMatch(/if \(Platform\.OS === 'ios'\) \{\s*Alert\.prompt\(/);
  });
});
