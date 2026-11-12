import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderDashboardWidgets } from './index';
import {
  GROW_ATTRIBUTE,
  GROW_IN_VIEW_RATIO,
  GROW_ROOM_SHARE,
  GROW_THRESHOLDS,
  GROW_WAIT,
  MOVEMENTS_CARD_SELECTOR,
  MovementsBreakdownGlassGrow,
} from './movements-breakdown-glass-grow';
import type { DashboardWidgetProps } from './types';

/**
 * THE TRIGGER OF THE MOVEMENTS CARD'S GROW-IN (Liquid Glass only). The sheet
 * (styles/liquid-glass/shell.css, its last block) grows the bars when the
 * card appears; this file's one job is to hold that start while the card is
 * outside the window and to release it, once, when about a third of the card
 * is inside. Held here:
 *   - it renders nothing: the card's HTML is the same with and without it;
 *   - Classic, the `off` rollout, "reduce motion" and a browser with no
 *     IntersectionObserver: nothing is observed and nothing is written;
 *   - a card on screen as it mounts (even partly) is left alone, so bars the
 *     server HTML already showed never vanish;
 *   - a card wholly outside the window waits, starts at a third, starts once,
 *     and nothing after that (a refresh of the data, a Day/Night switch,
 *     scrolling away and back) writes the attribute again;
 *   - where a third of the card cannot fit (a very short window, a short
 *     scrolling area around the card, a very tall card) it starts when the
 *     card fills half of the room there is, so the bars are never left at
 *     nothing in front of the reader;
 *   - leaving the page while it waits takes the attribute off.
 */

const WINDOW_HEIGHT = 768; // jsdom's window.innerHeight
const CARD_HEIGHT = 400;

class FakeObserver {
  static made: FakeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.made.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
  /** What the browser reports as the card crosses a threshold. */
  report(ratio: number, height = CARD_HEIGHT) {
    const entry = {
      isIntersecting: ratio > 0,
      intersectionRatio: ratio,
      intersectionRect: { height: ratio * height },
      boundingClientRect: { height },
      target: this.observed[0],
    } as unknown as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }
}

const PROPS = {
  barValues: Array.from({ length: 30 }, (_, i) => i + 1),
  breakdownRows: [
    { label: 'Receive PO', share: 0.6, val: 60 },
    { label: 'Sale', share: 0.4, val: 40 },
  ],
} as unknown as DashboardWidgetProps;

const widget = (props: DashboardWidgetProps = PROPS) => (
  <>{renderDashboardWidgets(['movements-breakdown'], props)}</>
);

/** Where the card is when the trigger mounts: its top edge, in window pixels. */
let cardTop = 1214;
let cardHeight = CARD_HEIGHT;
let reduceMotion = false;

function mount() {
  const view = render(widget());
  const card = view.container.querySelector(MOVEMENTS_CARD_SELECTOR)!;
  expect(card).not.toBeNull();
  return { ...view, card, observer: FakeObserver.made[0] };
}

beforeEach(() => {
  cardTop = 1214; // the real Overview at 1440 x 900: below the window
  cardHeight = CARD_HEIGHT;
  reduceMotion = false;
  FakeObserver.made = [];
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'opt-in');
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal('innerHeight', WINDOW_HEIGHT);
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion: reduce') ? reduceMotion : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const isCard = this.matches(MOVEMENTS_CARD_SELECTOR);
    const top = isCard ? cardTop : 0;
    const height = isCard ? cardHeight : 0;
    return {
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
    } as DOMRect;
  });
  document.documentElement.setAttribute('data-appearance', 'liquid-glass');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.documentElement.removeAttribute('data-appearance');
  document.documentElement.className = '';
});

describe("the Movements card's grow-in trigger", () => {
  it('renders nothing: the card is the same HTML with and without it, and the widget stays a Server Component', () => {
    expect(renderToStaticMarkup(<MovementsBreakdownGlassGrow />)).toBe('');
    const html = renderToStaticMarkup(widget());
    expect(html).not.toContain(GROW_ATTRIBUTE);
    expect(html).not.toMatch(/<script|<template|<!--/);
    const widgetSource = readFileSync(join(__dirname, 'movements-breakdown.tsx'), 'utf8');
    expect(widgetSource).not.toMatch(/['"]use client['"]/);
    expect(widgetSource.match(/<MovementsBreakdownGlassGrow \/>/g)).toHaveLength(1);
  });

  it('below the window in Liquid Glass: the card waits, and one observer watches the card at a third', () => {
    const { card, observer } = mount();
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    expect(FakeObserver.made).toHaveLength(1);
    expect(observer!.observed).toEqual([card]);
    expect(observer!.options).toEqual({ threshold: GROW_THRESHOLDS });
    // Every hundredth from nothing up to the third, so a short window hears about the card too.
    expect(GROW_THRESHOLDS).toHaveLength(34);
    expect(GROW_THRESHOLDS[0]).toBe(0);
    expect(GROW_THRESHOLDS[33]).toBe(GROW_IN_VIEW_RATIO);
    GROW_THRESHOLDS.forEach((t, i) => expect(t).toBeCloseTo(i / 100, 10));
    expect(GROW_IN_VIEW_RATIO).toBeGreaterThanOrEqual(0.3);
    expect(GROW_IN_VIEW_RATIO).toBeLessThanOrEqual(0.34);
    // Nothing else on the page carries the attribute.
    expect(document.querySelectorAll(`[${GROW_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it('starts when a third of the card is inside the window, not before', () => {
    const { card, observer } = mount();
    observer!.report(0); // still outside
    observer!.report(0.05); // its edge has come in
    observer!.report(0.3);
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    expect(observer!.disconnected).toBe(false);
    observer!.report(GROW_IN_VIEW_RATIO);
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    expect(observer!.disconnected).toBe(true);
  });

  it('starts once: a refresh of the data, a Day/Night switch and scrolling away and back never hold the bars again', () => {
    const { card, observer, rerender } = mount();
    observer!.report(0.5);
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);

    cardTop = 5000; // scrolled away
    rerender(widget({ ...PROPS, barValues: [9, 8, 7] } as DashboardWidgetProps)); // new data
    document.documentElement.classList.toggle('dark'); // Day/Night
    rerender(widget());
    observer!.report(0); // a late report from the dropped observer
    observer!.report(1);
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    expect(FakeObserver.made).toHaveLength(1);
    expect(document.querySelector(MOVEMENTS_CARD_SELECTOR)).toBe(card); // the same element throughout
  });

  it('a refresh of the data while it waits keeps it waiting, with the one observer', () => {
    const { card, rerender } = mount();
    rerender(widget({ ...PROPS, barValues: [9, 8, 7] } as DashboardWidgetProps));
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    expect(FakeObserver.made).toHaveLength(1);
  });

  it.each([
    ['wholly inside', 100],
    ['a third inside', WINDOW_HEIGHT - CARD_HEIGHT / 3],
    ['only its top edge inside', WINDOW_HEIGHT - 1],
    ['only its bottom edge inside', 1 - CARD_HEIGHT],
  ])('on screen as it mounts (%s): left alone, so the sheet grows it at once', (_, top) => {
    cardTop = top;
    const { card } = mount();
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    expect(FakeObserver.made).toHaveLength(0);
  });

  it.each([
    ['just below the window', WINDOW_HEIGHT],
    ['just above the window', -CARD_HEIGHT],
  ])('wholly outside as it mounts (%s): waits', (_, top) => {
    cardTop = top;
    const { card } = mount();
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
  });

  it('a window too short to show a third of the card: starts when the card fills half of it', () => {
    // The lab's finding: a 200 px window never showed the bars at all.
    vi.stubGlobal('innerHeight', 200);
    cardTop = 300;
    const { card, observer } = mount();
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    expect(GROW_ROOM_SHARE).toBe(0.5);
    observer!.report(0.01); // 4 px
    observer!.report(0.24); // 96 px: under half of 200
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    observer!.report(0.25); // 100 px: half the window, still under a third of the card
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    expect(observer!.disconnected).toBe(true);
  });

  it('a short scrolling area around the card counts as the room, not the window', () => {
    // The Overview scrolls inside `main`, which is shorter than the window.
    const scroller = document.createElement('main');
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'clientHeight', { value: 112 });
    document.body.appendChild(scroller);
    const view = render(widget(), { container: scroller });
    const card = view.container.querySelector(MOVEMENTS_CARD_SELECTOR)!;
    const observer = FakeObserver.made[0]!;
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    observer.report(0.13); // 52 px: under half of 112
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    observer.report(0.14); // 56 px: half of the scrolling area
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    view.unmount();
    scroller.remove();
  });

  it('a wrapper that does not clip is not the room', () => {
    const wrapper = document.createElement('div'); // overflow visible
    Object.defineProperty(wrapper, 'clientHeight', { value: 40 });
    document.body.appendChild(wrapper);
    const view = render(widget(), { container: wrapper });
    const card = view.container.querySelector(MOVEMENTS_CARD_SELECTOR)!;
    FakeObserver.made[0]!.report(0.3); // 120 px: far more than half of 40
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    view.unmount();
    wrapper.remove();
  });

  it('a card more than three windows tall starts when it fills half the window', () => {
    cardHeight = WINDOW_HEIGHT * 3 + 1;
    const { card, observer } = mount();
    observer!.report(0, cardHeight);
    observer!.report(0.01, cardHeight); // 23 px
    observer!.report(0.16, cardHeight); // 369 px: under half of 768
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    observer!.report(0.17, cardHeight); // 392 px
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
  });

  it('Classic: nothing is observed and nothing is written, with the build offering Liquid Glass', () => {
    for (const attribute of [null, 'classic']) {
      if (attribute) document.documentElement.setAttribute('data-appearance', attribute);
      else document.documentElement.removeAttribute('data-appearance');
      const { container, unmount } = mount();
      expect(FakeObserver.made).toHaveLength(0);
      expect(container.querySelectorAll(`[${GROW_ATTRIBUTE}]`)).toHaveLength(0);
      unmount();
    }
    expect(Element.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('the `off` rollout: nothing, even on a document that carries the glass attribute', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const { card } = mount();
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    expect(FakeObserver.made).toHaveLength(0);
  });

  it('reduce motion: nothing is held, so the bars are at full size from the first paint', () => {
    reduceMotion = true;
    const { card } = mount();
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    expect(FakeObserver.made).toHaveLength(0);
  });

  it('a browser with no IntersectionObserver: nothing is held', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { card } = mount();
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
  });

  it('a browser that refuses the observer: nothing is held and the page does not break', () => {
    class RefusingObserver {
      constructor() {
        throw new Error('observer refused');
      }
    }
    vi.stubGlobal('IntersectionObserver', RefusingObserver);
    let card: Element | undefined;
    expect(() => {
      card = mount().card;
    }).not.toThrow();
    expect(card!.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
  });

  it('an observer that cannot watch the card: nothing is held, the observer is dropped, the page does not break', () => {
    class DeafObserver extends FakeObserver {
      override observe(): void {
        throw new Error('cannot observe');
      }
    }
    vi.stubGlobal('IntersectionObserver', DeafObserver);
    let card: Element | undefined;
    expect(() => {
      card = mount().card;
    }).not.toThrow();
    expect(card!.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    expect(FakeObserver.made).toHaveLength(1);
    expect(FakeObserver.made[0]!.disconnected).toBe(true);
  });

  it('leaving the page while it waits takes the attribute off and drops the observer', () => {
    const { card, observer, unmount } = mount();
    expect(card.getAttribute(GROW_ATTRIBUTE)).toBe(GROW_WAIT);
    unmount();
    expect(card.hasAttribute(GROW_ATTRIBUTE)).toBe(false);
    expect(observer!.disconnected).toBe(true);
  });

  it('with no card on the page it does nothing and does not throw', () => {
    render(<MovementsBreakdownGlassGrow />);
    expect(FakeObserver.made).toHaveLength(0);
    expect(document.querySelectorAll(`[${GROW_ATTRIBUTE}]`)).toHaveLength(0);
  });

  it('reads the Design only through the appearance modules, in an effect', () => {
    const source = readFileSync(join(__dirname, 'movements-breakdown-glass-grow.tsx'), 'utf8');
    expect(source).toMatch(/^'use client';/);
    expect(source).toContain("from '@/components/theme/appearance-cookie'");
    expect(source).toContain("from '@/components/theme/appearance-flag'");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/data-appearance|useAppearance|sp_style|useState|setState/);
    expect(code).toMatch(/return null;/);
  });
});
