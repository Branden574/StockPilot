// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { classicDom, glassOnlyCount, isHookAttribute } from './classic-dom';

function tree(html: string): Element {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('classicDom: the Liquid Glass classic-proof normalisation for unit tests', () => {
  it('drops the inert hook attributes and nothing else', () => {
    for (const name of [
      'data-glass',
      'data-glass-variant',
      'data-glass-size',
      'data-glass-role',
      'data-classic-only',
      'data-appearance-exempt',
    ]) {
      expect(isHookAttribute(name), name).toBe(true);
    }
    for (const name of ['data-slot', 'data-state', 'data-glassy', 'class', 'data-appearance']) {
      expect(isHookAttribute(name), name).toBe(false);
    }
    expect(
      classicDom(tree('<p data-glass="card" data-glass-role="x" data-slot="s" class="a">x</p>')),
    ).toBe(classicDom(tree('<p class="a" data-slot="s">x</p>')));
  });

  it('drops a glass-only element with its subtree, and counts them', () => {
    const withGlass = tree('<ul><li>a</li><li data-glass-only=""><a href="/x">x</a></li></ul>');
    expect(glassOnlyCount(withGlass)).toBe(1);
    expect(classicDom(withGlass)).toBe(classicDom(tree('<ul><li>a</li></ul>')));
  });

  it('still sees every real difference: a moved, added or changed element', () => {
    const base = classicDom(tree('<div><p>a</p><p>b</p></div>'));
    expect(classicDom(tree('<div><p>b</p><p>a</p></div>'))).not.toBe(base);
    expect(classicDom(tree('<div><div><p>a</p><p>b</p></div></div>'))).not.toBe(base);
    expect(classicDom(tree('<div><p class="x">a</p><p>b</p></div>'))).not.toBe(base);
    expect(classicDom(tree('<div><p>a</p><p>c</p></div>'))).not.toBe(base);
  });

  it('numbers React ids by first appearance, so a shifted id is no difference', () => {
    expect(classicDom(tree('<label for="«r4»">A</label><input id="«r4»">'))).toBe(
      classicDom(tree('<label for="«r9»">A</label><input id="«r9»">')),
    );
    expect(classicDom(tree('<p aria-labelledby=":r1:">a</p>'))).toBe(
      classicDom(tree('<p aria-labelledby=":r7:">a</p>')),
    );
  });

  it('sorts attributes and collapses whitespace', () => {
    expect(classicDom(tree('<a  href="/x"  class="b">one   two</a>'))).toBe(
      classicDom(tree('<a class="b" href="/x">one two</a>')),
    );
  });
});
