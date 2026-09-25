import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { auditTouchSinks, listTsx, readSource } from './__fixtures__/jsx-touch-audit';

/**
 * GUARD: no touchable may wrap a sheet, dialog or any other content it does
 * not itself act on.
 *
 * The defect (simulator walk 2026-09-25): the item screen's Adjust stock sheet
 * was a scrim `<Pressable onPress={onClose}>` wrapping a card
 * `<Pressable onPress={() => undefined}>`. Pressables are accessibility
 * elements by default and iOS collapses their children, so VoiceOver read the
 * whole sheet as ONE element and could not reach the CHANGE field or the
 * Confirm button on their own. The same wrapper claims the touch responder and
 * blocks scrolling inside the sheet (add-order-items-sheet.tsx, 2026-08-14).
 * The fix is the sibling backdrop: a flex:1 container, an absolute-fill scrim
 * Pressable BEHIND the card, and the card as a plain View.
 *
 * This sweep reads every screen and component, so a new sheet built the old
 * way fails here, whichever spelling it uses: `() => undefined`, `() => {}`,
 * `e.stopPropagation()`, a bare Pressable with no handler, a
 * TouchableWithoutFeedback, or a View that claims the responder.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

describe('touch-sink detector', () => {
  const rules = (src: string) => auditTouchSinks(src).map((f) => f.rule);

  it('catches the pre-fix Adjust sheet shape (scrim parent + no-op card)', () => {
    const before = `
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable onPress={onClose} style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable onPress={() => undefined} style={{ backgroundColor: c.card }}>
            <Eyebrow>ADJUST STOCK</Eyebrow>
            <TextInput value={delta} onChangeText={setDelta} />
            <Button onPress={onClose}>Cancel</Button>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>`;
    const found = auditTouchSinks(before);
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [4, 'noop-onpress'],
      [3, 'wraps-text-input'],
      [4, 'wraps-text-input'],
    ]);
  });

  it.each([
    ['() => undefined', '<Pressable onPress={() => undefined}><View /></Pressable>'],
    ['() => {}', '<Pressable onPress={() => {}}><View /></Pressable>'],
    ['() => null', '<Pressable onPress={() => null}><View /></Pressable>'],
    ['() => void 0', '<Pressable onPress={() => void 0}><View /></Pressable>'],
    ['() => { return; }', '<Pressable onPress={() => { return; }}><View /></Pressable>'],
    ['function () {}', '<Pressable onPress={function () {}}><View /></Pressable>'],
    ['stopPropagation', '<Pressable onPress={(e) => e.stopPropagation()}><View /></Pressable>'],
    ['block stopPropagation', '<Pressable onPress={(e) => { e.stopPropagation(); }}><View /></Pressable>'],
    ['noop', '<TouchableOpacity onPress={noop}><View /></TouchableOpacity>'],
    ['TouchableWithoutFeedback', '<TouchableWithoutFeedback onPress={() => {}}><View /></TouchableWithoutFeedback>'],
  ])('flags a no-op onPress that wraps content: %s', (_label, src) => {
    expect(rules(src)).toEqual(['noop-onpress']);
  });

  it.each([
    ['bare Pressable', '<Pressable style={s.card}><Body>hi</Body></Pressable>'],
    ['onPress={undefined}', '<Pressable onPress={undefined}><Body>hi</Body></Pressable>'],
    ['bare TouchableWithoutFeedback', '<TouchableWithoutFeedback><View /></TouchableWithoutFeedback>'],
  ])('flags a touchable with no press handler that wraps content: %s', (_label, src) => {
    expect(rules(src)).toEqual(['no-press-handler']);
  });

  it('flags a real scrim that still wraps a text field', () => {
    const src = `
      <TouchableWithoutFeedback onPress={onClose}>
        <View><TextInput value={q} /><TextInput value={r} /></View>
      </TouchableWithoutFeedback>`;
    // One wrapper, one finding, even with two fields inside.
    expect(rules(src)).toEqual(['wraps-text-input']);
  });

  it('flags a card that swallows taps by claiming the responder inside a scrim', () => {
    const src = `
      <Pressable onPress={onClose}>
        <View onStartShouldSetResponder={() => true}><Body>Card</Body></View>
      </Pressable>`;
    expect(rules(src)).toEqual(['swallows-responder']);
  });

  it.each([
    [
      'the sibling backdrop',
      `<View style={{ flex: 1, justifyContent: 'flex-end' }} accessibilityViewIsModal>
         <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close"
           style={[StyleSheet.absoluteFill, { backgroundColor: scrim }]} />
         <View style={card}><TextInput value={delta} /><Button onPress={onClose}>Cancel</Button></View>
       </View>`,
    ],
    ['a long-press thumbnail', '<Pressable onLongPress={() => remove(uri)}><Image source={src} /></Pressable>'],
    ['a conditional handler', '<Pressable onPress={canEdit ? onPress : undefined}><Card /></Pressable>'],
    ['a void-called action', '<Pressable onPress={() => void submit()}><Mono>Save</Mono></Pressable>'],
    ['a spread wrapper', '<Pressable {...rest}><Text>{children}</Text></Pressable>'],
    ['a self-closing no-op', '<Pressable onPress={() => undefined} style={s.spacer} />'],
  ])('passes %s', (_label, src) => {
    expect(auditTouchSinks(src)).toEqual([]);
  });
});

describe('mobile app sweep — no touchable wraps a sheet', () => {
  const files = listTsx(path.join(MOBILE_ROOT, 'app'), path.join(MOBILE_ROOT, 'src'));
  const rel = (f: string) => path.relative(MOBILE_ROOT, f);

  it('reads the real screens (the sweep is not vacuous)', () => {
    const names = files.map(rel);
    expect(files.length).toBeGreaterThan(100);
    for (const expected of [
      'app/item/[id].tsx',
      'app/order/[id].tsx',
      'src/components/biometric-optin-sheet.tsx',
      'src/components/add-order-items-sheet.tsx',
      'app/(drawer)/notifications.tsx',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('finds no touchable wrapping content it does not act on', () => {
    const findings = files.flatMap((f) => auditTouchSinks(readSource(f), rel(f)));
    expect(findings.map((f) => `${f.file}:${f.line} <${f.tag}> ${f.rule}: ${f.detail}`)).toEqual([]);
  });
});
